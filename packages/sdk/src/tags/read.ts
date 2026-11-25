// SPDX-License-Identifier: MIT
// Topic reads (the tag release's readers: TopicMineReader, TopicEveryoneReader, TopicLookupReader), at one block:
//   topicItems   a page of things at a place (a topic or a home), exact or with everything below it (roll-up):
//                Mine (the Lens's own statements), Everyone (rows someone says yes to, minus what the Lens hides) or
//                Raw (every row). Each row says who decided it: a Lens author, or the public tier.
//   tagsOf       every place a thing is filed at, either sign, with its yes-count.
//   topicChildren, wordPage, topicPath   the directory: a topic's children, a word's places, a topic's words.
//   placeCount, authorCount              the counts, one read each ("about" figures, never row counts).
// The page laws (tag spec 3.3): a page reads at most `entries` list entries and returns at most `rows` rows,
// whichever comes first. Skipped rows (nobody says yes, hidden, repeats) return nothing, so a page may be short or
// empty while entries remain: only the chain's EXHAUSTED ends a listing, and every other page carries a cursor. The
// chain removes repeats within one call; the SDK removes them by thing across calls and pages (the cursor carries the
// things already returned, up to a bound, past which `dedup` says BOUNDED). Per-call bounds come from the gas model's
// `reads` section (page × Lens per view, rows and entries per call), so no call is too big for an endpoint.
import { decodeFunctionResult, encodeFunctionData, hexToBytes, keccak256 } from "viem";
import { gasPlanFor } from "../actions/split.js";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Address, bytesToHex, type Hex, lower, type PrincipalId } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import { type Ctx, EMPTY_BASIS, type Evidence } from "../files/bytes.js";
import {
  ledgerReadsAbi,
  topicEveryoneReaderAbi,
  topicLookupReaderAbi,
  topicMineReaderAbi,
} from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { GAS_READS } from "../generated/gas.js";
import type { FoldStep } from "../names/links.js";
import { decodeScalars } from "../names/name.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus } from "../protocol/status.js";
import { checkWord, homeId, pathId, type TopicId, topicTypesOf, wordPageId } from "./topics.js";

/** A place: a topic by its words or its id, or a home (an address). */
export type TopicPlace =
  | readonly string[]
  | { kind: "topic"; id: Hex }
  | { kind: "home"; address: Address };
export type TopicView = "mine" | "everyone" | "raw";
/** Why a page stopped: the list ended (the only end), or a bound was reached (entries, gas, rows). */
export type ScanStatus = "EXHAUSTED" | "LIMIT" | "GAS" | "ROWS";

/** Who decided a row: a Lens author (with their index and number), or the public tier (someone says yes). */
export type Decider =
  | { kind: "lens"; index: number; author: PrincipalId; number: number }
  | { kind: "public" }
  /** Raw rows apply no rule. */
  | { kind: "none" };

export interface TopicRow {
  /** The thing (the position's role): a file's subject, a record id, or a padded address. */
  thing: Hex;
  /** The topic it was filed under (the place itself, or a topic below it in a roll-up). */
  topic: Hex;
  position: Hex;
  /** The deciding statement's number (Mine: the Lens author's; Everyone: the Lens author's or 0 for the public tier). */
  number: number;
  decider: Decider;
  /** Everyone and Raw: authors who ever stated anything at the position, and how many say yes now (exact). */
  statements?: bigint;
  yes?: bigint;
  /** A sample of the newest authors (`sample` > 0): how many say yes and no, and whether it covered them all. */
  sample?: { sampled: number; yes: number; no: number; incomplete: boolean };
  /** The list entry the row came from (a binding ordinal). */
  entry: bigint;
}

/** Continues a listing: the chain's resume point, and the things already returned (for de-duplication). */
export interface TopicCursor {
  v: 1;
  query: Hex;
  next: Hex;
  seen: readonly Hex[];
  /** More things were returned than `seen` holds: de-duplication past it is bounded. */
  bounded: boolean;
}

export interface TopicItemsOpts extends CallOpts {
  /** Default "everyone". */
  view?: TopicView;
  /** Mine and Everyone: the Lens (default: the client's default Lens). Raw reads none. */
  lens?: Lens;
  /** Everything below the place too (topics only). */
  below?: boolean;
  /** Rows wanted on this page (default 50). */
  rows?: number;
  /** List entries this page may read at most (default: 4 × the per-call entry bound). */
  entries?: number;
  cursor?: TopicCursor;
  /** Everyone and Raw: the newest authors to sample per row (default 0). */
  sample?: number;
  /** Folds each typed word of a place given by words. */
  fold?: FoldStep;
}

