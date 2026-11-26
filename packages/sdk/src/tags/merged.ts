// SPDX-License-Identifier: MIT
// topicItemsMerged: a topic's items together with its Lens's synonyms (tag spec 3.5), at one block a page.
//   The lists: the topic itself, the places the Lens says are the same (topicSynonyms, nearest first), and, for a
//   path of two or more words, its word swaps (each word replaced by one of its word-level synonyms: one swap is one
//   hop, as one path-level synonym is), registered paths only, nearest first and last word first, at most 4 hops and
//   16 lists. Synonyms come only from the Lens (Mine and Everyone alike), never from the public tier, so a stranger
//   can't merge a topic into anyone's view. Raw reads no Lens, so it has no merged view.
//   The merge: every row's `entry` is a binding ordinal from one global counter, unique across lists, and every list
//   is stored in rising order, so the lists merge newest first on it. Each list keeps a floor F (every row of it newer
//   than F has been read); the newest buffered row is decided once no unfinished list's floor is above it, and only
//   the lists that block it are read again. A list's entries must strictly fall, within a call and across calls.
//   Dedupe: one set of things across every list and page; a thing is marked seen only when it shows, so the newest
//   filing that shows wins and names its list (`via`).
//   The viewed topic (spec 3.1's one walk, with the viewed topic as the viewed place): a row from a synonym list is
//   hidden when any of lens[0..decider] (the whole Lens for a public-tier row) has a MASKED head at (viewed topic,
//   thing). The topic's own list needs nothing: its reader already asked. A COMPLETE zero from authorCount there
//   (nobody ever stated anything) skips the heads; any other count asks them. A hidden row is never marked seen.
//   A synonym list the chain refuses is named in `missing` (never retried in this listing); the page stays PRESENT
//   with coverage PARTIAL and `complete: false`. The topic's own list refused, or any list's basis gone stale, is the
//   page's own status.
import { decodeFunctionResult, keccak256 } from "viem";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, lower, type PrincipalId, uniquePrincipals } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import { type Ctx, EMPTY_BASIS, type Evidence } from "../files/bytes.js";
import {
  ledgerViewsAbi,
  topicEveryoneReaderAbi,
  topicLookupReaderAbi,
  topicMineReaderAbi,
} from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import type { FoldStep } from "../names/links.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus } from "../protocol/status.js";
import { badReply, callOf, decoded, READ_IDS } from "./plan.js";
import {
  bounds,
  chainsBelow,
  GAS_RESERVE,
  hiddenBelow,
  type Kinded,
  kindsOf,
  kindsQuery,
  MAX_BACKOFFS,
  NO_DECIDER,
  placeId,
  type RawInfo,
  type RawMine,
  type RawPlace,
  refusal,
  rowFault,
  rowOf,
  SCAN,
  type ScanStatus,
  SEEN_MAX,
  type ThingKind,
  type TopicPlace,
  type TopicRow,
} from "./read.js";
import { topicSynonyms } from "./synonyms.js";
import { pathId, topicTypesOf } from "./topics.js";

/** How a list joined the merge: the topic itself, a "same" the Lens states, or a word swap of the topic's path. */
export type MergedHow = "self" | "same" | "swap";
/** A list of the merge: its place, how it joined, and how many hops from the topic. */
export interface MergedList {
  place: Hex;
  how: MergedHow;
  hops: number;
}
/** A list the chain refused: named, so the client can say "N synonyms couldn't be read". */
export interface MissingList extends MergedList {
  status: "UNKNOWN" | "INVALID";
  reason: Reason;
}
export interface MergedRow extends TopicRow {
  /** The list the row came from (the newest filing that shows, when a thing is in several). */
  via: MergedList;
}

/** Continues a merged listing: the frozen list set, each list's resume point, and the things already decided. */
export interface MergedCursor {
  v: 1;
  kind: "efs.mergedCursor";
  query: Hex;
  lists: readonly (MergedList & {
    /** The chain continuation to read from ("0x": the list's origin), or null when the list is finished. */
    next: Hex | null;
    missing?: { status: "UNKNOWN" | "INVALID"; reason: Reason };
  })[];
  /** The entry of the last row decided (decimal): on resume, rows at or above it are left out (already decided). */
  shownTo: string | null;
  seen: readonly Hex[];
  bounded: boolean;
  synonyms: { limited: boolean; complete: boolean };
}

