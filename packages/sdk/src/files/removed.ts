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
import { type Hex, hexToBytes, lower, type PrincipalId, type RecordId } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import {
  bitmapStoreAbi,
  indexAbi,
  ledgerAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
} from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { decodeScalars } from "../names/name.js";
import { bindingKey, recordFromHash, scopeKey } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import type { Ctx, Evidence } from "./bytes.js";
import { type EntryTarget, type FolderCoverage, type FolderRef, targetRef } from "./folders.js";

export interface RemovedRow {
  name: string;
  /** The entry's FOLDER position. */
  position: Hex;
  /** RELEASED: removed (the next author's entry shows there). MASKED: removed with hide. */
  state: "RELEASED" | "MASKED";
  /**
   * The target the entry had before it was removed: what Restore binds again. Always known. A removed entry always had
   * one (the ledger only hides or releases a bound entry), and a history that can't name it makes the page UNKNOWN.
   */
  target: EntryTarget;
  /** The binding's revision now (what a restore's compare-and-swap expects). */
  revision: bigint;
  /** The admission that removed it (ledger order). */
  removedAt: bigint;
}

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
      folder: FolderRef;
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
      folder: FolderRef;
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
  input: { folder: FolderRef; author: PrincipalId },
  o: ListRemovedOpts = {},
): Promise<RemovedPage> {
  const dir = input.folder?.directory;
  if (input.folder?.kind !== "folder" || !/^0x[0-9a-fA-F]{64}$/.test(dir ?? ""))
    throw misuse("a folder is { kind: 'folder', directory: <files-directory/1 record id> }");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.author ?? ""))
    throw misuse("author is a 32-byte principal id");
  const limit = o.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw misuse(`limit is a whole number from 1 to ${MAX_LIMIT}`);
  const folder: FolderRef = { kind: "folder", directory: lower(dir) as RecordId };
  const author = lower(input.author) as PrincipalId;
  const query = queryOf(folder.directory, author);
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
  const nameType = d.typeIds["files-name/2"] as Hex;
  const scope = scopeKey(author, PURPOSES.folder, folder.directory);
  type Out =
    | { kind: "page"; rows: RemovedRow[]; coverage: FolderCoverage; next?: bigint }
    | { kind: "refused"; status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s) => {
      // 1. The index generation and its store must be the deployment's, and the folder must be a folder.
      ctx.requests += 4;
      const outs1 = await callsAt(s, basis.blockHash, [
        call(d.ledger, ledgerAbi, "index"),
        call(indexAddress, indexAbi, "bitmapStore"),
        call(indexAddress, indexAbi, "coverage", [scopeFamily, scope]),
        call(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, [folder.directory]]),
      ]);
      const ix = decode<Hex>(ledgerAbi, "index", outs1[0]);
      const store = decode<Hex>(indexAbi, "bitmapStore", outs1[1]);
      const cov = decode<[number, bigint, bigint, number]>(indexAbi, "coverage", outs1[2]);
      const rec = decode<[number[], { typeId: Hex; length: number }[]]>(
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
      const st = chainStatus(rec.value[0][0] as number);
      const h = rec.value[1][0];
      if (st === "ABSENT_PROVEN")
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "ABSENT_PROVEN",
            reason: reason("NOT_YET_DECIDABLE", "never", "no folder has this record id"),
          },
        };
      if (st !== "PRESENT" || !h) return bad(`records (${st})`);
      if (lower(h.typeId) !== dirType || Number(h.length) !== 64)
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
      const ordinals = [...slice.value].slice(0, Number(count > from ? count - from : 0n));
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
          const [cst, purpose, subject, role] = cell.value;
          // The scope list is this author's FOLDER positions under this folder: anything else is a reply to refuse.
          if (
            chainStatus(cst) !== "PRESENT" ||
            lower(purpose) !== lower(PURPOSES.folder) ||
            lower(subject) !== folder.directory
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
        // 4. Each removed entry's name (its files-name/2 record) and its last bound target (its history).
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
            const target = await lastBoundTarget(
              ctx,
              s,
              basis,
              bindingKey(author, x.position),
              x.head,
            );
            if (!target.ok) return target;
            rows.push({
              name,
              position: x.position,
              state: headState(x.head.state) as "RELEASED" | "MASKED",
              target: target.value,
              revision: BigInt(x.head.revision),
              removedAt: BigInt(x.head.admission),
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

/** What a removed head's earlier version may be: UNBIND needs a BOUND head, RELEASE a BOUND or MASKED one. */
const MAY_PRECEDE: Readonly<Record<"MASKED" | "RELEASED", readonly string[]>> = {
  MASKED: ["BOUND"],
  RELEASED: ["BOUND", "MASKED"],
};
/** historyAt's own bound on rows read from the live head (the walk needs at most two). */
const HISTORY_ROWS = 8;
const contradiction = (detail: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", detail),
});

/**
 * The target a removed (MASKED or RELEASED) binding had: its last BOUND version, read from its history at the basis.
 * The ledger's rules decide what the walk can meet. UNBIND needs a BOUND head and RELEASE a BOUND or MASKED one, so
 * every binding starts with a BIND and the last bound version is at most two versions back (RELEASED, MASKED, BOUND).
 * So on an honest endpoint the target is always known. A history that can't be read, or one that breaks those rules
 * (a version that can't precede the next, an admission that isn't the one asked for, a target kind no FOLDER bind
 * can carry), is the endpoint's fault: the read fails and moves to the next endpoint. It never returns a guessed
 * target.
 * Shared by listRemoved and planRestoreEntries, so a row's target is exactly what Restore binds.
 * These rules hold for this contracts release only: the tag release admits UNBIND from every state, so this walk
 * changes at that re-vendor (docs/design/tags-0.1.md section 7, the re-vendor checklist).
 * @internal
 */
export async function lastBoundTarget(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  key: Hex,
  head: { state: number; prevAdmission: bigint },
): Promise<Step<EntryTarget>> {
  const d = ctx.efs.deployment;
  let state = headState(head.state);
  let asOf = BigInt(head.prevAdmission);
  if (state !== "MASKED" && state !== "RELEASED") return contradiction("the entry is not removed");
  for (;;) {
    if (asOf === 0n) return contradiction("a removed entry's history has no bound version");
    ctx.requests += 1;
    const [out] = await callsAt(s, basis.blockHash, [
      call(d.readers.ledgerViews, ledgerViewsAbi, "historyAt", [d.ledger, key, asOf, HISTORY_ROWS]),
    ]);
    const h = decode<[number, RawHead]>(ledgerViewsAbi, "historyAt", out);
    if (!h.ok) return h;
    if (h.value[0] !== 3)
      // History.FOUND
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
    if (BigInt(prior.admission) !== asOf || !MAY_PRECEDE[state].includes(was))
      return contradiction("a removed entry's history breaks the ledger's rules");
    if (was === "BOUND") {
      const ref = targetRef(prior.targetKind, prior.target);
      return ref
        ? { ok: true, value: ref }
        : contradiction("a FOLDER bind names a target kind it can't carry");
    }
    state = "MASKED"; // MAY_PRECEDE admits only BOUND or MASKED here, and only after RELEASED
    asOf = BigInt(prior.prevAdmission);
  }
}