export type TopicPage =
  | {
      kind: "efs.topicPage";
      status: "PRESENT";
      view: TopicView;
      place: Hex;
      rows: readonly TopicRow[];
      /** True only when the chain said the list ended (EXHAUSTED). A short or empty page is not the end. */
      finished: boolean;
      scan: ScanStatus;
      next?: TopicCursor;
      /** COMPLETE only for a whole listing read from its origin in one call that the index vouches for. */
      coverage: "COMPLETE" | "PARTIAL";
      /** COMPLETE: no row repeats a thing already returned. BOUNDED: past the cursor's memory, repeats may slip. */
      dedup: { state: "COMPLETE" | "BOUNDED"; dropped: number };
      counts: {
        scanned: number;
        rawTotal: bigint;
        positionsEver: bigint;
        repeatsSkipped: number;
        calls: number;
      };
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.topicPage";
      /** UNKNOWN: nothing decided (never an empty page). INVALID: the reader refused the query. */
      status: "UNKNOWN" | "INVALID";
      view: TopicView;
      place: Hex;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

const SCAN: Readonly<Record<number, ScanStatus>> = {
  1: "EXHAUSTED",
  2: "LIMIT",
  3: "GAS",
  4: "ROWS",
};
/** Gas the reader keeps for its return encoding and one more batch of rows. */
const GAS_RESERVE = 1_000_000n;
/** The most reader calls one page makes (each bounded), so a heavily padded list returns a page, never loops. */
const MAX_CALLS = 8;
/** The things a cursor remembers for de-duplication. */
const SEEN_MAX = 256;
const NO_DECIDER = 255;

const callOf = (
  to: Hex,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): CallRequest => ({
  to: to as `0x${string}`,
  data: encodeFunctionData({ abi: abi as never, functionName, args } as never),
});
const failed = (out: { ok: false; reason: Reason } | undefined): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
});
function decoded<T>(
  abi: readonly unknown[],
  fn: string,
  out: { ok: boolean; result?: unknown } | undefined,
): Step<T> {
  if (!out?.ok) return failed(out as { ok: false; reason: Reason } | undefined);
  try {
    return {
      ok: true,
      value: decodeFunctionResult({
        abi: abi as never,
        functionName: fn,
        data: out.result as Hex,
      } as never) as T,
    };
  } catch {
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason("RPC_ERROR", "transient", `${fn} did not decode`),
    };
  }
}

/** A place's id (and whether it is a topic). MISUSE for refused words. */
export function placeId(efs: Efs, p: TopicPlace, fold?: FoldStep): { id: Hex; topic: boolean } {
  if (Array.isArray(p)) {
    const t = topicTypesOf(efs.deployment);
    const words = (p as readonly string[]).map((typed, i) => {
      let w = typed;
      if (fold) {
        const f = fold(typed);
        if (!f.ok) throw misuse(`word ${i} does not fold (${f.rule})`, { index: i });
        w = f.word;
      }
      return w;
    });
    return { id: pathId(t, words), topic: true };
  }
  const q = p as { kind: string; id?: Hex; address?: Address };
  if (q.kind === "topic") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(q.id ?? "")) throw misuse("a topic id is 32 bytes of hex");
    return { id: lower(q.id as Hex), topic: true };
  }
  if (q.kind === "home") return { id: homeId(q.address as Address), topic: false };
  throw misuse("a place is a list of words, { kind: 'topic', id } or { kind: 'home', address }");
}

/** Status of a reader reply, as a refusal for anything but PRESENT. */
function refusal(code: number): { status: "UNKNOWN" | "INVALID"; reason: Reason } | null {
  const st = chainStatus(code);
  if (st === "PRESENT") return null;
  if (st === "BASIS_STALE")
    return {
      status: "UNKNOWN",
      reason: reason("BASIS_STALE", "after-replan", "the listing moved on: start again"),
    };
  if (st === "UNKNOWN")
    return {
      status: "UNKNOWN",
      reason: reason("NOT_YET_DECIDABLE", "transient", "the index can't vouch for this list yet"),
    };
  if (st === "LIMIT_EXCEEDED")
    return {
      status: "INVALID",
      reason: reason("LIMIT_EXCEEDED", "never", "the reader refused the query's size (the Lens?)"),
    };
  if (st === "UNSUPPORTED")
    return {
      status: "INVALID",
      reason: reason("UNSUPPORTED_PROFILE", "never", "the reader does not serve this index"),
    };
  return {
    status: "INVALID",
    reason: reason("UNSUPPORTED_PROFILE", "never", `the reader answered ${st}`),
  };
}