export interface MergedItemsOpts extends CallOpts {
  /** Default "everyone". Raw has no merged view (no Lens, so no synonyms). */
  view?: "mine" | "everyone";
  lens?: Lens;
  below?: boolean;
  /** Rows wanted on this page (default 50). */
  rows?: number;
  /** List entries this page may read at most, across its lists (default: 4 × the per-call entry bound). */
  entries?: number;
  cursor?: MergedCursor;
  sample?: number;
  fold?: FoldStep;
  kinds?: readonly ThingKind[];
  kindsExact?: boolean;
  /** How far the synonym set reaches: hops 1 to 4 (default 4), lists 1 to 16 with the topic (default 16), and the
   *  newest entries topicSynonyms reads per list, 1 to 16 (default 16). Read on the first page only. */
  synonyms?: { maxHops?: number; maxLists?: number; scan?: number };
}

export type MergedPage =
  | {
      kind: "efs.mergedTopicPage";
      status: "PRESENT";
      view: "mine" | "everyone";
      place: Hex;
      rows: readonly MergedRow[];
      /** Every readable list ended. A short or empty page with `finished: false` means "read on with `next`". */
      finished: boolean;
      next?: MergedCursor;
      /** The merge's lists, the topic first. */
      lists: readonly MergedList[];
      /** Lists the chain refused: always present (empty when every list was read). Non-empty means some synonyms'
       *  rows are not shown, and the client must say so. */
      missing: readonly MissingList[];
      /** No list is missing and the synonym set itself is complete (no bound cut it). */
      complete: boolean;
      coverage: "COMPLETE" | "PARTIAL";
      synonyms: { limited: boolean; complete: boolean };
      dedup: { state: "COMPLETE" | "BOUNDED"; dropped: number };
      counts: {
        scanned: number;
        calls: number;
        rounds: number;
        hiddenByChild: number;
        /** Rows from synonym lists hidden by a Lens author's "not this" at the viewed topic. */
        hiddenAtViewed: number;
        filtered: number;
        backoffs: number;
      };
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.mergedTopicPage";
      status: "UNKNOWN" | "INVALID";
      view: "mine" | "everyone";
      place: Hex;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

const MAX_HOPS = 4;
const MAX_LISTS = 16;
/** Read rounds a page makes at most (each one batch of list calls). */
const MAX_ROUNDS = 8;
/** List calls a page makes at most, across its rounds. */
const MAX_LIST_CALLS = 32;
/** Word-swap paths considered at most (nearest first): one records call checks which are registered. */
const MAX_SWAPS = READ_IDS;
/** Swap combinations walked at most before the set is reported `limited`. */
const MAX_SWAP_WALK = 1024;

/** Evidence as it is gathered (attempts appended). */
type Tally = { attempts: Evidence["attempts"][number][]; requests: number };
type Pending = {
  row: Omit<TopicRow, "kind" | "typeId">;
  list: number;
};

/**
 * A topic's items with its Lens's synonyms, merged newest first: see the header. The page laws are topicItems': a
 * short or empty page with `finished: false` means "read on", and only every list's end finishes the listing.
 */
export async function topicItemsMerged(
  efs: Efs,
  place: TopicPlace,
  o: MergedItemsOpts = {},
): Promise<MergedPage> {
  const view = o.view ?? "everyone";
  if (view !== "mine" && view !== "everyone")
    throw misuse("the merged view needs a Lens: Mine or Everyone (Raw has no synonyms)");
  const { id, topic } = placeId(efs, place, o.fold);
  if (!topic) throw misuse("a home has no synonyms: read it with topicItems");
  const d = efs.deployment;
  const reader = view === "mine" ? d.readers.topicMine : d.readers.topicEveryone;
  if (!reader) throw misuse("this deployment names no topic readers (it predates the tag release)");
  const lensList = uniquePrincipals((o.lens ?? efs.lens.default).principals);
  if (lensList.length === 0) throw misuse("a Lens names at least one principal");
  const { filter, exact } = kindsQuery(o);
  const maxHops = o.synonyms?.maxHops ?? MAX_HOPS;
  const maxLists = o.synonyms?.maxLists ?? MAX_LISTS;
  const scanEach = o.synonyms?.scan ?? 16;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_HOPS)
    throw misuse(`synonyms.maxHops is 1 to ${MAX_HOPS}`);
  if (!Number.isInteger(maxLists) || maxLists < 1 || maxLists > MAX_LISTS)
    throw misuse(`synonyms.maxLists is 1 to ${MAX_LISTS}`);
  const below = o.below === true;
  const sample = o.sample ?? 0;
  const queryOf = (lists: readonly MergedList[]) =>
    keccak256(
      utf8Encode(
        JSON.stringify([
          "efs-sdk/merged-cursor/1",
          view,
          id,
          below,
          lensList,
          sample,
          filter ? { kinds: filter, exact } : null,
          lists.map((l) => [l.place, l.how, l.hops]),
        ]),
      ),
    );
  const evidence: Tally = { attempts: [], requests: 0 };
  const fail = (status: "UNKNOWN" | "INVALID", why: Reason, basis?: Basis): MergedPage => ({
    kind: "efs.mergedTopicPage",
    status,
    view,
    place: id,
    reason: why,
    ...(basis ? { basis } : {}),
    evidence,
  });

  // ---- the list set: frozen in the cursor, or gathered now
  let lists: MergedList[];
  let synonyms: { limited: boolean; complete: boolean };
  if (o.cursor) {
    const c = o.cursor;
    if (
      c.v !== 1 ||
      c.kind !== "efs.mergedCursor" ||
      !Array.isArray(c.lists) ||
      c.lists.length === 0 ||
      c.lists[0]?.how !== "self" ||
      lower(c.lists[0].place) !== id ||
      c.query !== queryOf(c.lists)
    )
      throw misuse(
        "this cursor belongs to another listing (view, place, below, Lens, sample, kinds or lists)",
      );
    lists = c.lists.map((l) => ({ place: lower(l.place), how: l.how, hops: l.hops }));
    synonyms = c.synonyms;
  } else {
    const g = await gather(efs, place, id, lensList, maxHops, maxLists, scanEach, o);
    evidence.attempts.push(...g.evidence.attempts);
    evidence.requests += g.evidence.requests;
    if (!g.ok) return fail(g.status, g.reason, g.basis);
    lists = g.lists;
    synonyms = { limited: g.limited, complete: g.complete };
  }
  const query = queryOf(lists);

  // ---- the merge
  const b = bounds(efs);
  const ptl = b.pageTimesLens;
  const perLens =
    view === "mine"
      ? below
        ? ptl.mineBelow
        : ptl.mineExact
      : below
        ? ptl.everyoneBelow
        : ptl.everyoneExact;
  const callEntries = Math.max(1, Math.min(b.limitEntries, Math.floor(perLens / lensList.length)));
  const rowsWanted = Math.max(1, o.rows ?? 50);
  const entriesWanted = Math.max(1, o.entries ?? 4 * callEntries);
  const pin = await efs.at("latest", o);
  evidence.attempts.push(...pin.evidence.attempts);
  if (pin.status !== "VERIFIED")
    return fail(
      "UNKNOWN",
      pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    );
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const shownTo0 = o.cursor?.shownTo ?? null;
  if (shownTo0 !== null && (typeof shownTo0 !== "string" || !/^[0-9]{1,20}$/.test(shownTo0)))
    throw misuse("this cursor's shownTo is not an entry");
  const shownFrom = shownTo0 === null ? null : BigInt(shownTo0);
  type Out =
    | {
        kind: "page";
        rows: MergedRow[];
        cursorLists: MergedCursor["lists"][number][];
        missing: MissingList[];
        finished: boolean;
        complete: boolean;
        shownTo: bigint | null;
        seen: Hex[];
        bounded: boolean;
        dropped: number;
        counts: Extract<MergedPage, { status: "PRESENT" }>["counts"];
      }
    | { kind: "refused"; status: "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s: Session) => {
      type State = {
        next: Hex;
        done: boolean;
        missing: { status: "UNKNOWN" | "INVALID"; reason: Reason } | null;
        /** Every row of this list newer than `floor` has been read (null: nothing read yet). */
        floor: bigint | null;
        buffer: Pending[];
        /** The continuation the oldest call with undecided rows started from. */
        resumeFrom: Hex | null;
        lastEntry: bigint | null;
        entryCap: number;
        rowCap: number;
        calls: number;
        completeCall: boolean;
      };
      const st: State[] = lists.map((_, i) => {
        const c = o.cursor?.lists[i];
        return {
          next: c?.next ?? "0x",
          done: c !== undefined && c.next === null && !c.missing,
          missing: c?.missing ?? null,
          floor: null,
          buffer: [],
          resumeFrom: null,
          lastEntry: null,
          entryCap: callEntries,
          rowCap: b.maxRows,
          calls: 0,
          completeCall: false,
        };
      });
      const seenList: Hex[] = [...(o.cursor?.seen ?? [])];
      const seen = new Set<string>(seenList);
      let bounded = o.cursor?.bounded ?? false;
      const rows: MergedRow[] = [];
      const unkinded: { pending: Pending; at: number }[] = [];
      let shownTo: bigint | null = shownFrom;
      let dropped = 0;
      let read = 0;
      let listCalls = 0;
      let rounds = 0;
      let backoffs = 0;
      const counts = {
        scanned: 0,
        calls: 0,
        rounds: 0,
        hiddenByChild: 0,
        hiddenAtViewed: 0,
        filtered: 0,
        backoffs: 0,
      };
      const parents = new Map<string, Hex>();
      const decided = new Map<string, boolean>();
      const active = () => st.filter((x) => !x.done && !x.missing);
      const shown = () => rows.length + unkinded.length;

      /** The newest buffered row (ties: the earlier list), or null. */
      const head = (): { i: number; p: Pending } | null => {
        let best: { i: number; p: Pending } | null = null;
        for (const [i, x] of st.entries()) {
          const p = x.buffer[0];
          if (p && (!best || p.row.entry > best.p.row.entry)) best = { i, p };
        }
        return best;
      };
      const blocks = (x: State, entry: bigint) => x.floor === null || x.floor > entry;

      /** Decide every row that is safe to decide, up to the rows wanted. */
      const emit = async (): Promise<Step<void>> => {
        while (shown() < rowsWanted) {
          const batch: Pending[] = [];
          for (;;) {
            const h = head();
            if (!h) break;
            if (active().some((x) => blocks(x, h.p.row.entry))) break;
            (st[h.i] as State).buffer.shift();
            batch.push(h.p);
            if (batch.length >= rowsWanted - shown()) break;
          }
          for (const x of st) if (x.buffer.length === 0) x.resumeFrom = null;
          if (batch.length === 0) return { ok: true, value: undefined };
          // Rows from synonym lists, not already seen: asked at the viewed topic.
          const ask = batch.filter((p) => p.list !== 0 && !seen.has(p.row.thing));
          const hidden = await viewedHidden(s, basis, ctx, id, lensList, ask);
          if (!hidden.ok) return hidden;
          const keep: Pending[] = [];
          for (const p of batch) {
            shownTo = p.row.entry;
            if (seen.has(p.row.thing)) {
              dropped++;
              continue;
            }
            // Hidden at the viewed topic: never marked seen, so an older filing that shows can still appear.
            if (hidden.value.has(p)) {
              counts.hiddenAtViewed++;
              continue;
            }
            seen.add(p.row.thing);
            seenList.push(p.row.thing);
            keep.push(p);
          }
          if (filter) {
            const k = await kindsOf(
              s,
              basis,
              ctx,
              keep.map((p) => p.row.thing),
              exact,
            );
            if (!k.ok) return k;
            for (const p of keep) {
              const got = k.value.get(p.row.thing) as Kinded;
              if (filter.includes(got.kind))
                rows.push({ ...p.row, ...got, via: lists[p.list] as MergedList });
              else counts.filtered++;
            }
          } else for (const p of keep) unkinded.push({ pending: p, at: unkinded.length });
        }
        return { ok: true, value: undefined };
      };

      for (; rounds < MAX_ROUNDS; ) {
        const e = await emit();
        if (!e.ok) return e;
        if (shown() >= rowsWanted) break;
        const live = active();
        if (live.length === 0) break;
        const h = head();
        let want = live.filter((x) => (h ? blocks(x, h.p.row.entry) : true));
        if (want.length === 0) break;
        want = want.slice(0, Math.max(0, MAX_LIST_CALLS - listCalls));
        const entriesLeft = entriesWanted - read;
        if (want.length === 0 || entriesLeft <= 0) break;
        rounds++;
        const need = rowsWanted - shown();
        const plan = want.map((x) => {
          const limit = Math.max(1, Math.min(x.entryCap, Math.floor(entriesLeft / want.length)));
          const maxRows = Math.max(
            1,
            Math.min(x.rowCap, need, Math.max(4, Math.ceil((2 * need) / want.length))),
          );
          const i = st.indexOf(x);
          const at = (lists[i] as MergedList).place;
          const call: CallRequest =
            view === "mine"
              ? callOf(reader, topicMineReaderAbi, "mine", [
                  lensList,
                  at,
                  below,
                  EMPTY_BASIS,
                  x.next,
                  limit,
                  maxRows,
                  GAS_RESERVE,
                ])
              : callOf(reader, topicEveryoneReaderAbi, "everyone", [
                  { purpose: PURPOSES.tag, place: at, below, raw: false, sample },
                  lensList,
                  EMPTY_BASIS,
                  x.next,
                  limit,
                  maxRows,
                  GAS_RESERVE,
                ]);
          return { x, i, at, limit, maxRows, call };
        });
        ctx.requests += plan.length;
        listCalls += plan.length;
        const outs = await callsAt(
          s,
          basis.blockHash,
          plan.map((p) => p.call),
        );
        for (const [k, p] of plan.entries()) {
          const out = outs[k];
          const { x, i, at } = p;
          if (
            out &&
            !out.ok &&
            out.kind === "rpc" &&
            backoffs < MAX_BACKOFFS &&
            (p.limit > 1 || p.maxRows > 1)
          ) {
            // The node refused the call (out of gas, most likely): this list is tried again with half the bounds.
            backoffs++;
            x.entryCap = Math.max(1, Math.floor(p.limit / 2));
            x.rowCap = Math.max(1, Math.floor(p.maxRows / 2));
            continue;
          }
          const fn = view === "mine" ? "mine" : "everyone";
          const abi = view === "mine" ? topicMineReaderAbi : topicEveryoneReaderAbi;
          const dec = decoded<[RawInfo, readonly (RawMine | RawPlace)[]]>(abi, fn, out);
          if (!dec.ok) return dec;
          const [info, raw] = dec.value;
          const refused = refusal(Number(info.q.status));
          if (refused) {
            // The topic's own list, or a basis gone stale anywhere, is the page's status; a synonym's is `missing`.
            if (i === 0 || refused.reason.code === "BASIS_STALE")
              return { ok: true, value: { kind: "refused", ...refused } };
            x.missing = refused;
            x.buffer = [];
            continue;
          }
          x.calls++;
          const scan = SCAN[Number(info.scanStatus)] as ScanStatus | undefined;
          if (!scan) return badReply("an unknown scan status");
          if (scan !== "EXHAUSTED" && (info.next === "0x" || info.next.length <= 2))
            return badReply("a page that is not the end gave no resume point");
          if (Number(info.scanned) === 0 && scan !== "EXHAUSTED")
            return badReply("a page read nothing and did not end");
          if (
            x.calls === 1 &&
            !o.cursor &&
            scan === "EXHAUSTED" &&
            info.completeFromOrigin &&
            Number(info.listingCoverage) === 3
          )
            x.completeCall = true;
          read += Number(info.scanned);
          counts.scanned += Number(info.scanned);
          for (const row of raw) {
            const bad = rowFault(view, row, at, below, lensList);
            if (bad) return badReply(bad);
          }
          // A list's entries strictly fall: within this call, and below the last one this page read from it.
          let last = x.lastEntry;
          for (const row of raw) {
            const e = BigInt(row.bindingOrdinal);
            if (last !== null && e >= last)
              return badReply("a list's entries do not strictly fall");
            last = e;
          }
          x.lastEntry = last;
          let hidden = new Set<string>();
          if (below) {
            const topics = [...new Set(raw.map((y) => lower(y.topic)).filter((t) => t !== at))];
            const chains = await chainsBelow(s, basis, ctx, at, topics, parents);
            if (!chains.ok) return chains;
            const hb = await hiddenBelow(s, basis, ctx, at, chains.value, lensList, decided);
            if (!hb.ok) return hb;
            hidden = hb.value;
          }
          if (x.buffer.length === 0) x.resumeFrom = x.next;
          for (const row of raw) {
            if (hidden.has(lower(row.topic))) {
              counts.hiddenByChild++;
              continue;
            }
            const e = BigInt(row.bindingOrdinal);
            // On resume, a row at or above the last one decided was decided on an earlier page.
            if (shownFrom !== null && e >= shownFrom) continue;
            x.buffer.push({ row: rowOf(view, row, lensList), list: i });
          }
          if (scan === "EXHAUSTED") {
            x.done = true;
            x.floor = 0n;
          } else {
            const lastRaw = raw.length
              ? BigInt((raw[raw.length - 1] as RawMine).bindingOrdinal)
              : null;
            if (scan === "ROWS" && lastRaw !== null) x.floor = lastRaw;
            else if (lastRaw !== null)
              x.floor = x.floor === null || lastRaw < x.floor ? lastRaw : x.floor;
            x.next = info.next;
          }
          if (x.buffer.length === 0) x.resumeFrom = null;
        }
      }
      const e = await emit();
      if (!e.ok) return e;
      if (unkinded.length) {
        const k = await kindsOf(
          s,
          basis,
          ctx,
          unkinded.map((u) => u.pending.row.thing),
          exact,
        );
        if (!k.ok) return k;
        for (const u of unkinded)
          rows.push({
            ...u.pending.row,
            ...(k.value.get(u.pending.row.thing) as Kinded),
            via: lists[u.pending.list] as MergedList,
          });
      }
      if (seenList.length > SEEN_MAX) {
        bounded = true;
        seenList.splice(0, seenList.length - SEEN_MAX);
      }
      const missing: MissingList[] = [];
      const cursorLists = st.map((x, i) => {
        const l = lists[i] as MergedList;
        if (x.missing) {
          missing.push({ ...l, ...x.missing });
          return { ...l, next: null, missing: x.missing };
        }
        const next = x.buffer.length ? (x.resumeFrom ?? x.next) : x.done ? null : x.next;
        return { ...l, next };
      });
      const finished = st.every((x) => x.missing || (x.done && x.buffer.length === 0));
      counts.calls = listCalls;
      counts.rounds = rounds;
      counts.backoffs = backoffs;
      return {
        ok: true,
        value: {
          kind: "page",
          rows,
          cursorLists,
          missing,
          finished,
          complete: missing.length === 0 && st.every((x) => x.completeCall),
          shownTo,
          seen: seenList,
          bounded,
          dropped,
          counts,
        },
      };
    },
    o,
  );
  evidence.attempts.push(...r.attempts);
  evidence.requests += ctx.requests;
  if (!r.ok) return fail("UNKNOWN", r.reason, basis);
  const v = r.value;
  if (v.kind === "refused") return fail(v.status, v.reason, basis);
  return {
    kind: "efs.mergedTopicPage",
    status: "PRESENT",
    view,
    place: id,
    rows: v.rows,
    finished: v.finished,
    ...(v.finished
      ? {}
      : {
          next: {
            v: 1,
            kind: "efs.mergedCursor",
            query,
            lists: v.cursorLists,
            shownTo: v.shownTo === null ? null : v.shownTo.toString(),
            seen: v.seen,
            bounded: v.bounded,
            synonyms,
          },
        }),
    lists,
    missing: v.missing,
    complete: v.missing.length === 0 && synonyms.complete && !synonyms.limited,
    coverage: v.complete && !o.cursor ? "COMPLETE" : "PARTIAL",
    synonyms,
    dedup: { state: v.bounded ? "BOUNDED" : "COMPLETE", dropped: v.dropped },
    counts: v.counts,
    basis,
    evidence,
  };
}

