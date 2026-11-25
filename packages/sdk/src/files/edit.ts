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
//   3. the media type: the caller's (normalized), or else the base revision's, read at the same basis;
//   4. the content: inline in the revision when it fits one record body and declares no media type, otherwise
//      canonical chunks (efs/chunking/1) under a files-content/1 descriptor, or a files-external/1 locator; a
//      descriptor carries the media type. The records are split into publications under the per-transaction gas cap,
//      the finish (descriptor, revision, HEAD bind) kept in one publication.
// The result is always a list of parts for writer.runSequence, one part in the common case.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { SequencePartInput } from "../actions/sequence.js";
import { type GasModel, type PlannedAction, splitPublications } from "../actions/split.js";
import type { EffectView } from "../actions/types.js";
import { callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { encode, FORM } from "../content/codec.js";
import { type CallOpts, EfsFault, type Reason, reason } from "../core/errors.js";
import {
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
import {
  type Ctx,
  type FileRef,
  headUnderLens,
  type RevisionRef,
  resolveRevision,
} from "./bytes.js";
import {
  askedMediaType,
  blank,
  buildContent,
  checkContent,
  type ExternalContent,
  type FilesTypes,
  gasSetup,
  publish,
  tooManyBytes,
} from "./plan.js";

export type { ExternalContent } from "./plan.js";

export interface EditFileInput {
  file: FileRef;
  /** The revision the person was editing (OpenedFile.revision). It becomes the new revision's parent. */
  base: RevisionRef;
  content: Uint8Array | ExternalContent;
  /** The Lens the person edited in, for the base check. Default: the client's default Lens. */
  lens?: Lens;
  /**
   * The media type to declare, e.g. "image/png" or "text/html; charset=utf-8". The type and subtype are lowercased and
   * the parameters kept as given; a string the chain would refuse throws MISUSE before anything is read, so it is
   * never a revert. Omitted: keep the base revision's (read at the planning block). "": declare none (unknown).
   *
   * Only a descriptor carries a media type, so content small enough to sit inline is stored as one chunk under a
   * files-content/1 descriptor when it declares one (layout "chunk": more records and gas, shown in the review). Pass
   * "" to keep a small file inline, with no media type.
   */
  mediaType?: string;
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
  /** The media type the new revision declares ("" = none: always for inline layout). */
  mediaType: string;
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
  | {
      kind: "efs.editPlan";
      status: "BASE_CHANGED";
      head: RevisionRef | null;
      /**
       * With a head: whose it is, and the admission that last set it. Compare `headAdmission` with the `admissions`
       * of the basis the edit began from (OpenResult.basis): at or below it, that head was already there (for example
       * your own version, now first because you connected); above it, someone saved after you opened the file.
       */
      headAuthor?: PrincipalId;
      headAdmission?: bigint;
      basis: Basis;
    }
  | { kind: "efs.editPlan"; status: "TOO_LARGE"; reason: Reason }
  /** The chain could not be read (or answered something this SDK does not accept): nothing was decided. */
  | { kind: "efs.editPlan"; status: "UNKNOWN"; reason: Reason; basis?: Basis };

/** files-child/1 header: abi.encode(parent, file, form). */
const CHILD_HEADER_BYTES = 96;

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
  // A media type the chain would refuse is the caller's mistake: refuse it before anything else is looked up.
  const asked = askedMediaType(input.mediaType);
  const me = lower(writer.principal) as PrincipalId;
  const lens = input.lens ?? efs.lens.default;
  const g = gasSetup(d, o);
  if (!g.ok) return { kind: "efs.editPlan", status: "UNKNOWN", reason: g.reason };
  const gas = g.gas;
  const model = gas.model;
  const content = input.content;
  checkContent(content);

  const maxParts = o.maxParts ?? 64;
  const huge = tooManyBytes(content, maxParts, d.limits.maxBodyBytesPerPublication);
  if (huge) return { kind: "efs.editPlan", status: "TOO_LARGE", reason: huge };

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
    | { kind: "changed"; head: RevisionRef | null; author?: PrincipalId; admission?: bigint }
    | { kind: "refused"; reason: Reason }
    | {
        kind: "ok";
        lensAuthor: PrincipalId;
        myRevision: bigint;
        myState: string;
        mediaType: string;
      };
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
            author: h.author,
            admission: h.admission,
          },
        };
      // Keep the base's media type unless the caller named one: read it here, at this basis, never guessed.
      let mediaType = asked;
      if (mediaType === undefined) {
        const b = await resolveRevision(ctx, s, basis, base, file, h.author);
        if (!b.ok) return b;
        if (b.value.status !== "PRESENT")
          return {
            ok: true,
            value: {
              kind: "refused",
              reason:
                b.value.reason ??
                reason(
                  "NOT_YET_DECIDABLE",
                  "transient",
                  `the base revision reads ${b.value.status}`,
                ),
            },
          };
        mediaType = b.value.file.mediaType ?? "";
      }
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
        value: {
          kind: "ok",
          lensAuthor: h.author,
          myRevision: revisionNow,
          myState: cs,
          mediaType,
        },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.editPlan", status: "UNKNOWN", reason: r.reason, basis };
  const seen = r.value;
  if (seen.kind === "changed")
    return {
      kind: "efs.editPlan",
      status: "BASE_CHANGED",
      head: seen.head,
      ...(seen.author !== undefined ? { headAuthor: seen.author } : {}),
      ...(seen.admission !== undefined ? { headAdmission: seen.admission } : {}),
      basis,
    };
  if (seen.kind === "refused")
    return { kind: "efs.editPlan", status: "UNKNOWN", reason: seen.reason, basis };

  // ---- the content records (pure: no chain reads; the media type decides whether a small file can sit inline)
  const mediaType = seen.mediaType;
  const built = buildContent(
    types as FilesTypes,
    content,
    mediaType,
    d.limits.maxBodyBytes,
    CHILD_HEADER_BYTES,
  );
  if (!built.ok) return { kind: "efs.editPlan", status: "TOO_LARGE", reason: built.reason };
  const { records, descriptor, layout, size, sha256: digest } = built;
  const childBody = descriptor
    ? encode.childContent(base, file, descriptor.id)
    : encode.childInline(base, file, built.inline as Uint8Array);
  const revision = recordId(types.child as Hex, childBody) as RecordId;

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
    mediaType, // "" whenever the layout is inline
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
      ...(r.mediaType ? { mediaType: r.mediaType } : {}),
      part: String(i + 1),
      parts: String(n),
      stage: finish ? "finish" : "content",
    },
    text: finish
      ? `Save the edit to ${r.file} (${r.size} bytes)`
      : `Store part ${i + 1} of ${n} of the edit's content`,
  };
}
