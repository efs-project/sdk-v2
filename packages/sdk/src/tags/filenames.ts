// SPDX-License-Identifier: MIT
// The name of a file shown in a topic (the tag model spec §3.7). A tag has no name, so the name comes from where the
// file is placed: its FOLDER entries, found through the "what points at this" list Keys.backlinkList(FOLDER, file).
// In order: the name its tagger gave it in their own home or folders; the name its creator gave it; the first name
// from the Lens; else none (the client shows its media type and a short id). No chain reader serves a thing's backlink
// entries, so this reads them: the newest `scan` entries of the list (at most 16), each one's admission row and
// publication (its author), its position (the parent and the name's hash), the author's current head there (an
// entry counts only while that author still binds this file there: the backlink list is append-only), and the name
// record's body (its hash must be the role). Every check failing is the endpoint's fault (UNKNOWN), never "no name".
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session } from "../chain/pool.js";
import type { RpcOutcome } from "../chain/rpc.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import {
  type Address,
  type Hex,
  hexToBytes,
  lower,
  type PrincipalId,
  type RecordId,
  uniquePrincipals,
} from "../core/hex.js";
import type { Ctx, Evidence } from "../files/bytes.js";
import {
  decodeCreator,
  decodeParent,
  type ParentRef,
  parentCall,
  subjectInfoCall,
} from "../files/folders.js";
import { indexAbi, ledgerAbi, ledgerReadsAbi, ledgerViewsAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { checkName, decodeScalars } from "../names/name.js";
import { recordFromHash } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import { badReply, callOf, decoded } from "./plan.js";

const MAX_FILES = 32;
const MAX_SCAN = 16;
/** The most calls sent in one JSON-RPC batch (providers cap batch sizes). */
const BATCH = 100;

export interface FileNameInput {
  /** The file (its subject id). */
  file: Hex;
  /** Who filed it in the topic (the row's decider), when one author did: their own name for it comes first. */
  tagger?: PrincipalId;
}
export interface FileNamesOpts extends CallOpts {
  /** The Lens for the third choice (default: the client's default Lens). */
  lens?: Lens;
  /** The newest backlink entries read per file, 1 to 16 (default 16). */
  scan?: number;
}
export interface FileName {
  text: string;
  author: PrincipalId;
  /** Where the entry is: a folder or a home. */
  folder: ParentRef;
  /** Which rule chose it (spec §3.7): the tagger's own, the creator's, or the first Lens author's. */
  why: "tagger" | "creator" | "lens";
}
export interface FileNameRow {
  file: Hex;
  /** null: no entry by the tagger, the creator or anyone in the Lens names it (in what was read: see `complete`). */
  name: FileName | null;
  /** The file's creator, when it is a created subject. */
  creator: PrincipalId | null;
  /** Every entry of the list was read and the index vouches for it. False: a null `name` is not proven absent. */
  complete: boolean;
}
export type FileNamesResult =
  | {
      kind: "efs.fileNames";
      status: "PRESENT";
      rows: readonly FileNameRow[];
      basis: Basis;
      evidence: Evidence;
    }
  | { kind: "efs.fileNames"; status: "UNKNOWN"; reason: Reason; basis?: Basis; evidence: Evidence };

type Entry = {
  file: number;
  ordinal: bigint;
  publication?: bigint;
  bindingOrdinal?: bigint;
  author?: PrincipalId;
  position?: Hex;
  parent?: Hex;
  role?: Hex;
  current?: boolean;
};

/** @internal callsAt, BATCH calls at a time (providers cap batch sizes). */
export async function callsIn(
  s: Session,
  blockHash: Hex,
  calls: readonly CallRequest[],
): Promise<RpcOutcome[]> {
  const out: RpcOutcome[] = [];
  for (let i = 0; i < calls.length; i += BATCH)
    out.push(...(await callsAt(s, blockHash, calls.slice(i, i + BATCH))));
  return out;
}
const isHome = (word: Hex): boolean => /^0x0{24}/.test(word) && !/^0x0{64}$/.test(word);
const parentRef = (word: Hex): ParentRef =>
  isHome(word)
    ? { kind: "home", address: `0x${word.slice(26)}` as Address }
    : { kind: "folder", directory: word as RecordId };

/**
 * Names for files shown in a topic, by the spec §3.7 order, at one block: for each file, its tagger's own entry in their
 * home or a folder they created, else its creator's entry, else the first Lens author's, else null. Newest entry first
 * within one author. At most 32 files a call.
 */
export async function fileNames(
  efs: Efs,
  files: readonly FileNameInput[],
  o: FileNamesOpts = {},
): Promise<FileNamesResult> {
  if (!files.length) throw misuse("fileNames needs at least one file");
  if (files.length > MAX_FILES) throw misuse(`at most ${MAX_FILES} files a call`);
  for (const f of files)
    if (!/^0x[0-9a-fA-F]{64}$/.test(f.file ?? "")) throw misuse("a file is its 32-byte subject id");
  const scan = o.scan ?? MAX_SCAN;
  if (!Number.isInteger(scan) || scan < 1 || scan > MAX_SCAN)
    throw misuse(`scan is 1 to ${MAX_SCAN}`);
  const principals = uniquePrincipals((o.lens ?? efs.lens.default).principals);
  const d = efs.deployment;
  const family = d.index.backlinkFamily;
  const none: Evidence = { attempts: [], requests: 0 };
  if (!family || !d.index.address)
    return {
      kind: "efs.fileNames",
      status: "UNKNOWN",
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        "the deployment names no backlink list to read",
      ),
      evidence: none,
    };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.fileNames",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const ids = files.map((f) => lower(f.file));
  const nameType = d.typeIds["files-name/2"] as Hex;
  const r = await onEndpoint<FileNameRow[]>(
    efs._internal.pool,
    async (s) => {
      const at = basis.blockHash;
      // 1. The live index must be the deployment's (its family ids are that generation's); each list's head; each
      //    file's creator.
      const calls1: CallRequest[] = [
        { to: d.ledger, data: encodeFunctionData({ abi: ledgerAbi, functionName: "index" }) },
        ...ids.map((f) =>
          callOf(d.index.address as Hex, indexAbi, "postingHeadOf", [
            family,
            PURPOSES.folder,
            0,
            f,
          ]),
        ),
        ...ids.map((f) => subjectInfoCall(efs, f)),
      ];
      ctx.requests += calls1.length;
      const out1 = await callsIn(s, at, calls1);
      const ix = out1[0];
      if (!ix?.ok)
        return { ok: false, retryElsewhere: true, reason: (ix as { reason: Reason }).reason };
      let live: Hex;
      try {
        live = decodeFunctionResult({
          abi: ledgerAbi,
          functionName: "index",
          data: ix.result as Hex,
        }) as Hex;
      } catch {
        return badReply("index");
      }
      if (lower(live) !== d.index.address)
        return {
          ok: false,
          retryElsewhere: false,
          reason: reason(
            "UNSUPPORTED_PROFILE",
            "never",
            "the live index is not the one the deployment names",
          ),
        };
      const heads: { coverage: number; count: bigint }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const h = decoded<[number, bigint, bigint, bigint, boolean]>(
          indexAbi,
          "postingHeadOf",
          out1[1 + i],
        );
        if (!h.ok) return h;
        heads.push({ coverage: Number(h.value[0]), count: BigInt(h.value[1]) });
      }
      const creators: (PrincipalId | null)[] = [];
      for (let i = 0; i < ids.length; i++) {
        const c = decodeCreator(out1[1 + ids.length + i]);
        if (!c.ok) return c;
        creators.push(c.value);
      }
      // 2. The newest `scan` entries of each list.
      const slices = heads.map((h) => {
        const n = h.count < BigInt(scan) ? h.count : BigInt(scan);
        return { from: h.count - n, n: Number(n) };
      });
      const calls2 = ids.map((f, i) =>
        callOf(d.index.address as Hex, indexAbi, "postingSliceOf", [
          family,
          PURPOSES.folder,
          0,
          f,
          (slices[i] as { from: bigint }).from,
          (slices[i] as { n: number }).n,
        ]),
      );
      ctx.requests += calls2.length;
      const out2 = await callsIn(s, at, calls2);
      const entries: Entry[] = [];
      const covered: boolean[] = [];
      for (let i = 0; i < ids.length; i++) {
        const sl = decoded<[number, readonly bigint[], boolean]>(
          indexAbi,
          "postingSliceOf",
          out2[i],
        );
        if (!sl.ok) return sl;
        if (sl.value[1].length !== (slices[i] as { n: number }).n)
          return badReply("postingSliceOf (length)");
        covered.push(
          Number(sl.value[0]) === 3 && (heads[i] as { coverage: number }).coverage === 3,
        ); // COMPLETE
        // Newest first.
        for (const ord of [...sl.value[1]].reverse())
          entries.push({ file: i, ordinal: BigInt(ord) });
      }
      // 3. Each entry's admission row (its publication and binding).
      const out3 = await callsIn(
        s,
        at,
        entries.map((e) =>
          callOf(d.readers.ledgerReads, ledgerReadsAbi, "admission", [d.ledger, e.ordinal]),
        ),
      );
      ctx.requests += entries.length;
      for (const [k, e] of entries.entries()) {
        const a = decoded<[number, { publication: bigint; bindingOrdinal: bigint }]>(
          ledgerReadsAbi,
          "admission",
          out3[k],
        );
        if (!a.ok) return a;
        if (chainStatus(a.value[0]) !== "PRESENT")
          return badReply("admission (a listed entry has no row)");
        e.publication = BigInt(a.value[1].publication);
        e.bindingOrdinal = BigInt(a.value[1].bindingOrdinal);
      }
      // 4. Its author (the publication's principal) and its position.
      const calls4 = entries.flatMap((e) => [
        callOf(d.readers.ledgerReads, ledgerReadsAbi, "evidence", [d.ledger, e.publication]),
        callOf(d.readers.ledgerReads, ledgerReadsAbi, "bindingPosition", [
          d.ledger,
          e.bindingOrdinal,
        ]),
      ]);
      ctx.requests += calls4.length;
      const out4 = await callsIn(s, at, calls4);
      for (const [k, e] of entries.entries()) {
        const ev = decoded<[number, { principalId: Hex }]>(ledgerReadsAbi, "evidence", out4[2 * k]);
        if (!ev.ok) return ev;
        const bp = decoded<[number, Hex]>(ledgerReadsAbi, "bindingPosition", out4[2 * k + 1]);
        if (!bp.ok) return bp;
        if (chainStatus(ev.value[0]) !== "PRESENT" || chainStatus(bp.value[0]) !== "PRESENT")
          return badReply("evidence / bindingPosition (a listed entry)");
        e.author = lower(ev.value[1].principalId) as PrincipalId;
        e.position = lower(bp.value[1]);
      }
      // 5. Each position's cell (it must be a FOLDER position), and the author's current head there.
      const calls5 = entries.flatMap((e) => [
        callOf(d.readers.ledgerReads, ledgerReadsAbi, "positionCell", [d.ledger, e.position]),
        callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [
          d.ledger,
          [e.author],
          e.position,
        ]),
      ]);
      ctx.requests += calls5.length;
      const out5 = await callsIn(s, at, calls5);
      for (const [k, e] of entries.entries()) {
        const cell = decoded<[number, Hex, Hex, Hex]>(ledgerReadsAbi, "positionCell", out5[2 * k]);
        if (!cell.ok) return cell;
        const [cst, purpose, parent, role] = cell.value;
        if (chainStatus(cst) !== "PRESENT" || lower(purpose) !== lower(PURPOSES.folder))
          return badReply("positionCell (a FOLDER backlink that is not a FOLDER position)");
        e.parent = lower(parent);
        e.role = lower(role);
        const h = decoded<[number, unknown, number, readonly { state: number; target: Hex }[]]>(
          ledgerViewsAbi,
          "headsAt",
          out5[2 * k + 1],
        );
        if (!h.ok) return h;
        const mine = h.value[3][0];
        if (!mine || h.value[3].length !== 1) return badReply("headsAt (one head)");
        // The list is append-only: an entry counts only while its author still binds this very file there.
        e.current = headState(Number(mine.state)) === "BOUND" && lower(mine.target) === ids[e.file];
      }
      // 6. The tagger's folders (their owner is the record's creator), then the chosen entries' names.
      const current = entries.filter((e) => e.current);
      const taggers = files.map((f) => (f.tagger ? (lower(f.tagger) as PrincipalId) : null));
      const folderParents = [
        ...new Set(
          current
            .filter((e) => e.author === taggers[e.file] && !isHome(e.parent as Hex))
            .map((e) => e.parent as Hex),
        ),
      ];
      const calls6 = folderParents.map((p) =>
        parentCall(efs, { kind: "folder", directory: p as RecordId }),
      );
      ctx.requests += calls6.length;
      const out6 = await callsIn(s, at, calls6);
      const owners = new Map<Hex, PrincipalId | null>();
      for (const [k, p] of folderParents.entries()) {
        const pr = decodeParent(efs, { kind: "folder", directory: p as RecordId }, out6[k]);
        if (!pr.ok) return pr;
        owners.set(p, pr.value.status === "PRESENT" ? pr.value.owner : null);
      }
      const ownParent = (e: Entry, who: PrincipalId): boolean =>
        isHome(e.parent as Hex) ? e.parent === who : owners.get(e.parent as Hex) === who;
      const chosen: ({ e: Entry; why: FileName["why"] } | null)[] = files.map((_, i) => {
        const mineFirst = current.filter((e) => e.file === i); // newest first already
        const tagger = taggers[i];
        if (tagger) {
          const t = mineFirst.find((e) => e.author === tagger && ownParent(e, tagger));
          if (t) return { e: t, why: "tagger" };
        }
        const creator = creators[i];
        if (creator) {
          const c = mineFirst.find((e) => e.author === creator);
          if (c) return { e: c, why: "creator" };
        }
        for (const p of principals) {
          const l = mineFirst.find((e) => e.author === p);
          if (l) return { e: l, why: "lens" };
        }
        return null;
      });
      const roles = [...new Set(chosen.filter((c) => c !== null).map((c) => c.e.role as Hex))];
      const calls7 = roles.map((role) =>
        callOf(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [
          d.ledger,
          recordFromHash(nameType, role),
          0,
          256,
        ]),
      );
      ctx.requests += calls7.length;
      const out7 = await callsIn(s, at, calls7);
      const names = new Map<Hex, string>();
      for (const [k, role] of roles.entries()) {
        const b = decoded<[number, Hex]>(ledgerReadsAbi, "bodySlice", out7[k]);
        if (!b.ok) return b;
        const bytes = hexToBytes(b.value[1]);
        const c = checkName(bytes);
        // A bound FOLDER entry has its name record (validator code 1): its body must hash to the role.
        if (
          chainStatus(b.value[0]) !== "PRESENT" ||
          c.status !== "VALID" ||
          lower(keccakOf(bytes)) !== role
        )
          return badReply("a name record (body or hash)");
        names.set(role, decodeScalars(bytes)?.text ?? "");
      }
      return {
        ok: true,
        value: files.map((_, i) => {
          const c = chosen[i];
          return {
            file: ids[i] as Hex,
            name: c
              ? {
                  text: names.get(c.e.role as Hex) as string,
                  author: c.e.author as PrincipalId,
                  folder: parentRef(c.e.parent as Hex),
                  why: c.why,
                }
              : null,
            creator: creators[i] ?? null,
            complete:
              (covered[i] as boolean) && (heads[i] as { count: bigint }).count <= BigInt(scan),
          };
        }),
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { kind: "efs.fileNames", status: "UNKNOWN", reason: r.reason, basis, evidence };
  return { kind: "efs.fileNames", status: "PRESENT", rows: r.value, basis, evidence };
}

const keccakOf = (b: Uint8Array): Hex => keccak256(b) as Hex;
