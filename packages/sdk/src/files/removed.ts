// SPDX-License-Identifier: MIT
// One author's removed entries in a folder ("Show removed"): the names they released or hid there, each with the
// target it had before, so an app can offer Restore from a list. Lens-independent: it reads only that author's own
// scope list, the index's kind-10 list of the positions they ever bound under this folder (first-bind order), then
// each position's head, keeping the RELEASED and MASKED ones.
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, hexToBytes, lower, type PrincipalId } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import {
  bitmapStoreAbi,
  indexAbi,
  ledgerAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
} from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { decodeScalars, NAME_PROFILE } from "../names/name.js";
import { bindingKey, positionKey, recordFromHash, scopeKey } from "../protocol/keys.js";
import { chainStatus, headState, strictlyIncreasing } from "../protocol/status.js";
import type { Ctx, Evidence } from "./bytes.js";
import {
  checkParent,
  type EntryTarget,
  type FolderCoverage,
  type ParentRef,
  parentSubject,
  targetRef,
} from "./folders.js";

/**
 * What an entry pointed at before it was removed, read from its history:
 * - KNOWN: the target of its last BIND, which Restore binds again;
 * - NEVER_BOUND: a hide with no earlier bind by this author (a lone hide of someone else's entry at that name): there is
 *   nothing to restore, and Unhide (planUnhideEntries) removes the hide;
 * - UNKNOWN: the history is deeper than the walk's bound, or the endpoint can't walk it (`reason`); never a guess.
 */
export type LastBound =
  | { last: "KNOWN"; target: EntryTarget }
  | { last: "NEVER_BOUND" }
  | { last: "UNKNOWN"; reason: Reason };

export type RemovedRow = {
  name: string;
  /** The entry's FOLDER position. */
  position: Hex;
  /** RELEASED: removed (the next author's entry shows there). MASKED: removed with hide. */
  state: "RELEASED" | "MASKED";
  /** The binding's revision now (what a restore's or an unhide's compare-and-swap expects). */
  revision: bigint;
  /** The admission that removed it (ledger order). */
  removedAt: bigint;
} & LastBound;

/** Continues a removed-entries listing: an index into the author's scope list, for the same folder and author. */
export interface RemovedCursor {
  v: 1;
  query: Hex;
  from: string;
}

export interface ListRemovedOpts extends CallOpts {
  /** Scope entries scanned per page (bound or not), default 50, at most 64. */
  limit?: number;
  cursor?: RemovedCursor;
}

export type RemovedPage =
  | {
      kind: "efs.removedPage";
      status: "PRESENT";
      folder: ParentRef;
      author: PrincipalId;
      rows: readonly RemovedRow[];
      /** COMPLETE only for the author's whole scope list read from its start on this page. */
      coverage: FolderCoverage;
      next?: RemovedCursor;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.removedPage";
      /** ABSENT_PROVEN: no such folder. UNKNOWN: nothing decided (never an empty list). INVALID: not a folder. */
      status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID";
      folder: ParentRef;
      author: PrincipalId;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

const MAX_LIMIT = 64;
const failed = (out: { ok: false; reason: Reason } | undefined): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
});
const bad = (what: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", `${what} did not decode`),
});
const call = (
  to: Hex,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[] = [],
): CallRequest => ({
  to: to as `0x${string}`,
  data: encodeFunctionData({ abi: abi as never, functionName, args } as never),
});
function decode<T>(
  abi: readonly unknown[],
  functionName: string,
  out: Awaited<ReturnType<typeof callsAt>>[number] | undefined,
): Step<T> {
  if (!out?.ok) return failed(out);
  try {
    return {
      ok: true,
      value: decodeFunctionResult({
        abi: abi as never,
        functionName,
        data: out.result as Hex,
      } as never) as T,
    };
  } catch {
    return bad(functionName);
  }
}
const queryOf = (folder: Hex, author: Hex): Hex =>
  keccak256(utf8Encode(JSON.stringify(["efs-sdk/removed-cursor/1", lower(folder), lower(author)])));