/**
 * Which rows of `ask` (from synonym lists) a Lens author hides at the viewed topic: any of lens[0..decider] (the whole
 * Lens for a public-tier row) with a MASKED head at (viewed, thing). A COMPLETE zero from authorCount there means
 * nobody ever stated anything, and the heads are not asked; any other answer (a count, other coverage, a refusal or
 * a failed call) asks them, since the heads are the ledger's own and need no index.
 */
async function viewedHidden(
  s: Session,
  basis: Basis,
  ctx: Ctx,
  viewed: Hex,
  lens: readonly PrincipalId[],
  ask: readonly Pending[],
): Promise<Step<Set<Pending>>> {
  const out = new Set<Pending>();
  if (ask.length === 0) return { ok: true, value: out };
  const d = ctx.efs.deployment;
  const positions = ask.map((p) => lower(positionKey(PURPOSES.tag, viewed, p.row.thing)));
  let nobody = ask.map(() => false);
  const lookup = d.readers.topicLookup;
  if (lookup) {
    ctx.requests += ask.length;
    const counts = await callsAt(
      s,
      basis.blockHash,
      positions.map((p) => callOf(lookup, topicLookupReaderAbi, "authorCount", [p, EMPTY_BASIS])),
    );
    nobody = counts.map((c) => {
      if (!c?.ok) return false;
      try {
        const [q, coverage, statements] = decodeFunctionResult({
          abi: topicLookupReaderAbi,
          functionName: "authorCount",
          data: c.result as Hex,
        }) as unknown as [{ status: number }, number, bigint, bigint];
        return (
          chainStatus(q.status) === "PRESENT" && Number(coverage) === 3 && BigInt(statements) === 0n
        );
      } catch {
        return false;
      }
    });
  }
  const asked = ask.map((p, i) => ({ p, i })).filter(({ i }) => !nobody[i]);
  if (asked.length === 0) return { ok: true, value: out };
  const prefixes = asked.map(({ p }) => {
    const dec = p.row.decider;
    const upto = dec.kind === "lens" && dec.index !== NO_DECIDER ? dec.index + 1 : lens.length;
    return lens.slice(0, upto);
  });
  ctx.requests += asked.length;
  const heads = await callsAt(
    s,
    basis.blockHash,
    asked.map(({ i }, k) =>
      callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [
        d.ledger,
        prefixes[k] as PrincipalId[],
        positions[i] as Hex,
      ]),
    ),
  );
  for (const [k, { p }] of asked.entries()) {
    const h = decoded<[number, unknown, number, readonly { state: number }[]]>(
      ledgerViewsAbi,
      "headsAt",
      heads[k],
    );
    if (!h.ok) return h;
    const cs = chainStatus(h.value[0]);
    if (cs !== "PRESENT" && cs !== "MASKED" && cs !== "ABSENT_PROVEN")
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("NOT_YET_DECIDABLE", "transient", `a viewed-topic stance reads ${cs}`),
      };
    const all = h.value[3];
    if (all.length !== (prefixes[k] as PrincipalId[]).length)
      return badReply("headsAt (one head per Lens author)");
    if (all.some((x) => Number(x.state) === 2)) out.add(p);
  }
  return { ok: true, value: out };
}