/** The gas model's read bounds for this deployment's schedule. */
function bounds(efs: Efs): (typeof GAS_READS.recommended)["prague"] {
  const g = gasPlanFor(efs.deployment);
  const schedule = g.ok ? g.model.schedule : "prague";
  const rec = GAS_READS.recommended as unknown as Record<
    string,
    (typeof GAS_READS.recommended)["prague"]
  >;
  return rec[schedule] ?? GAS_READS.recommended.prague;
}

type RawInfo = {
  q: { status: number };
  listingCoverage: number;
  scanStatus: number;
  completeFromOrigin: boolean;
  scanned: bigint;
  rawTotal: bigint;
  positionsEver: bigint;
  repeatsSkipped: bigint;
  next: Hex;
};
type RawMine = {
  position: Hex;
  topic: Hex;
  thing: Hex;
  decider: number;
  principalId: Hex;
  number: number;
  bindingOrdinal: bigint;
};
type RawPlace = {
  position: Hex;
  topic: Hex;
  thing: Hex;
  bindingOrdinal: bigint;
  decider: number;
  number: number;
  statements: bigint;
  yes: bigint;
  sampled: number;
  sampleYes: number;
  sampleNo: number;
  incomplete: boolean;
};

/**
 * A page of things at a place. See the page laws above: a short or empty page with `finished: false` means "read on
 * with `next`", never "nothing more".
 */