type RawHead = {
  state: number;
  revision: bigint;
  admission: bigint;
  targetKind: number;
  prevAdmission: bigint;
  target: Hex;
};

/**
 * List `author`'s removed entries in `folder` (released, or hidden), each with its last target, a page of their scope
 * list at a time, at one block. The index and its bitmap store must be the ones the deployment names, or nothing is
 * claimed (UNKNOWN). COMPLETE only for the whole list read from its start; an empty page that is not COMPLETE is
 * UNKNOWN, never "nothing removed".
 */
export async function listRemoved(
  efs: Efs,
  input: { folder: ParentRef; author: PrincipalId },
  o: ListRemovedOpts = {},
): Promise<RemovedPage> {
  const folder = checkParent(input.folder);
  const subject = parentSubject(folder);
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.author ?? ""))
    throw misuse("author is a 32-byte principal id");
  const limit = o.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw misuse(`limit is a whole number from 1 to ${MAX_LIMIT}`);
  const author = lower(input.author) as PrincipalId;
  const query = queryOf(subject, author);
  if (o.cursor && (o.cursor.v !== 1 || o.cursor.query !== query || !/^[0-9]+$/.test(o.cursor.from)))
    throw misuse("this cursor continues another listing (another folder or author)");
  const from = o.cursor ? BigInt(o.cursor.from) : 0n;
  const d = efs.deployment;
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  const base = { kind: "efs.removedPage" as const, folder, author };
  if (pin.status !== "VERIFIED")
    return {
      ...base,
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const { address: indexAddress, scopeFamily, bitmapStore } = d.index;
  if (!indexAddress || !scopeFamily || !bitmapStore)
    return {
      ...base,
      status: "UNKNOWN",
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        "the deployment names no index scope list to read",
      ),
      basis,
      evidence: pin.evidence,
    };
  const dirType = lower(d.typeIds["files-directory/1"] as Hex);
  const nameType = d.typeIds[NAME_PROFILE] as Hex;
  const scope = scopeKey(author, PURPOSES.folder, subject);
  type Out =
    | { kind: "page"; rows: RemovedRow[]; coverage: FolderCoverage; next?: bigint }
    | { kind: "refused"; status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s) => {
      // 1. The index generation and its store must be the deployment's, and the folder must be a folder (a home
      // always exists: it has no record to read).
      const home = folder.kind === "home";
      ctx.requests += home ? 3 : 4;
      const outs1 = await callsAt(s, basis.blockHash, [
        call(d.ledger, ledgerAbi, "index"),
        call(indexAddress, indexAbi, "bitmapStore"),
        call(indexAddress, indexAbi, "coverage", [scopeFamily, scope]),
        ...(home
          ? []
          : [call(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, [subject]])]),
      ]);
      const ix = decode<Hex>(ledgerAbi, "index", outs1[0]);
      const store = decode<Hex>(indexAbi, "bitmapStore", outs1[1]);
      const cov = decode<[number, bigint, bigint, number]>(indexAbi, "coverage", outs1[2]);
      const rec = home
        ? ({ ok: true, value: [[], []] } as const)
        : decode<[number[], { typeId: Hex; length: number }[]]>(
            ledgerViewsAbi,
            "records",
            outs1[3],
          );
      for (const x of [ix, store, cov, rec]) if (!x.ok) return x;
      if (!ix.ok || !store.ok || !cov.ok || !rec.ok) return bad("unreachable");
      if (lower(ix.value) !== indexAddress || lower(store.value) !== bitmapStore)
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "UNKNOWN",
            reason: reason(
              "UNSUPPORTED_PROFILE",
              "never",
              "the live index is not the one the deployment names",
            ),
          },
        };
      const st = home ? "PRESENT" : chainStatus(rec.value[0][0] as number);
      const h = home ? undefined : rec.value[1][0];
      if (st === "ABSENT_PROVEN")
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "ABSENT_PROVEN",
            reason: reason("NOT_YET_DECIDABLE", "never", "no folder has this record id"),
          },
        };
      if (!home && (st !== "PRESENT" || !h)) return bad(`records (${st})`);
      if (h && (lower(h.typeId) !== dirType || Number(h.length) !== 64))
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "INVALID",
            reason: reason(
              "UNSUPPORTED_PROFILE",
              "never",
              "this record is not a files-directory/1 folder",
            ),
          },
        };
      // 2. The author's scope list under this folder: its length, and this page's binding ordinals.
      ctx.requests += 2;
      const outs2 = await callsAt(s, basis.blockHash, [
        call(bitmapStore, bitmapStoreAbi, "scopeHead", [scope]),
        call(bitmapStore, bitmapStoreAbi, "scopeSlice", [scope, from, limit]),
      ]);
      const head = decode<[bigint, bigint, bigint, number, number, bigint]>(
        bitmapStoreAbi,
        "scopeHead",
        outs2[0],
      );
      const slice = decode<readonly bigint[]>(bitmapStoreAbi, "scopeSlice", outs2[1]);
      if (!head.ok) return head;
      if (!slice.ok) return slice;
      const count = BigInt(head.value[0]);
      // This page is the list's entries from `from`, at most `limit`: a shorter slice would drop entries silently.
      const wanted = Number(count > from ? count - from : 0n);
      const expected = Math.min(wanted, Number(limit));
      if (slice.value.length < expected)
        return bad("scopeSlice (fewer entries than the list holds)");
      const ordinals = [...slice.value].slice(0, wanted);
      if (!strictlyIncreasing(ordinals)) return bad("scopeSlice (entries out of order)");
      // 3. Each ordinal's position, then the author's head there and the position's cell (its name role).
      const positions: Hex[] = [];
      if (ordinals.length > 0) {
        ctx.requests += ordinals.length;
        const outs3 = await callsAt(
          s,
          basis.blockHash,
          ordinals.map((ord) =>
            call(d.readers.ledgerReads, ledgerReadsAbi, "bindingPosition", [d.ledger, ord]),
          ),
        );
        for (const out of outs3) {
          const p = decode<[number, Hex]>(ledgerReadsAbi, "bindingPosition", out);
          if (!p.ok) return p;
          if (chainStatus(p.value[0]) !== "PRESENT") return bad("bindingPosition (status)");
          positions.push(lower(p.value[1]));
        }
      }
      const rows: RemovedRow[] = [];
      if (positions.length > 0) {
        ctx.requests += 1 + positions.length;
        const outs4 = await callsAt(s, basis.blockHash, [
          call(d.readers.ledgerViews, ledgerViewsAbi, "heads", [
            d.ledger,
            positions.map((p) => bindingKey(author, p)),
          ]),
          ...positions.map((p) =>
            call(d.readers.ledgerReads, ledgerReadsAbi, "positionCell", [d.ledger, p]),
          ),
        ]);
        const heads = decode<[RawHead[]]>(ledgerViewsAbi, "heads", outs4[0]);
        if (!heads.ok) return heads;
        if (heads.value[0].length !== positions.length) return bad("heads (one per key)");
        const removed: { position: Hex; role: Hex; head: RawHead }[] = [];
        for (const [i, position] of positions.entries()) {
          const cell = decode<[number, Hex, Hex, Hex]>(
            ledgerReadsAbi,
            "positionCell",
            outs4[1 + i],
          );
          if (!cell.ok) return cell;
          const [cst, purpose, cellSubject, role] = cell.value;
          // The scope list is this author's FOLDER positions under this folder: anything else is a reply to refuse.
          if (
            chainStatus(cst) !== "PRESENT" ||
            lower(purpose) !== lower(PURPOSES.folder) ||
            lower(cellSubject) !== subject ||
            // the cell is the position asked about: its role (the name) is bound to it, never taken on trust
            lower(positionKey(PURPOSES.folder, cellSubject, role)) !== lower(position)
          )
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason(
                "RPC_ERROR",
                "transient",
                "a scope entry is not a position of this folder",
              ),
            };
          const hd = heads.value[0][i] as RawHead;
          const hs = headState(hd.state);
          if (hs === "RELEASED" || hs === "MASKED")
            removed.push({ position, role: lower(role), head: hd });
        }
        // 4. Each removed entry's name (its files-name/3 record) and its last bound target (its history).
        if (removed.length > 0) {
          ctx.requests += removed.length;
          const names = await callsAt(
            s,
            basis.blockHash,
            removed.map((x) =>
              call(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [
                d.ledger,
                recordFromHash(nameType, x.role),
                0,
                255,
              ]),
            ),
          );
          for (const [i, x] of removed.entries()) {
            const nb = decode<[number, Hex]>(ledgerReadsAbi, "bodySlice", names[i]);
            if (!nb.ok) return nb;
            const bytes = hexToBytes(nb.value[1]);
            const name = decodeScalars(bytes)?.text;
            if (
              chainStatus(nb.value[0]) !== "PRESENT" ||
              name === undefined ||
              keccak256(bytes) !== x.role
            )
              return {
                ok: false,
                retryElsewhere: true,
                reason: reason(
                  "RPC_ERROR",
                  "transient",
                  "a removed entry's name record does not match its role",
                ),
              };
            const last = await lastBoundTarget(
              ctx,
              s,
              basis,
              bindingKey(author, x.position),
              x.head,
            );
            if (!last.ok) return last;
            const state = headState(x.head.state) as "RELEASED" | "MASKED";
            // A released name you never placed anything at does nothing to any read: not a removed entry.
            if (state === "RELEASED" && last.value.last === "NEVER_BOUND") continue;
            rows.push({
              name,
              position: x.position,
              state,
              revision: BigInt(x.head.revision),
              removedAt: BigInt(x.head.admission),
              ...last.value,
            });
          }
        }
      }
      const end = from + BigInt(ordinals.length);
      const more = end < count;
      const indexComplete = cov.value[0] === 3;
      const coverage: FolderCoverage =
        cov.value[0] === 1
          ? {
              state: "UNKNOWN",
              reason: reason(
                "NOT_YET_DECIDABLE",
                "transient",
                "the index does not vouch for this scope list yet",
              ),
            }
          : !o.cursor && !more && indexComplete
            ? { state: "COMPLETE" }
            : {
                state: "PARTIAL",
                why: more ? "MORE_PAGES" : o.cursor ? "RESUMED" : "INDEX_PARTIAL",
              };
      if (rows.length === 0 && coverage.state !== "COMPLETE" && !more && !o.cursor)
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "UNKNOWN",
            reason: reason(
              "NOT_YET_DECIDABLE",
              "transient",
              "the index cannot vouch for an empty list of removed entries yet",
            ),
          },
        };
      return { ok: true, value: { kind: "page", rows, coverage, ...(more ? { next: end } : {}) } };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { ...base, status: "UNKNOWN", reason: r.reason, basis, evidence };
  const v = r.value;
  if (v.kind === "refused") return { ...base, status: v.status, reason: v.reason, basis, evidence };
  return {
    ...base,
    status: "PRESENT",
    rows: v.rows,
    coverage: v.coverage,
    ...(v.next !== undefined ? { next: { v: 1, query, from: v.next.toString() } } : {}),
    basis,
    evidence,
  };
}

