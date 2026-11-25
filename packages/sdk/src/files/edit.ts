// SPDX-License-Identifier: MIT
// Edit a file's content (contracts src/lib/EfsFiles.sol `edit` / `editRef`): a files-child/1 revision whose parent is
// the revision the person edited, and BIND(HEAD, file, 0 → child) with a compare-and-swap on the editor's own HEAD
// binding. Only a file and its HEAD are touched: no name, folder or path, so nothing here waits on the
// tags-vs-directories ruling.
//
// Planning reads the chain at one basis and never touches the wallet:
//   1. the base check: the file's HEAD under the Lens must still be `base`, or the result is BASE_CHANGED (a save
//      never silently overwrites a revision the person did not see);
//   2. the editor's own HEAD binding, whose revision the bind carries as expectedRevision: if another save by the
//      same account lands first, the ledger refuses this one (E_CAS) and it is planned again;
//   3. the content: inline in the revision when it fits one record body, otherwise canonical chunks (efs/chunking/1)
//      under a files-content/1 descriptor, or a files-external/1 locator. The records are split into publications
//      under the per-transaction gas cap, the finish (descriptor, revision, HEAD bind) kept in one publication.
// The result is always a list of parts for writer.runSequence, one part in the common case.
import { decodeFunctionResult, encodeFunctionData, keccak256, sha256 } from "viem";
import type { SequencePartInput } from "../actions/sequence.js";
import {
  type GasModel,
  gasPlanFor,
  type PlannedAction,
  splitPublications,
  txGasCapOf,
} from "../actions/split.js";
import type { ActionData, EffectView } from "../actions/types.js";
import { callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { CARRIER, CHUNK_PAYLOAD, chunkTree, encode, FORM } from "../content/codec.js";
import { type CallOpts, EfsFault, type Reason, reason } from "../core/errors.js";
import {
  bytesToHex,
  type Hex,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
  ZERO_WORD,
} from "../core/hex.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import { ACTION, PURPOSES } from "../generated/constants.js";
import { bindingKey, positionKey, recordId } from "../protocol/keys.js";
import { chainStatus } from "../protocol/status.js";
import { type Ctx, type FileRef, headUnderLens, type RevisionRef } from "./bytes.js";

/** Content stored elsewhere: the revision names a files-external/1 locator and its sha256. */
export interface ExternalContent {
  kind: "external";
  length: bigint;
  sha256: Hex;
  /** Printable ASCII, e.g. "ipfs://…", "ar://…", "https://…", "web3://…". */
  locator: string;
}

export interface EditFileInput {
  file: FileRef;
  /** The revision the person was editing (OpenedFile.revision). It becomes the new revision's parent. */
  base: RevisionRef;
  content: Uint8Array | ExternalContent;
  /** The Lens the person edited in, for the base check. Default: the client's default Lens. */
  lens?: Lens;
  /** files-content/1 media code (0 = unspecified). */
  media?: bigint;
}

export interface EditFileOpts extends CallOpts {
  /**
   * The gas model to split with. Default: the contracts' fitted model for this deployment's fee schedule
   * (gasPlanFor: release.json gasModel by efs-deployment.chain.feeSchedule). Without either, planning is UNKNOWN.
   */
  gasModel?: GasModel;
  /** The per-transaction gas cap (EIP-7825). Default: the deployment's chain.txGasCap (2^24). */
  txGasCap?: bigint;
  /** Plan each part to txGasCap × (1 − headroom). Default: the contracts' 15%. */
  headroom?: number;
  /** Refuse (TOO_LARGE) rather than plan more parts than this. Default 64 (about 0.5 MB on chain). */
  maxParts?: number;
  /** Each part's deadline, in seconds from the block it is planned at (default 15 minutes). */
  deadlineSeconds?: number;
}

export type EditLayout = "inline" | "chunk" | "span" | "external";

/** What the review dialog shows. Each part's `files.edit` effect carries the same facts, for a resumed save. */
export interface EditReview {
  kind: "efs.editReview";
  file: SubjectId;
  base: RecordId;
  /** The new revision's record id (files-child/1). */
  revision: RecordId;
  /** The principal the edit is made by: the writer's. Readers see it through any Lens that includes this principal. */
  author: PrincipalId;
  size: bigint;
  sha256: Hex;
  layout: EditLayout;
  parts: number;
  /** One approval per part, or one in all with an atomic EIP-5792 wallet. */
  prompts: { sequential: number; atomicBatch: 1 };
  /** The model's estimate per part (planning only; eth_estimateGas decides before each send). */
  gas: { perPart: readonly number[]; schedule: string };
  /** New records the save publishes (chunks, spans, descriptor, revision). */
  records: number;
  /** The HEAD bind's expectedRevision: the editor's binding revision now (0: their first HEAD on this file). */
  expectedRevision: bigint;
  /**
   * own-head: `base` is the editor's own HEAD, so the ledger itself refuses the save if it moved (E_CAS).
   * lens: `base` is another author's revision; only the planning-time base check covers it.
   */
  guard: "own-head" | "lens";
  /**
   * Whether the edited Lens will show this edit once it lands. False when the Lens leaves the author out, or puts an
   * author who already bound this file's HEAD before them: the save still succeeds, but that view keeps showing the
   * other revision (efs.lens.mineFirst(account) puts the author first).
   */
  visibleInLens: boolean;
}

export type EditPlanResult =
  | {
      kind: "efs.editPlan";
      status: "PLANNED";
      parts: SequencePartInput[];
      review: EditReview;
      basis: Basis;
    }
  /** HEAD under the Lens is no longer `base`. `head` is what it is now; null when the file has no HEAD there. */
  | { kind: "efs.editPlan"; status: "BASE_CHANGED"; head: RevisionRef | null; basis: Basis }
  | { kind: "efs.editPlan"; status: "TOO_LARGE"; reason: Reason }
  /** The chain could not be read (or answered something this SDK does not accept): nothing was decided. */
  | { kind: "efs.editPlan"; status: "UNKNOWN"; reason: Reason; basis?: Basis };

/** files-child/1 header: abi.encode(parent, file, form). */
const CHILD_HEADER_BYTES = 96;

const blank: ActionData = {
  kind: 0,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  salt: ZERO_WORD,
};
const publish = (typeId: Hex, body: Uint8Array, shape: string, group?: number): PlannedAction => ({
  action: { ...blank, kind: ACTION.PUBLISH, typeId, bodyHashOrRecordId: keccak256(body) },
  body: bytesToHex(body),
  shape,
  ...(group !== undefined ? { group } : {}),
});

const printableAscii = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);
const FINISH = 1;