export async function topicItems(
  efs: Efs,
  place: TopicPlace,
  o: TopicItemsOpts = {},
): Promise<TopicPage> {
  const view = o.view ?? "everyone";
  const { id, topic } = placeId(efs, place, o.fold);
  if (o.below && !topic) throw misuse("a home has nothing below it: `below` is for topics");
  const d = efs.deployment;
  const reader = view === "mine" ? d.readers.topicMine : d.readers.topicEveryone;
  if (!reader) throw misuse("this deployment names no topic readers (it predates the tag release)");
  const lensList =
    view === "raw"
      ? []
      : (o.lens ?? efs.lens.default).principals.map((p) => lower(p) as PrincipalId);
  if (view !== "raw" && lensList.length === 0) throw misuse("a Lens names at least one principal");
  const query = keccak256(
    utf8Encode(
      JSON.stringify([
        "efs-sdk/topic-cursor/1",
        view,
        id,
        o.below === true,
        lensList,
        o.sample ?? 0,
      ]),
    ),
  );
  if (o.cursor && (o.cursor.v !== 1 || o.cursor.query !== query))
    throw misuse("this cursor belongs to another listing (view, place, below, Lens or sample)");
  const b = bounds(efs);
  const ptl = b.pageTimesLens;
  const perLens =
    view === "mine"
      ? o.below
        ? ptl.mineBelow
        : ptl.mineExact
      : o.below
        ? ptl.everyoneBelow
        : ptl.everyoneExact;
  const L = Math.max(1, lensList.length);
  const callEntries = Math.max(1, Math.min(b.limitEntries, Math.floor(perLens / L)));
  const rowsWanted = Math.max(1, o.rows ?? 50);
  const entriesWanted = Math.max(1, o.entries ?? 4 * callEntries);
  const none: Evidence = { attempts: [], requests: 0 };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.topicPage",
      status: "UNKNOWN",
      view,
      place: id,
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence ?? none,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  type Out =
    | {
        kind: "page";
        rows: TopicRow[];
        scan: ScanStatus;
        next: Hex;
        complete: boolean;
        dropped: number;
        seen: Hex[];
        bounded: boolean;
        counts: {
          scanned: number;
          rawTotal: bigint;
          positionsEver: bigint;
          repeatsSkipped: number;
          calls: number;
        };
      }
    | { kind: "refused"; status: "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s: Session) => {
      const seenList: Hex[] = [...(o.cursor?.seen ?? [])];
      const seen = new Set<string>(seenList);
      let bounded = o.cursor?.bounded ?? false;
      let next: Hex = o.cursor?.next ?? "0x";
      const rows: TopicRow[] = [];
      let read = 0;
      let calls = 0;
      let dropped = 0;
      let scan: ScanStatus = "LIMIT";
      let complete = false;
      const counts = { scanned: 0, rawTotal: 0n, positionsEver: 0n, repeatsSkipped: 0, calls: 0 };
      while (calls < MAX_CALLS) {
        const limit = Math.min(callEntries, entriesWanted - read);
        const maxRows = Math.min(b.maxRows, rowsWanted - rows.length);
        if (limit <= 0 || maxRows <= 0) break;
        const call =
          view === "mine"
            ? callOf(reader, topicMineReaderAbi, "mine", [
                lensList,
                id,
                o.below === true,
                EMPTY_BASIS,
                next,
                limit,
                maxRows,
                GAS_RESERVE,
              ])
            : callOf(reader, topicEveryoneReaderAbi, "everyone", [
                {
                  purpose: PURPOSES.tag,
                  place: id,
                  below: o.below === true,
                  raw: view === "raw",
                  sample: o.sample ?? 0,
                },
                lensList,
                EMPTY_BASIS,
                next,
                limit,
                maxRows,
                GAS_RESERVE,
              ]);
        ctx.requests += 1;
        const [out] = await callsAt(s, basis.blockHash, [call]);
        const fn = view === "mine" ? "mine" : "everyone";
        const abi = view === "mine" ? topicMineReaderAbi : topicEveryoneReaderAbi;
        const dec = decoded<[RawInfo, readonly (RawMine | RawPlace)[]]>(abi, fn, out);
        if (!dec.ok) return dec;
        const [info, raw] = dec.value;
        const refused = refusal(Number(info.q.status));
        if (refused) return { ok: true, value: { kind: "refused", ...refused } };
        calls++;
        const st = SCAN[Number(info.scanStatus)];
        if (!st)
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", "an unknown scan status"),
          };
        if (st !== "EXHAUSTED" && (info.next === "0x" || info.next.length <= 2))
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason(
              "RPC_ERROR",
              "transient",
              "a page that is not the end gave no resume point",
            ),
          };
        if (Number(info.scanned) === 0 && st !== "EXHAUSTED")
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", "a page read nothing and did not end"),
          };
        if (
          calls === 1 &&
          !o.cursor &&
          st === "EXHAUSTED" &&
          info.completeFromOrigin &&
          Number(info.listingCoverage) === 3
        )
          complete = true;
        read += Number(info.scanned);
        counts.scanned += Number(info.scanned);
        counts.rawTotal = BigInt(info.rawTotal);
        counts.positionsEver = BigInt(info.positionsEver);
        counts.repeatsSkipped += Number(info.repeatsSkipped);
        for (const x of raw) {
          const thing = lower(x.thing);
          if (seen.has(thing)) {
            dropped++;
            continue;
          }
          seen.add(thing);
          seenList.push(thing);
          rows.push(rowOf(view, x, lensList));
        }
        scan = st;
        next = st === "EXHAUSTED" ? "0x" : info.next;
        if (st === "EXHAUSTED") break;
      }
      if (seenList.length > SEEN_MAX) {
        bounded = true;
        seenList.splice(0, seenList.length - SEEN_MAX);
      }
      counts.calls = calls;
      return {
        ok: true,
        value: {
          kind: "page",
          rows,
          scan,
          next,
          complete,
          dropped,
          seen: seenList,
          bounded,
          counts,
        },
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return {
      kind: "efs.topicPage",
      status: "UNKNOWN",
      view,
      place: id,
      reason: r.reason,
      basis,
      evidence,
    };
  const v = r.value;
  if (v.kind === "refused")
    return {
      kind: "efs.topicPage",
      status: v.status,
      view,
      place: id,
      reason: v.reason,
      basis,
      evidence,
    };
  const finished = v.scan === "EXHAUSTED";
  return {
    kind: "efs.topicPage",
    status: "PRESENT",
    view,
    place: id,
    rows: v.rows,
    finished,
    scan: v.scan,
    ...(finished ? {} : { next: { v: 1, query, next: v.next, seen: v.seen, bounded: v.bounded } }),
    coverage: v.complete ? "COMPLETE" : "PARTIAL",
    dedup: { state: v.bounded ? "BOUNDED" : "COMPLETE", dropped: v.dropped },
    counts: v.counts,
    basis,
    evidence,
  };
}

