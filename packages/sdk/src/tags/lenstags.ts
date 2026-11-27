// SPDX-License-Identifier: MIT
// A thing's tags as a Lens sees them ("what tags does this file have, in my view"). The chain's `about` reader lists
// every place anyone filed the thing at (TAG, either sign, newest first, each with its exact yes-count) and applies
// no Lens; this applies it, per (place, thing), by the tag Lens law (tags-0.1 §5.1): the first Lens author with a
// stance decides (BOUND: it applies, with their number; MASKED: "not this", the row is hidden). With no Lens stance,
// Mine shows nothing and Everyone shows the public tier when someone says yes. The page laws are topicItems': two
// limits (rows wanted, entries read), only EXHAUSTED ends a listing, and repeats are removed by place across pages
// through the cursor. Every reply is checked: each place names this thing at its own position, each head reply has
// one head per Lens author and agrees with the Lens law, and a deciding yes names this thing as its target.
import { keccak256 } from "viem";
import { type Basis, onEndpoint, type Session } from "../chain/pool.js";
import { throttled } from "../chain/rpc.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, lower, type PrincipalId, uniquePrincipals } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import { type Ctx, EMPTY_BASIS, type Evidence } from "../files/bytes.js";
import { selectionAgrees } from "../files/folders.js";
import { ledgerViewsAbi, topicLookupReaderAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import { callsIn } from "./filenames.js";
import { badReply, callOf, decoded } from "./plan.js";
import { type Decider, endpointFault, refusal, type ScanStatus, type TopicCursor } from "./read.js";
import { numberOf } from "./topics.js";

const SCAN: Readonly<Record<number, ScanStatus>> = {
  1: "EXHAUSTED",
  2: "LIMIT",
  3: "GAS",
  4: "ROWS",
};
/** The most `about` calls one page makes, each bounded, so a long run of hidden rows returns a page, never loops. */
const MAX_CALLS = 8;
const MAX_BACKOFFS = 4;
/** The most entries one `about` call reads (the reader's batch bound). */
const CALL_ENTRIES = 64;
const SEEN_MAX = 256;

export interface LensTagsOpts extends CallOpts {
  /** mine: Lens authors' yeses only; everyone (default): those, plus the public tier where no Lens author has a stance. */
  view?: "mine" | "everyone";
  lens?: Lens;
  /** Rows wanted on this page (default 50). */
  rows?: number;
  /** List entries this page may read at most (default 256). */
  entries?: number;
  cursor?: TopicCursor;
  /** The newest authors sampled per row (default 0). */
  sample?: number;
}
/** One place the thing is in, as the Lens decided it. */
export interface ThingTagRow {
  topic: Hex;
  position: Hex;
  /** The deciding statement's number: the Lens author's, or 0 for the public tier. */
  number: number;
  decider: Decider;
  /** Authors who ever stated anything there, and how many say yes now (exact). */
  statements: bigint;
  yes: bigint;
  sample?: { sampled: number; yes: number; no: number; incomplete: boolean };
  /** The list entry the row came from (a binding ordinal). */
  entry: bigint;
}
export type ThingTagsPage =
  | {
      kind: "efs.thingTagsPage";
      status: "PRESENT";
      view: "mine" | "everyone";
      thing: Hex;
      rows: readonly ThingTagRow[];
      /** True only when the chain said the list ended (EXHAUSTED). A short or empty page is not the end. */
      finished: boolean;
      scan: ScanStatus;
      next?: TopicCursor;
      /** COMPLETE: no row repeats a place already returned. BOUNDED: past the cursor's memory, repeats may slip. */
      dedup: { state: "COMPLETE" | "BOUNDED"; dropped: number };
      counts: {
        scanned: number;
        /** Places a Lens author says the thing is not in (MASKED decides). */
        deniedByLens: number;
        /** Places with no Lens stance left out: Mine always; Everyone when nobody says yes. */
        noStance: number;
        repeatsSkipped: number;
        calls: number;
        backoffs: number;
      };
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.thingTagsPage";
      status: "UNKNOWN" | "INVALID";
      view: "mine" | "everyone";
      thing: Hex;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

type RawInfo = { q: { status: number }; scanStatus: number; scanned: bigint; next: Hex };
type RawPlace = {
  position: Hex;
  topic: Hex;
  thing: Hex;
  bindingOrdinal: bigint;
  statements: bigint;
  yes: bigint;
  sampled: number;
  sampleYes: number;
  sampleNo: number;
  incomplete: boolean;
};
type RawHead = { state: number; strength: number; target: Hex };

/**
 * A page of the places `thing` is filed at, under a Lens (see the file's header). The thing is any id the chain
 * tags: a file's subject, a record id, or a padded address. The unfiltered list is tagsOf.
 */
export async function lensTagsOf(
  efs: Efs,
  thing: Hex,
  o: LensTagsOpts = {},
): Promise<ThingTagsPage> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(thing ?? ""))
    throw misuse("a thing is 32 bytes of hex (an id, or a padded address)");
  const asked = lower(thing);
  const view = o.view ?? "everyone";
  if (view !== "mine" && view !== "everyone")
    throw misuse("view is 'mine' or 'everyone' (the raw list is tagsOf)");
  const d = efs.deployment;
  const lookup = d.readers.topicLookup;
  if (!lookup)
    throw misuse("this deployment names no topic lookup reader (it predates the tag release)");
  const lensList = uniquePrincipals((o.lens ?? efs.lens.default).principals);
  if (lensList.length === 0) throw misuse("a Lens names at least one principal");
  if (lensList.length > 64) throw misuse("a Lens names at most 64 principals");
  const sample = o.sample ?? 0;
  const query = keccak256(
    utf8Encode(JSON.stringify(["efs-sdk/thing-tags/1", view, asked, lensList, sample])),
  );
  if (o.cursor && (o.cursor.v !== 1 || o.cursor.query !== query))
    throw misuse("this cursor belongs to another listing (view, thing, Lens or sample)");
  const rowsWanted = Math.max(1, o.rows ?? 50);
  const entriesWanted = Math.max(1, o.entries ?? 4 * CALL_ENTRIES);
  const none: Evidence = { attempts: [], requests: 0 };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.thingTagsPage",
      status: "UNKNOWN",
      view,
      thing: asked,
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence ?? none,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  type Out =
    | {
        kind: "page";
        rows: ThingTagRow[];
        scan: ScanStatus;
        next: Hex;
        seen: Hex[];
        bounded: boolean;
        dropped: number;
        counts: Extract<ThingTagsPage, { status: "PRESENT" }>["counts"];
      }
    | { kind: "refused"; status: "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s: Session) => {
      const seenList: Hex[] = [...(o.cursor?.seen ?? [])];
      const seen = new Set<string>(seenList);
      let bounded = o.cursor?.bounded ?? false;
      let next: Hex = o.cursor?.next ?? "0x";
      let dropped = 0;
      const rows: ThingTagRow[] = [];
      const counts = {
        scanned: 0,
        deniedByLens: 0,
        noStance: 0,
        repeatsSkipped: 0,
        calls: 0,
        backoffs: 0,
      };
      let scan: ScanStatus = "LIMIT";
      let read = 0;
      let entryCap = CALL_ENTRIES;
      while (counts.calls < MAX_CALLS) {
        // Each entry gives at most one row, so a call never reads more entries than rows are still wanted.
        const limit = Math.min(entryCap, entriesWanted - read, rowsWanted - rows.length);
        if (limit <= 0) break;
        ctx.requests += 1;
        const [out] = await callsIn(s, basis.blockHash, [
          callOf(lookup, topicLookupReaderAbi, "about", [asked, sample, EMPTY_BASIS, next, limit]),
        ]);
        // The node's own refusal (out of gas, most likely): the same call with half the bounds, a few times. A reply
        // that fails a check below, or a throttle (429, -32005), is the endpoint's: it fails over, never retried smaller.
        if (
          out &&
          !out.ok &&
          out.kind === "rpc" &&
          !throttled(out) &&
          counts.backoffs < MAX_BACKOFFS &&
          limit > 1
        ) {
          counts.backoffs++;
          entryCap = Math.max(1, Math.floor(limit / 2));
          continue;
        }
        counts.calls++;
        const dec = decoded<[RawInfo, readonly RawPlace[]]>(topicLookupReaderAbi, "about", out);
        if (!dec.ok) return dec;
        const [info, raw] = dec.value;
        const fault = endpointFault(Number(info.q.status));
        if (fault) return { ok: false, retryElsewhere: true, reason: fault };
        const refused = refusal(Number(info.q.status));
        if (refused) {
          if (refused.reason.code === "BASIS_STALE" && !o.cursor)
            return { ok: false, retryElsewhere: true, reason: refused.reason };
          return { ok: true, value: { kind: "refused", ...refused } };
        }
        const st = SCAN[Number(info.scanStatus)];
        if (!st) return badReply("about (an unknown scan status)");
        if (st !== "EXHAUSTED" && (info.next === "0x" || info.next.length <= 2))
          return badReply("about (a page that is not the end gave no resume point)");
        if (Number(info.scanned) === 0 && st !== "EXHAUSTED")
          return badReply("about (a page read nothing and did not end)");
        if (raw.length > limit) return badReply("about (more rows than entries asked)");
        for (const p of raw)
          if (
            lower(p.thing) !== asked ||
            lower(positionKey(PURPOSES.tag, lower(p.topic), asked)) !== lower(p.position)
          )
            return badReply("about (a listed place does not name this thing)");
        // The Lens at each place: every Lens author's head at its position, in one batch (≤ 100 calls each).
        const heads = await callsIn(
          s,
          basis.blockHash,
          raw.map((p) =>
            callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [
              d.ledger,
              lensList,
              p.position,
            ]),
          ),
        );
        ctx.requests += raw.length;
        for (const [k, p] of raw.entries()) {
          const h = decoded<[number, unknown, number, readonly RawHead[]]>(
            ledgerViewsAbi,
            "headsAt",
            heads[k],
          );
          if (!h.ok) return h;
          const [status, , selectedIndex, all] = h.value;
          if (all.length !== lensList.length) return badReply("headsAt (one head per Lens author)");
          const states = all.map((x) => headState(Number(x.state)));
          const cs = chainStatus(Number(status));
          if (!selectionAgrees(cs, Number(selectedIndex), states))
            return badReply("headsAt (its selection)");
          const first = states.findIndex((x) => x === "BOUND" || x === "MASKED");
          let decider: Decider | null = null;
          let number = 0;
          if (first >= 0 && states[first] === "MASKED") {
            counts.deniedByLens++;
            continue;
          }
          if (first >= 0) {
            const head = all[first] as RawHead;
            // A yes about this thing names it as its target (TAG: target = role = the thing).
            if (lower(head.target) !== asked)
              return badReply("headsAt (a deciding yes about another thing)");
            number = numberOf(1, Number(head.strength)) as number;
            decider = {
              kind: "lens",
              index: first,
              author: lensList[first] as PrincipalId,
              number,
            };
          } else if (view === "everyone" && BigInt(p.yes) > 0n) {
            decider = { kind: "public" };
          } else {
            counts.noStance++;
            continue;
          }
          const topic = lower(p.topic);
          if (seen.has(topic)) {
            counts.repeatsSkipped++;
            continue;
          }
          seen.add(topic);
          if (seenList.length < SEEN_MAX) seenList.push(topic);
          else {
            bounded = true;
            dropped++;
          }
          rows.push({
            topic,
            position: lower(p.position),
            number,
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
            entry: BigInt(p.bindingOrdinal),
          });
        }
        read += Number(info.scanned);
        counts.scanned += Number(info.scanned);
        next = info.next;
        scan = st;
        if (st === "EXHAUSTED" || rows.length >= rowsWanted) break;
      }
      return {
        ok: true,
        value: { kind: "page", rows, scan, next, seen: seenList, bounded, dropped, counts },
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
      kind: "efs.thingTagsPage",
      status: "UNKNOWN",
      view,
      thing: asked,
      reason: r.reason,
      basis,
      evidence,
    };
  const v = r.value;
  if (v.kind === "refused")
    return {
      kind: "efs.thingTagsPage",
      status: v.status,
      view,
      thing: asked,
      reason: v.reason,
      basis,
      evidence,
    };
  const finished = v.scan === "EXHAUSTED";
  return {
    kind: "efs.thingTagsPage",
    status: "PRESENT",
    view,
    thing: asked,
    rows: v.rows,
    finished,
    scan: v.scan,
    ...(finished ? {} : { next: { v: 1, query, next: v.next, seen: v.seen, bounded: v.bounded } }),
    dedup: { state: v.bounded ? "BOUNDED" : "COMPLETE", dropped: v.dropped },
    counts: v.counts,
    basis,
    evidence,
  };
}