/**
 * What a removed head's earlier version may be, under the tag release's rules: UNBIND is admitted from every state (a
 * first mask, a number change, a re-stated hide after a release), and RELEASE from a BOUND or MASKED head.
 */
const MAY_PRECEDE: Readonly<Record<"MASKED" | "RELEASED", readonly string[]>> = {
  MASKED: ["BOUND", "MASKED", "RELEASED"],
  RELEASED: ["BOUND", "MASKED"],
};
/** The most versions the walk reads back from a removed head before it answers UNKNOWN for that entry. */
export const HISTORY_WALK_VERSIONS = 32;
/** historyAt's own bound: its walk from the live head, plus the hops a mask takes to find its last BIND's kind. */
const HISTORY_HOPS = 2 * HISTORY_WALK_VERSIONS;
const contradiction = (detail: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", detail),
});

/**
 * The target a removed (MASKED or RELEASED) binding had: its last BOUND version, read from its history at the basis,
 * one version at a time back from the head (at most HISTORY_WALK_VERSIONS; beyond, that entry is UNKNOWN). Under the
 * tag release a history may alternate hides and releases to any depth, and may begin with a hide that names no
 * target (a lone hide): that is NEVER_BOUND, not an error.
 * A history that breaks the ledger's rules is the endpoint's fault, and the read fails and moves to the next
 * endpoint; it never returns a guessed target. That covers:
 * - a version that can't precede the next;
 * - an admission other than the one asked for;
 * - revisions that don't count down by one per version;
 * - a first version that is not revision 1, or that carries a target although it is a hide;
 * - a target kind no FOLDER bind can carry.
 * Shared by listRemoved and planRestoreEntries, so a row's target is exactly what Restore binds.
 * @internal
 */