function rowOf(view: TopicView, x: RawMine | RawPlace, lens: readonly PrincipalId[]): TopicRow {
  const base = {
    thing: lower(x.thing),
    topic: lower(x.topic),
    position: lower(x.position),
    entry: BigInt(x.bindingOrdinal),
  };
  if (view === "mine") {
    const m = x as RawMine;
    return {
      ...base,
      number: Number(m.number),
      decider: {
        kind: "lens",
        index: Number(m.decider),
        author: lower(m.principalId) as PrincipalId,
        number: Number(m.number),
      },
    };
  }
  const p = x as RawPlace;
  const decider: Decider =
    view === "raw"
      ? { kind: "none" }
      : Number(p.decider) === NO_DECIDER
        ? { kind: "public" }
        : {
            kind: "lens",
            index: Number(p.decider),
            author: (lens[Number(p.decider)] ?? "0x") as PrincipalId,
            number: Number(p.number),
          };
  return {
    ...base,
    number: Number(p.number),
    decider,
    statements: BigInt(p.statements),
    yes: BigInt(p.yes),
    ...(Number(p.sampled) > 0
      ? {
          sample: {
            sampled: Number(p.sampled),
            yes: Number(p.sampleYes),
            no: Number(p.sampleNo),
            incomplete: p.incomplete,
          },
        }
      : {}),
  };
}

// ---- the lookups

export interface PlacesOpts extends CallOpts {
  /** Rows per call (default 32, at most 64). */
  limit?: number;
  cursor?: { v: 1; query: Hex; next: Hex };
  /** tagsOf: the newest authors sampled per row (default 0). */
  sample?: number;
  /** topicChildren: folds each listed word, skipping (and counting) one that is not its own fold. */
  fold?: FoldStep;
}

/** One place a thing is filed at (tagsOf): the row of `everyone` with no Lens, rows nobody says yes to included. */
export interface FiledRow {
  topic: Hex;
  position: Hex;
  statements: bigint;
  yes: bigint;
  /** Someone says yes there now: the row Everyone would show unless a Lens author hides it. */
  shown: boolean;
  sample?: { sampled: number; yes: number; no: number; incomplete: boolean };
}
/** A place of a directory (children, word page): its counts are "about" figures, never row counts. */
export interface PlaceCountRow {
  topic: Hex;
  /** The place's own word (children; the word page's word), when it was read. */
  word?: string;
  /** The admission of its first registration. */
  registeredAt: bigint;
  positionsEver: bigint;
  positionsEverBelow: bigint;
  filings: bigint;
  filingsBelow: bigint;
}