/**
 * Plan an edit of `file` from `base` to `content`, for writer.runSequence. Reads the chain at one basis; never asks
 * the wallet anything (only `writer.principal` is used).
 */
export async function planEditFile(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: EditFileInput,
  o: EditFileOpts = {},
): Promise<EditPlanResult> {
  const d = efs.deployment;
  const t = d.typeIds as Record<string, Hex | undefined>;
  const types = {
    child: t["files-child/1"],
    content: t["files-content/1"],
    bytes: t["files-bytes/1"],
    span: t["files-span/1"],
    external: t["files-external/1"],
  };
  for (const [k, v] of Object.entries(types))
    if (!v) throw new EfsFault("MISUSE", `this deployment has no files ${k} Type`);
  const file = lower(input.file.subject) as SubjectId;
  const base = lower(input.base.recordId) as RecordId;
  if (input.base.file && lower(input.base.file) !== file)
    throw new EfsFault("MISUSE", "base is a revision of another file");
  const me = lower(writer.principal) as PrincipalId;
  const lens = input.lens ?? efs.lens.default;
  let gas: { model: GasModel; txGasCap: bigint; headroom: number; blockGasLimit?: bigint };
  if (o.gasModel)
    gas = {
      model: o.gasModel,
      txGasCap: o.txGasCap ?? txGasCapOf(d),
      headroom: o.headroom ?? 0.15,
    };
  else {
    const g = gasPlanFor(d);
    if (!g.ok) return { kind: "efs.editPlan", status: "UNKNOWN", reason: g.reason };
    gas = {
      model: g.model,
      txGasCap: o.txGasCap ?? g.txGasCap,
      headroom: o.headroom ?? g.headroom,
      ...(g.blockGasLimit !== undefined ? { blockGasLimit: g.blockGasLimit } : {}),
    };
  }
  const model = gas.model;
  const content = input.content;
  if (!(content instanceof Uint8Array)) {
    if (!printableAscii(content.locator))
      throw new EfsFault("MISUSE", "an external locator must be printable ASCII");
    if (!/^0x[0-9a-fA-F]{64}$/.test(content.sha256))
      throw new EfsFault("MISUSE", "sha256 must be 32 bytes of hex");
    if (content.length < 0n || content.length >= 1n << 256n)
      throw new EfsFault("MISUSE", "length must be a uint256");
  }

  const maxParts = o.maxParts ?? 64;
  // Refuse before chunking anything: no publication carries more than maxBodyBytesPerPublication body bytes.
  if (
    content instanceof Uint8Array &&
    content.length > maxParts * d.limits.maxBodyBytesPerPublication
  )
    return {
      kind: "efs.editPlan",
      status: "TOO_LARGE",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${content.length} bytes need more than ${maxParts} publications (store large files externally)`,
      ),
    };

  // ---- the content records (pure: no chain reads)
  const records: PlannedAction[] = [];
  let descriptor: { body: Uint8Array; typeId: Hex; shape: string } | undefined;
  let layout: EditLayout;
  let size: bigint;
  let digest: Hex;
  let childBody: Uint8Array;
  if (content instanceof Uint8Array) {
    size = BigInt(content.length);
    digest = sha256(content);
    if (content.length <= d.limits.maxBodyBytes - CHILD_HEADER_BYTES) {
      layout = "inline";
      childBody = encode.childInline(base, file, content);
    } else {
      const tree = chunkTree(types.bytes as Hex, types.span as Hex, content, CHUNK_PAYLOAD);
      layout = tree.isSpan ? "span" : "chunk";
      const seen = new Set<Hex>();
      for (const r of tree.records) {
        if (seen.has(r.id)) continue; // a repeated chunk or subtree: the first occurrence already published it
        seen.add(r.id);
        records.push(
          publish(r.typeId, r.body, r.typeId === types.span ? "files-span/1" : "files-bytes/1"),
        );
      }
      const body = encode.content(
        tree.root,
        tree.isSpan ? CARRIER.span : CARRIER.inlineChunk,
        size,
        digest,
        input.media ?? 0n,
      );
      descriptor = {
        body,
        typeId: types.content as Hex,
        shape: `files-content/1 carrier ${tree.isSpan ? CARRIER.span : CARRIER.inlineChunk}`,
      };
      childBody = encode.childContent(base, file, recordId(types.content as Hex, body));
    }
  } else {
    layout = "external";
    size = content.length;
    digest = lower(content.sha256);
    const sentinelBody = encode.chunk(new Uint8Array());
    const sentinel = recordId(types.bytes as Hex, sentinelBody);
    records.push(publish(types.bytes as Hex, sentinelBody, "files-bytes/1"));
    const body = encode.external(sentinel, content.length, digest, content.locator);
    if (body.length > d.limits.maxBodyBytes)
      return {
        kind: "efs.editPlan",
        status: "TOO_LARGE",
        reason: reason(
          "LIMIT_EXCEEDED",
          "never",
          `the locator makes a ${body.length}-byte record; the limit is ${d.limits.maxBodyBytes}`,
        ),
      };
    descriptor = { body, typeId: types.external as Hex, shape: "files-external/1" };
    childBody = encode.childContent(base, file, recordId(types.external as Hex, body));
  }
  const revision = recordId(types.child as Hex, childBody) as RecordId;

  // ---- one basis: the Lens's HEAD (the base check) and the editor's own HEAD binding (the CAS revision)
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.editPlan",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const myBinding = bindingKey(me, positionKey(PURPOSES.head, file, ZERO_WORD));
  type Seen =
    | { kind: "changed"; head: RevisionRef | null }
    | { kind: "refused"; reason: Reason }
    | { kind: "ok"; lensAuthor: PrincipalId; myRevision: bigint; myState: string };
  const r = await onEndpoint<Seen>(
    efs._internal.pool,
    async (s) => {
      const sel = await headUnderLens(ctx, s, basis, lens, file);
      if (!sel.ok) return sel;
      const h = sel.value;
      if (h.status === "ABSENT_PROVEN" || h.status === "MASKED")
        return { ok: true, value: { kind: "changed", head: null } };
      if (h.status !== "PRESENT")
        return {
          ok: true,
          value: {
            kind: "refused",
            reason:
              ("reason" in h ? h.reason : undefined) ??
              reason("NOT_YET_DECIDABLE", "transient", "HEAD is UNKNOWN under this Lens"),
          },
        };
      if (h.target !== base)
        return {
          ok: true,
          value: {
            kind: "changed",
            head: { kind: "revision", recordId: h.target as RecordId, file },
          },
        };
      ctx.requests += 1;
      const [out] = await callsAt(s, basis.blockHash, [
        {
          to: d.readers.ledgerReads,
          data: encodeFunctionData({
            abi: ledgerReadsAbi,
            functionName: "head",
            args: [d.ledger, myBinding],
          }),
        },
      ]);
      if (!out?.ok)
        return {
          ok: false,
          retryElsewhere: true,
          reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
        };
      let status: number;
      let revisionNow: bigint;
      try {
        const [st, head] = decodeFunctionResult({
          abi: ledgerReadsAbi,
          functionName: "head",
          data: out.result as Hex,
        }) as unknown as [number, { revision: bigint }];
        status = st;
        revisionNow = BigInt(head.revision);
      } catch {
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", "head() did not decode"),
        };
      }
      const cs = chainStatus(status);
      // PRESENT (bound), ABSENT_PROVEN (never bound: revision 0), MASKED or RELEASED all name the binding's current
      // revision. UNKNOWN or a refusal does not: nothing is planned on a guessed revision.
      if (cs !== "PRESENT" && cs !== "ABSENT_PROVEN" && cs !== "MASKED" && cs !== "RELEASED")
        return {
          ok: true,
          value: {
            kind: "refused",
            reason: reason("RPC_ERROR", "transient", `the editor's HEAD binding reads ${cs}`),
          },
        };
      return {
        ok: true,
        value: { kind: "ok", lensAuthor: h.author, myRevision: revisionNow, myState: cs },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.editPlan", status: "UNKNOWN", reason: r.reason, basis };
  const seen = r.value;
  if (seen.kind === "changed")
    return { kind: "efs.editPlan", status: "BASE_CHANGED", head: seen.head, basis };
  if (seen.kind === "refused")
    return { kind: "efs.editPlan", status: "UNKNOWN", reason: seen.reason, basis };

  // ---- the finish (one publication): descriptor, revision, HEAD bind
  const finish: PlannedAction[] = [];
  if (descriptor)
    finish.push(publish(descriptor.typeId, descriptor.body, descriptor.shape, FINISH));
  finish.push(
    publish(
      types.child as Hex,
      childBody,
      `files-child/1 form ${descriptor ? FORM.content : FORM.inline}`,
      FINISH,
    ),
  );
  finish.push({
    action: {
      ...blank,
      kind: ACTION.BIND,
      purpose: PURPOSES.head,
      subject: file,
      role: ZERO_WORD,
      target: revision,
      expectedRevision: seen.myRevision,
    },
    body: "0x",
    group: FINISH,
    // a never-bound HEAD is a fresh bind, a bound one a rebind; a masked or released one is priced at the larger
    ...(seen.myState === "ABSENT_PROVEN"
      ? { bindRow: "bindHeadFresh" as const }
      : seen.myState === "PRESENT"
        ? { bindRow: "bindHeadRebind" as const }
        : {}),
  });
  const split = splitPublications([...records, ...finish], {
    model,
    limits: d.limits,
    txGasCap: gas.txGasCap,
    headroom: gas.headroom,
    ...(gas.blockGasLimit !== undefined ? { blockGasLimit: gas.blockGasLimit } : {}),
    // Priced as if this were the principal's first publication ever (the surcharge is ~0.1% of the cap): planning
    // does not read the nonce, and an under-estimate is the one error a split must not make.
    firstWrite: true,
  });
  if (!split.ok) return { kind: "efs.editPlan", status: "TOO_LARGE", reason: split.reason };
  if (split.parts.length > maxParts)
    return {
      kind: "efs.editPlan",
      status: "TOO_LARGE",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${split.parts.length} publications; the limit is ${maxParts} (store large files externally)`,
      ),
    };

  const authorIndex = lens.principals.findIndex((p) => lower(p) === me);
  const lensAuthorIndex = lens.principals.findIndex((p) => lower(p) === seen.lensAuthor);
  const ownHead = seen.lensAuthor === me;
  const review: EditReview = {
    kind: "efs.editReview",
    file,
    base,
    revision,
    author: me,
    size,
    sha256: digest,
    layout,
    parts: split.parts.length,
    prompts: { sequential: split.parts.length, atomicBatch: 1 },
    gas: { perPart: split.parts.map((p) => p.gas), schedule: model.schedule },
    records: records.length + finish.length - 1,
    expectedRevision: seen.myRevision,
    guard: ownHead ? "own-head" : "lens",
    visibleInLens: ownHead || (authorIndex >= 0 && authorIndex < lensAuthorIndex),
  };
  const n = split.parts.length;
  const parts = split.parts.map(
    (p, i): SequencePartInput => ({
      actions: p.actions.map((a) => a.action),
      bodies: p.actions.map((a) => a.body),
      effects: [
        editEffect(
          review,
          i,
          n,
          p.actions.some((a) => a.group === FINISH),
        ),
      ],
      ...(o.deadlineSeconds !== undefined ? { deadlineSeconds: o.deadlineSeconds } : {}),
    }),
  );
  return { kind: "efs.editPlan", status: "PLANNED", parts, review, basis };
}

/** `files.edit`: stage "content" stores bytes only; stage "finish" moves the file's HEAD (the edit appears). */
function editEffect(r: EditReview, i: number, n: number, finish: boolean): EffectView {
  return {
    code: "files.edit",
    args: {
      file: r.file,
      base: r.base,
      revision: r.revision,
      author: r.author,
      size: r.size.toString(),
      sha256: r.sha256,
      layout: r.layout,
      part: String(i + 1),
      parts: String(n),
      stage: finish ? "finish" : "content",
    },
    text: finish
      ? `Save the edit to ${r.file} (${r.size} bytes)`
      : `Store part ${i + 1} of ${n} of the edit's content`,
  };
}