/**
 * The merge's lists: the topic, the Lens's "same" places (topicSynonyms, nearest first), and word swaps of a path of
 * two or more words (registered paths only), ordered by hops, places before swaps at equal hops, swaps last word first,
 * cut at `maxLists` with the topic.
 */
async function gather(
  efs: Efs,
  place: TopicPlace,
  id: Hex,
  lens: readonly PrincipalId[],
  maxHops: number,
  maxLists: number,
  scan: number,
  o: MergedItemsOpts,
): Promise<
  | { ok: true; lists: MergedList[]; limited: boolean; complete: boolean; evidence: Evidence }
  | {
      ok: false;
      status: "UNKNOWN" | "INVALID";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    }
> {
  const self: MergedList = { place: id, how: "self", hops: 0 };
  const syn = await topicSynonyms(
    efs,
    Array.isArray(place) ? (place as readonly string[]) : { kind: "topic", id },
    {
      lens: { principals: lens },
      maxHops,
      maxTopics: MAX_LISTS,
      scan,
      ...(o.fold ? { fold: o.fold } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    },
  );
  const evidence: Tally = { attempts: [...syn.evidence.attempts], requests: syn.evidence.requests };
  // An id with no path is a topic nobody registered: its own list decides (empty), with nothing to merge.
  if (syn.status === "ABSENT_PROVEN")
    return { ok: true, lists: [self], limited: false, complete: true, evidence };
  if (syn.status !== "PRESENT")
    return {
      ok: false,
      status: syn.status,
      reason: syn.reason ?? reason("RPC_UNAVAILABLE", "transient"),
      ...(syn.basis ? { basis: syn.basis } : {}),
      evidence,
    };
  let limited = syn.limited;
  // One candidate per place, at its fewest hops (a place reached both as a "same" and as a swap keeps the nearer;
  // at equal hops the "same").
  type Cand = MergedList & { order: number[] };
  const byPlace = new Map<string, Cand>();
  for (const p of syn.places) {
    const at = lower(p.id);
    if (at === id || p.hops > maxHops) continue;
    const prev = byPlace.get(at);
    if (!prev || p.hops < prev.hops)
      byPlace.set(at, { place: at, how: "same", hops: p.hops, order: [] });
  }
  // Word swaps: each word of the path stays, or takes one of its word-level synonyms (that synonym's hops).
  const words = syn.topic.words;
  if (words.length >= 2) {
    const t = topicTypesOf(efs.deployment);
    const alts = syn.words.map((w) => w.synonyms.map((x) => ({ word: x.word, hops: x.hops })));
    const swaps: { words: string[]; hops: number; at: number[] }[] = [];
    let walked = 0;
    const walk = (k: number, chosen: string[], hops: number, at: number[]) => {
      if (walked > MAX_SWAP_WALK) return;
      if (k === words.length) {
        walked++;
        if (at.length) swaps.push({ words: [...chosen], hops, at: [...at] });
        return;
      }
      walk(k + 1, [...chosen, words[k] as string], hops, at);
      for (const a of alts[k] ?? [])
        if (hops + a.hops <= maxHops) walk(k + 1, [...chosen, a.word], hops + a.hops, [k, ...at]);
    };
    walk(0, [], 0, []);
    if (walked > MAX_SWAP_WALK) limited = true;
    // Nearest first; at equal hops, the swap that changes later words first (last word first).
    swaps.sort((a, b) => a.hops - b.hops || lastWordFirst(a.at, b.at));
    // Only swaps that could still change the set use a slot: never the topic itself, a place already at as few hops,
    // or a path already tried (the first, nearest, is kept).
    const tried: ((typeof swaps)[number] & { id: Hex })[] = [];
    const tries = new Set<string>();
    for (const x of swaps) {
      const at = lower(pathId(t, x.words));
      const prev = byPlace.get(at);
      if (at === id || tries.has(at) || (prev && prev.hops <= x.hops)) continue;
      if (tried.length === MAX_SWAPS) {
        limited = true;
        break;
      }
      tries.add(at);
      tried.push({ ...x, id: at });
    }
    const reg = await registered(
      efs,
      tried.map((x) => x.id as Hex),
      o,
    );
    evidence.attempts.push(...reg.evidence.attempts);
    evidence.requests += reg.evidence.requests;
    if (!reg.ok) return { ok: false, status: "UNKNOWN", reason: reg.reason, evidence };
    for (const x of tried)
      if (reg.value.has(x.id))
        byPlace.set(x.id, { place: x.id, how: "swap", hops: x.hops, order: x.at });
  }
  const cands = [...byPlace.values()];
  cands.sort(
    (a, b) =>
      a.hops - b.hops ||
      (a.how === b.how
        ? a.how === "swap"
          ? lastWordFirst(a.order, b.order)
          : 0
        : a.how === "same"
          ? -1
          : 1),
  );
  if (cands.length > maxLists - 1) limited = true;
  const lists = [self, ...cands.slice(0, maxLists - 1).map(({ order: _o, ...l }) => l)];
  return { ok: true, lists, limited, complete: syn.complete && !limited, evidence };
}

/** Orders two swaps' changed word positions (each newest position first): the one changing a later word first. */
function lastWordFirst(a: readonly number[], b: readonly number[]): number {
  for (let k = 0; k < Math.min(a.length, b.length); k++)
    if ((a[k] as number) !== (b[k] as number)) return (b[k] as number) - (a[k] as number);
  return a.length - b.length;
}

/** Which of `ids` are records (registered topics), at one block. Anything but PRESENT or a proven absence fails. */
async function registered(
  efs: Efs,
  ids: readonly Hex[],
  o: CallOpts,
): Promise<
  | { ok: true; value: Set<string>; evidence: Evidence }
  | { ok: false; reason: Reason; evidence: Evidence }
> {
  if (ids.length === 0)
    return { ok: true, value: new Set(), evidence: { attempts: [], requests: 0 } };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      ok: false,
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const d = efs.deployment;
  let requests = 0;
  const r = await onEndpoint<Set<string>>(
    efs._internal.pool,
    async (s) => {
      requests += 1;
      const [out] = await callsAt(s, pin.basis.blockHash, [
        callOf(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, ids as Hex[]]),
      ]);
      const rec = decoded<[readonly number[], readonly unknown[]]>(ledgerViewsAbi, "records", out);
      if (!rec.ok) return rec;
      const [statuses] = rec.value;
      if (statuses.length !== ids.length) return badReply("records (one per id)");
      const found = new Set<string>();
      for (const [i, code] of statuses.entries()) {
        const cs = chainStatus(code);
        if (cs === "PRESENT") found.add(ids[i] as string);
        else if (cs !== "ABSENT_PROVEN")
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("NOT_YET_DECIDABLE", "transient", `records answered ${cs}`),
          };
      }
      return { ok: true, value: found };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests,
  };
  return r.ok ? { ok: true, value: r.value, evidence } : { ok: false, reason: r.reason, evidence };
}