export type LookupPage<R> =
  | {
      kind: "efs.lookupPage";
      status: "PRESENT";
      rows: readonly R[];
      finished: boolean;
      next?: { v: 1; query: Hex; next: Hex };
      /** Rows left out, and why (topicChildren with a fold: a word that is not its own fold). */
      skipped: { notOwnFold: number };
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.lookupPage";
      status: "UNKNOWN" | "INVALID";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

type RawCount = {
  place: Hex;
  admission: bigint;
  positionsEver: bigint;
  positionsEverBelow: bigint;
  filings: bigint;
  filingsBelow: bigint;
};

async function paged<R, X>(
  efs: Efs,
  fn: "about" | "children" | "wordPage",
  key: Hex,
  o: PlacesOpts,
  shape: (
    s: Session,
    basis: Basis,
    ctx: Ctx,
    rows: readonly X[],
  ) => Promise<Step<{ rows: R[]; notOwnFold: number }>>,
): Promise<LookupPage<R>> {
  const d = efs.deployment;
  const lookup = d.readers.topicLookup;
  if (!lookup)
    throw misuse("this deployment names no topic lookup reader (it predates the tag release)");
  const query = keccak256(
    utf8Encode(JSON.stringify(["efs-sdk/topic-lookup/1", fn, key, o.sample ?? 0])),
  );
  if (o.cursor && (o.cursor.v !== 1 || o.cursor.query !== query))
    throw misuse("this cursor belongs to another lookup");
  const limit = Math.max(1, Math.min(64, o.limit ?? 32));
  const none: Evidence = { attempts: [], requests: 0 };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.lookupPage",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence ?? none,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  type Out =
    | { kind: "page"; rows: R[]; finished: boolean; next: Hex; notOwnFold: number }
    | { kind: "refused"; status: "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s) => {
      const cont = o.cursor?.next ?? "0x";
      const args =
        fn === "about"
          ? [key, o.sample ?? 0, EMPTY_BASIS, cont, limit]
          : [key, EMPTY_BASIS, cont, limit];
      ctx.requests += 1;
      const [out] = await callsAt(s, basis.blockHash, [
        callOf(lookup, topicLookupReaderAbi, fn, args),
      ]);
      const dec = decoded<[RawInfo, readonly X[]]>(topicLookupReaderAbi, fn, out);
      if (!dec.ok) return dec;
      const [info, raw] = dec.value;
      const refused = refusal(Number(info.q.status));
      if (refused) return { ok: true, value: { kind: "refused", ...refused } };
      const st = SCAN[Number(info.scanStatus)];
      if (!st)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", "an unknown scan status"),
        };
      const shaped = await shape(s, basis, ctx, raw);
      if (!shaped.ok) return shaped;
      return {
        ok: true,
        value: {
          kind: "page",
          rows: shaped.value.rows,
          finished: st === "EXHAUSTED",
          next: info.next,
          notOwnFold: shaped.value.notOwnFold,
        },
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return { kind: "efs.lookupPage", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const v = r.value;
  if (v.kind === "refused")
    return { kind: "efs.lookupPage", status: v.status, reason: v.reason, basis, evidence };
  return {
    kind: "efs.lookupPage",
    status: "PRESENT",
    rows: v.rows,
    finished: v.finished,
    ...(v.finished ? {} : { next: { v: 1, query, next: v.next } }),
    skipped: { notOwnFold: v.notOwnFold },
    basis,
    evidence,
  };
}

/** Every place a thing is filed at (TAG), either sign, newest first, each with its exact yes-count; no Lens. */
export function tagsOf(efs: Efs, thing: Hex, o: PlacesOpts = {}): Promise<LookupPage<FiledRow>> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(thing))
    throw misuse("a thing is 32 bytes of hex (an id, or a padded address)");
  return paged<FiledRow, RawPlace>(efs, "about", lower(thing), o, async (_s, _b, _c, rows) => ({
    ok: true,
    value: {
      rows: rows.map((p) => ({
        topic: lower(p.topic),
        position: lower(p.position),
        statements: BigInt(p.statements),
        yes: BigInt(p.yes),
        shown: BigInt(p.yes) > 0n,
        ...(Number(p.sampled) > 0
          ? {
              sample: {
                sampled: Number(p.sampled),
                yes: Number(p.sampleYes),
                no: Number(p.sampleNo),
                incomplete: p.incomplete,
              },
            }
          : {}),
      })),
      notOwnFold: 0,
    },
  }));
}

const countRow = (c: RawCount, word?: string): PlaceCountRow => ({
  topic: lower(c.place),
  ...(word !== undefined ? { word } : {}),
  registeredAt: BigInt(c.admission),
  positionsEver: BigInt(c.positionsEver),
  positionsEverBelow: BigInt(c.positionsEverBelow),
  filings: BigInt(c.filings),
  filingsBelow: BigInt(c.filingsBelow),
});

/** Bodies of records, at the basis: a path record's (parent, word page) or a word page's word. */
async function bodies(
  s: Session,
  basis: Basis,
  ctx: Ctx,
  ids: readonly Hex[],
  length: number,
): Promise<Step<Uint8Array[]>> {
  if (ids.length === 0) return { ok: true, value: [] };
  const d = ctx.efs.deployment;
  ctx.requests += ids.length;
  const outs = await callsAt(
    s,
    basis.blockHash,
    ids.map((id) =>
      callOf(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [d.ledger, id, 0, length]),
    ),
  );
  const res: Uint8Array[] = [];
  for (const out of outs) {
    const b = decoded<[number, Hex]>(ledgerReadsAbi, "bodySlice", out);
    if (!b.ok) return b;
    if (chainStatus(b.value[0]) !== "PRESENT")
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", "a listed topic has no record"),
      };
    res.push(hexToBytes(b.value[1]));
  }
  return { ok: true, value: res };
}
const decodeWord = (b: Uint8Array): string | null => {
  const c = checkWord(b);
  return c.ok ? (decodeScalars(b)?.text ?? null) : null;
};

/**
 * A topic's child topics, newest first, each with its own word (read from its path record and word page and checked
 * against the parent) and its counts. With `fold`, a child whose word is not its own fold is left out and counted.
 */