export async function lastBoundTarget(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  key: Hex,
  head: { state: number; prevAdmission: bigint; revision: bigint | number },
): Promise<Step<LastBound>> {
  const d = ctx.efs.deployment;
  let state = headState(head.state);
  let asOf = BigInt(head.prevAdmission);
  let revision = BigInt(head.revision);
  if (state !== "MASKED" && state !== "RELEASED") return contradiction("the entry is not removed");
  for (let walked = 0; ; walked++) {
    if (asOf === 0n) {
      // The first version: only a hide can begin a history with nothing before it.
      if (state !== "MASKED" || revision !== 1n)
        return contradiction("a removed entry's history has no bound version");
      return { ok: true, value: { last: "NEVER_BOUND" } };
    }
    if (walked === HISTORY_WALK_VERSIONS)
      return {
        ok: true,
        value: {
          last: "UNKNOWN",
          reason: reason(
            "LIMIT_EXCEEDED",
            "never",
            `the entry's history is more than ${HISTORY_WALK_VERSIONS} versions deep`,
          ),
        },
      };
    ctx.requests += 1;
    const [out] = await callsAt(s, basis.blockHash, [
      call(d.readers.ledgerViews, ledgerViewsAbi, "historyAt", [d.ledger, key, asOf, HISTORY_HOPS]),
    ]);
    const h = decode<[number, RawHead]>(ledgerViewsAbi, "historyAt", out);
    if (!h.ok) return h;
    const found = h.value[0]; // History: 1 UNKNOWN (beyond its hops), 2 NONE, 3 FOUND
    if (found === 1)
      return {
        ok: true,
        value: {
          last: "UNKNOWN",
          reason: reason(
            "LIMIT_EXCEEDED",
            "never",
            "the entry's history is deeper than the reader walks",
          ),
        },
      };
    if (found !== 3)
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason(
          "NOT_YET_DECIDABLE",
          "transient",
          "the entry's history could not be read back",
        ),
      };
    const prior = h.value[1];
    const was = headState(prior.state);
    revision -= 1n;
    if (
      BigInt(prior.admission) !== asOf ||
      BigInt(prior.revision) !== revision ||
      !MAY_PRECEDE[state].includes(was)
    )
      return contradiction("a removed entry's history breaks the ledger's rules");
    if (was === "BOUND") {
      const ref = targetRef(prior.targetKind, prior.target);
      return ref
        ? { ok: true, value: { last: "KNOWN", target: ref } }
        : contradiction("a FOLDER bind names a target kind it can't carry");
    }
    // A hide with nothing before it names no target (a lone hide keeps target kind 0).
    if (BigInt(prior.prevAdmission) === 0n && Number(prior.targetKind) !== 0)
      return contradiction("a first hide carries a target");
    state = was as "MASKED" | "RELEASED";
    asOf = BigInt(prior.prevAdmission);
  }
}
