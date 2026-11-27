// SPDX-License-Identifier: MIT
// The name of a folder reached by its link (a breadcrumb's "Root > … > Guides"), the folder twin of tags' fileNames.
// A folder is a directory record; its names are the FOLDER entries pointing at it, found through the backlink list
// Keys.backlinkList(FOLDER, directory). In order (the tag model spec §3.7): the reader's own entry in their own home or
// a folder they created; the folder's creator's entry; the first Lens author, in Lens order, with an entry; else none.
// Never a stranger outside the Lens: a spammed folder can't be renamed in someone's breadcrumb.
//
// Read as fileNames reads (each check is the read audit's): the newest `scan` entries of the list (at most 16), the
// slice strictly increasing and the length asked; each entry's admission row, its author (the publication's
// principal), its position cell bound back to (parent, role) by positionKey, and the author's head there, which must
// still be BOUND to this folder (the list is append-only); the name text from the name record whose id the role commits
// to, hash-checked; the creator and the reader's folder ownership from hash-checked folder records. A reply a sound
// endpoint can't give fails over (UNKNOWN), never "no name".
//
// `complete`: true when the list is vouched for (coverage COMPLETE) and was read to its end (a null is proven absent),
// or when the reader's own name was found (nothing older can outrank the reader's newest entry). A creator's or a Lens
// author's name found in a partial scan is NOT proven: an older reader's (or creator's) entry beyond `scan` could
// outrank it, so it comes with `complete: false`.
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import type { CallRequest } from "../chain/basis.js";
import { onEndpoint } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { recordCall } from "../content/records.js";
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
import { indexAbi, ledgerAbi, ledgerReadsAbi, ledgerViewsAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { checkName, decodeScalars, NAME_PROFILE } from "../names/name.js";
import { positionKey, recordFromHash } from "../protocol/keys.js";
import { chainStatus, headState, headsAtServed, strictlyIncreasing } from "../protocol/status.js";
import { callsIn } from "../tags/filenames.js";
import { badReply, callOf, decoded } from "../tags/plan.js";
import type { Ctx, Evidence } from "./bytes.js";
import { decodeFolderRecord, type ParentRef } from "./folders.js";

const MAX_FOLDERS = 32;
const MAX_SCAN = 16;

export interface FolderNameInput {
  /** The folder: its directory record id (FolderRef.directory). */
  folder: RecordId;
  /** Whose own name comes first (rule 1). Default: the Lens's first principal. */
  reader?: PrincipalId;
}
export interface FolderNamesOpts extends CallOpts {
  /** The Lens for rule 3 (default: the client's default Lens). Never a principal outside it. */
  lens?: Lens;
  /** The newest backlink entries read per folder, 1 to 16 (default 16). */
  scan?: number;
}
export interface FolderName {
  text: string;
  /** Whose entry it is. */
  author: PrincipalId;
  /** The folder or home the entry is in: the next crumb up. */
  parent: ParentRef;
  /** Which rule chose it: the reader's own, the folder's creator's, or the first Lens author's. */
  why: "reader" | "creator" | "lens";
}
export interface FolderNameRow {
  folder: RecordId;
  /** null: nobody in the rule's order names it, in what was read (see `complete`). */
  name: FolderName | null;
  /** The folder's creator, from its hash-checked record; null when the id is not a folder at the basis. */
  creator: PrincipalId | null;
  /**
   * True when the list is vouched for and was read to its end (a null is proven), or the reader's own name was found.
   * False otherwise, including a creator's or Lens author's name found in a partial scan (an older entry could outrank
   * it): show the name, but not as final.
   */
  complete: boolean;
}
export type FolderNamesResult =
  | {
      kind: "efs.folderNames";
      status: "PRESENT";
      rows: readonly FolderNameRow[];
      basis: import("../chain/pool.js").Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.folderNames";
      status: "UNKNOWN";
      reason: Reason;
      basis?: import("../chain/pool.js").Basis;
      evidence: Evidence;
    };

type Entry = {
  folder: number;
  ordinal: bigint;
  publication?: bigint;
  bindingOrdinal?: bigint;
  author?: PrincipalId;
  position?: Hex;
  parent?: Hex;
  role?: Hex;
  current?: boolean;
};
const isHome = (word: Hex): boolean => /^0x0{24}/.test(word) && !/^0x0{64}$/.test(word);
const parentRef = (word: Hex): ParentRef =>
  isHome(word)
    ? { kind: "home", address: `0x${word.slice(26)}` as Address }
    : { kind: "folder", directory: word as RecordId };

/**
 * Names for folders by the spec §3.7 order, at one block: for each folder, the reader's own entry in their home or a
 * folder they created, else its creator's entry, else the first Lens author's (in Lens order), else null; newest entry
 * first within one author. At most 32 folders a call. One call names one level: a breadcrumb walks up through
 * `name.parent`, and must keep a visited set and a depth cap (placements can form cycles).
 */
export async function folderNames(
  efs: Efs,
  folders: readonly FolderNameInput[],
  o: FolderNamesOpts = {},
): Promise<FolderNamesResult> {
  if (!folders.length) throw misuse("folderNames needs at least one folder");
  if (folders.length > MAX_FOLDERS) throw misuse(`at most ${MAX_FOLDERS} folders a call`);
  for (const f of folders)
    if (!/^0x[0-9a-fA-F]{64}$/.test(f.folder ?? ""))
      throw misuse("a folder is its 32-byte directory record id");
  const scan = o.scan ?? MAX_SCAN;
  if (!Number.isInteger(scan) || scan < 1 || scan > MAX_SCAN)
    throw misuse(`scan is 1 to ${MAX_SCAN}`);
  const principals = uniquePrincipals((o.lens ?? efs.lens.default).principals);
  const d = efs.deployment;
  const family = d.index.backlinkFamily;
  const none: Evidence = { attempts: [], requests: 0 };
  if (!family || !d.index.address)
    return {
      kind: "efs.folderNames",
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
      kind: "efs.folderNames",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const ids = folders.map((f) => lower(f.folder) as RecordId);
  const readers = folders.map((f) =>
    f.reader
      ? (lower(f.reader) as PrincipalId)
      : ((principals[0] as PrincipalId | undefined) ?? null),
  );
  const nameType = d.typeIds[NAME_PROFILE] as Hex;
  const r = await onEndpoint<FolderNameRow[]>(
    efs._internal.pool,
    async (s) => {
      const at = basis.blockHash;
      // 1. The live index must be the deployment's; each list's head; each folder's own (hash-checked) record.
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
        ...ids.map((f) => recordCall(d, f)),
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
        const f = decodeFolderRecord(efs, ids[i] as Hex, out1[1 + ids.length + i]);
        if (!f.ok) return f;
        creators.push(f.value.status === "PRESENT" && f.value.directory ? f.value.owner : null);
      }
      // 2. The newest `scan` entries of each list: the length asked, strictly increasing.
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
        if (!strictlyIncreasing(sl.value[1]))
          return badReply("postingSliceOf (entries out of order)");
        covered.push(
          Number(sl.value[0]) === 3 && (heads[i] as { coverage: number }).coverage === 3,
        );
        for (const ord of [...sl.value[1]].reverse())
          entries.push({ folder: i, ordinal: BigInt(ord) });
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
      // 5. Each position's cell, bound back to its parent and name, and the author's head there now.
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
        if (
          chainStatus(cst) !== "PRESENT" ||
          lower(purpose) !== lower(PURPOSES.folder) ||
          lower(positionKey(PURPOSES.folder, parent, role)) !== lower(e.position as Hex)
        )
          return badReply("positionCell (a FOLDER backlink that is not a FOLDER position)");
        e.parent = lower(parent);
        e.role = lower(role);
        const h = decoded<[number, unknown, number, readonly { state: number; target: Hex }[]]>(
          ledgerViewsAbi,
          "headsAt",
          out5[2 * k + 1],
        );
        if (!h.ok) return h;
        if (!headsAtServed(h.value[0])) return badReply(`headsAt (status ${h.value[0]})`);
        const mine = h.value[3][0];
        if (!mine || h.value[3].length !== 1) return badReply("headsAt (one head)");
        // Append-only list: an entry counts only while its author still binds this very folder there.
        e.current =
          headState(Number(mine.state)) === "BOUND" && lower(mine.target) === ids[e.folder];
      }
      // 6. The readers' own folders (their owner is the hash-checked record's creator), then the chosen names.
      const current = entries.filter((e) => e.current);
      const readerParents = [
        ...new Set(
          current
            .filter((e) => e.author === readers[e.folder] && !isHome(e.parent as Hex))
            .map((e) => e.parent as Hex),
        ),
      ];
      const out6 = await callsIn(
        s,
        at,
        readerParents.map((p) => recordCall(d, p)),
      );
      ctx.requests += readerParents.length;
      const owners = new Map<Hex, PrincipalId | null>();
      for (const [k, p] of readerParents.entries()) {
        const f = decodeFolderRecord(efs, p, out6[k]);
        if (!f.ok) return f;
        owners.set(p, f.value.status === "PRESENT" && f.value.directory ? f.value.owner : null);
      }
      const ownParent = (e: Entry, who: PrincipalId): boolean =>
        isHome(e.parent as Hex) ? e.parent === who : owners.get(e.parent as Hex) === who;
      const chosen: ({ e: Entry; why: FolderName["why"] } | null)[] = folders.map((_, i) => {
        const here = current.filter((e) => e.folder === i); // newest first already
        const rd = readers[i];
        if (rd) {
          const t = here.find((e) => e.author === rd && ownParent(e, rd));
          if (t) return { e: t, why: "reader" };
        }
        const creator = creators[i];
        if (creator) {
          const c = here.find((e) => e.author === creator);
          if (c) return { e: c, why: "creator" };
        }
        for (const p of principals) {
          const l = here.find((e) => e.author === p);
          if (l) return { e: l, why: "lens" };
        }
        return null;
      });
      const roles = [...new Set(chosen.filter((c) => c !== null).map((c) => c.e.role as Hex))];
      const out7 = await callsIn(
        s,
        at,
        roles.map((role) =>
          callOf(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [
            d.ledger,
            recordFromHash(nameType, role),
            0,
            256,
          ]),
        ),
      );
      ctx.requests += roles.length;
      const names = new Map<Hex, string>();
      for (const [k, role] of roles.entries()) {
        const b = decoded<[number, Hex]>(ledgerReadsAbi, "bodySlice", out7[k]);
        if (!b.ok) return b;
        const bytes = hexToBytes(b.value[1]);
        const c = checkName(bytes);
        if (
          chainStatus(b.value[0]) !== "PRESENT" ||
          c.status !== "VALID" ||
          lower(keccak256(bytes)) !== role
        )
          return badReply("a name record (body or hash)");
        names.set(role, decodeScalars(bytes)?.text ?? "");
      }
      return {
        ok: true,
        value: folders.map((_, i) => {
          const c = chosen[i] ?? null;
          const readToEnd =
            (covered[i] as boolean) && (heads[i] as { count: bigint }).count <= BigInt(scan);
          return {
            folder: ids[i] as RecordId,
            name: c
              ? {
                  text: names.get(c.e.role as Hex) as string,
                  author: c.e.author as PrincipalId,
                  parent: parentRef(c.e.parent as Hex),
                  why: c.why,
                }
              : null,
            creator: creators[i] ?? null,
            complete: readToEnd || c?.why === "reader",
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
  if (!r.ok)
    return { kind: "efs.folderNames", status: "UNKNOWN", reason: r.reason, basis, evidence };
  return { kind: "efs.folderNames", status: "PRESENT", rows: r.value, basis, evidence };
}