export function topicChildren(
  efs: Efs,
  place: TopicPlace,
  o: PlacesOpts = {},
): Promise<LookupPage<PlaceCountRow>> {
  const { id, topic } = placeId(efs, place, o.fold);
  if (!topic) throw misuse("a home has no child topics");
  return paged<PlaceCountRow, RawCount>(efs, "children", id, o, async (s, basis, ctx, rows) => {
    const recs = await bodies(
      s,
      basis,
      ctx,
      rows.map((c) => c.place),
      64,
    );
    if (!recs.ok) return recs;
    const pages = recs.value.map((b) => (b.length === 64 ? bytesToHex(b.subarray(32, 64)) : null));
    for (const [i, b] of recs.value.entries()) {
      const parent = b.length === 64 ? lower(bytesToHex(b.subarray(0, 32))) : null;
      if (parent !== id || pages[i] === null)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "RPC_ERROR",
            "transient",
            "a listed child's record does not name this parent",
          ),
        };
    }
    const words = await bodies(s, basis, ctx, pages as Hex[], 255);
    if (!words.ok) return words;
    const out: PlaceCountRow[] = [];
    let notOwnFold = 0;
    for (const [i, c] of rows.entries()) {
      const w = decodeWord(words.value[i] as Uint8Array);
      if (w === null)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", "a listed word breaks the grammar"),
        };
      if (o.fold) {
        const f = o.fold(w);
        if (!f.ok || f.word !== w) {
          notOwnFold++;
          continue;
        }
      }
      out.push(countRow(c, w));
    }
    return { ok: true, value: { rows: out, notOwnFold } };
  });
}

/** Every place whose own word is `word`: its root topic /<word> first, then each registered path ending in it. */
export function wordPage(
  efs: Efs,
  word: string,
  o: PlacesOpts = {},
): Promise<LookupPage<PlaceCountRow>> {
  let w = word;
  if (o.fold) {
    const f = o.fold(word);
    if (!f.ok) throw misuse(`the word does not fold (${f.rule})`);
    w = f.word;
  }
  const page = wordPageId(topicTypesOf(efs.deployment), w);
  return paged<PlaceCountRow, RawCount>(efs, "wordPage", page, o, async (_s, _b, _c, rows) => ({
    ok: true,
    value: { rows: rows.map((c) => countRow(c, w)), notOwnFold: 0 },
  }));
}

export type TopicPathResult =
  | {
      kind: "efs.topicPath";
      status: "PRESENT";
      words: readonly string[];
      ids: readonly TopicId[];
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.topicPath";
      status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID";
      reason?: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

/** A topic's words, root first, read from its path records (at most 64 levels). */
export async function topicPath(efs: Efs, id: Hex, o: CallOpts = {}): Promise<TopicPathResult> {
  const t = topicTypesOf(efs.deployment);
  const none: Evidence = { attempts: [], requests: 0 };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.topicPath",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence ?? none,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const d = efs.deployment;
  const r = await onEndpoint<{ words: string[]; ids: TopicId[] } | null>(
    efs._internal.pool,
    async (s) => {
      const words: string[] = [];
      const ids: TopicId[] = [];
      let at = lower(id);
      for (let depth = 0; depth < 64; depth++) {
        ctx.requests += 1;
        const [rec] = await callsAt(s, basis.blockHash, [
          callOf(d.readers.ledgerReads, ledgerReadsAbi, "record", [d.ledger, at]),
        ]);
        const h = decoded<[number, { typeId: Hex }]>(ledgerReadsAbi, "record", rec);
        if (!h.ok) return h;
        const st = chainStatus(h.value[0]);
        if (st === "ABSENT_PROVEN") return { ok: true, value: null };
        if (st !== "PRESENT")
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", `record (${st})`),
          };
        const typeId = lower(h.value[1].typeId);
        ids.unshift(at as TopicId);
        if (typeId === t.word) {
          const b = await bodies(s, basis, ctx, [at], 255);
          if (!b.ok) return b;
          const w = decodeWord(b.value[0] as Uint8Array);
          if (w === null)
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason("RPC_ERROR", "transient", "a word page breaks the grammar"),
            };
          words.unshift(w);
          return { ok: true, value: { words, ids } };
        }
        if (typeId !== t.path) return { ok: true, value: { words: [], ids: [] } };
        const b = await bodies(s, basis, ctx, [at], 64);
        if (!b.ok) return b;
        const body = b.value[0] as Uint8Array;
        const parent = lower(bytesToHex(body.subarray(0, 32)));
        const page = lower(bytesToHex(body.subarray(32, 64)));
        const wb = await bodies(s, basis, ctx, [page], 255);
        if (!wb.ok) return wb;
        const w = decodeWord(wb.value[0] as Uint8Array);
        if (w === null)
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", "a word page breaks the grammar"),
          };
        words.unshift(w);
        at = parent;
      }
      return {
        ok: false,
        retryElsewhere: false,
        reason: reason("LIMIT_EXCEEDED", "never", "a topic deeper than 64 words"),
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { kind: "efs.topicPath", status: "UNKNOWN", reason: r.reason, basis, evidence };
  if (r.value === null) return { kind: "efs.topicPath", status: "ABSENT_PROVEN", basis, evidence };
  if (r.value.words.length === 0)
    return {
      kind: "efs.topicPath",
      status: "INVALID",
      reason: reason("UNSUPPORTED_PROFILE", "never", "not a topic record"),
      basis,
      evidence,
    };
  // The words must give back the id: a check against an endpoint that answers another path.
  if (pathId(t, r.value.words) !== lower(id))
    return {
      kind: "efs.topicPath",
      status: "UNKNOWN",
      reason: reason("RPC_ERROR", "transient", "the words do not give back this topic's id"),
      basis,
      evidence,
    };
  return {
    kind: "efs.topicPath",
    status: "PRESENT",
    words: r.value.words,
    ids: r.value.ids,
    basis,
    evidence,
  };
}

export type CountResult<C> =
  | ({
      kind: "efs.topicCount";
      status: "PRESENT";
      coverage: "COMPLETE" | "PARTIAL";
      basis: Basis;
      evidence: Evidence;
    } & C)
  | {
      kind: "efs.topicCount";
      status: "UNKNOWN" | "INVALID";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

async function counted<C>(
  efs: Efs,
  fn: "placeCount" | "authorCount",
  args: readonly unknown[],
  shape: (a: bigint, b: bigint) => C,
  o: CallOpts,
): Promise<CountResult<C>> {
  const lookup = efs.deployment.readers.topicLookup;
  if (!lookup)
    throw misuse("this deployment names no topic lookup reader (it predates the tag release)");
  const none: Evidence = { attempts: [], requests: 0 };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.topicCount",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence ?? none,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint<[{ status: number }, number, bigint, bigint]>(
    efs._internal.pool,
    async (s) => {
      ctx.requests += 1;
      const [out] = await callsAt(s, basis.blockHash, [
        callOf(lookup, topicLookupReaderAbi, fn, args),
      ]);
      return decoded<[{ status: number }, number, bigint, bigint]>(topicLookupReaderAbi, fn, out);
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return { kind: "efs.topicCount", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const [q, coverage, a, b] = r.value;
  const refused = refusal(Number(q.status));
  if (refused) return { kind: "efs.topicCount", ...refused, basis, evidence };
  if (Number(coverage) === 1)
    return {
      kind: "efs.topicCount",
      status: "UNKNOWN",
      reason: reason("NOT_YET_DECIDABLE", "transient", "the index can't vouch for this count yet"),
      basis,
      evidence,
    };
  return {
    kind: "efs.topicCount",
    status: "PRESENT",
    coverage: Number(coverage) === 3 ? "COMPLETE" : "PARTIAL",
    basis,
    evidence,
    ...shape(BigInt(a), BigInt(b)),
  };
}

/**
 * A place's two counts: `positionsEver`, the distinct things ever filed there (or below it), shown as "about N"
 * (it includes things nobody says yes to now, so it is never the number of rows Everyone returns), and `filings`.
 */
export function placeCount(
  efs: Efs,
  place: TopicPlace,
  o: CallOpts & { below?: boolean; fold?: FoldStep } = {},
): Promise<CountResult<{ positionsEver: bigint; filings: bigint }>> {
  const { id, topic } = placeId(efs, place, o.fold);
  if (o.below && !topic) throw misuse("a home has nothing below it");
  return counted(
    efs,
    "placeCount",
    [PURPOSES.tag, id, o.below === true, EMPTY_BASIS],
    (a, b) => ({ positionsEver: a, filings: b }),
    o,
  );
}

/** A (place, thing) pair's two counts: the authors who ever stated anything there, and how many say yes now. */
export function authorCount(
  efs: Efs,
  place: TopicPlace,
  thing: Hex,
  o: CallOpts & { fold?: FoldStep } = {},
): Promise<CountResult<{ statements: bigint; yes: bigint }>> {
  const { id } = placeId(efs, place, o.fold);
  const position = positionKey(PURPOSES.tag, id, lower(thing));
  return counted(
    efs,
    "authorCount",
    [position, EMPTY_BASIS],
    (a, b) => ({ statements: a, yes: b }),
    o,
  );
}
