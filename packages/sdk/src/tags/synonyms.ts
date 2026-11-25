// SPDX-License-Identifier: MIT
// Synonyms (the tag model spec §3.5; FilesFinalValidator's reading rule): gather what a Lens says is "the same" as a
// topic, at both levels, without merging any id.
//   - Places: every SAME edge joins two places: path ↔ path joins those two paths, word page ↔ path joins that root
//     place and that path, word page ↔ word page joins the two root places (and is also word level).
//   - Words: for each word of the topic, the word pages joined to its page by word page ↔ word page edges only; they
//     apply to every path using the word (the merged read that applies them is not built: see tags-0.1).
// An edge is found from either side: from each Lens author's own SAME statements about a topic (their scope list), and
// from the SAME statements that name it (Keys.backlinkList(SAME, topic)). Whether it holds is the Lens law at its
// position: the first Lens author with a stance there decides (BOUND: the same, MASKED: not), whoever filed the entry.
// At most 4 hops, cycle-safe, at most 16 topics, at most 16 newest entries per list; a view that hit a bound says so.
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, hexToBytes, lower, type PrincipalId } from "../core/hex.js";
import type { Ctx, Evidence } from "../files/bytes.js";
import {
  bitmapStoreAbi,
  indexAbi,
  ledgerAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
} from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import type { FoldStep } from "../names/links.js";
import { decodeScalars } from "../names/name.js";
import { positionKey, scopeKey } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import { callsIn } from "./filenames.js";
import { badReply, callOf, decoded } from "./plan.js";
import { topicPath } from "./read.js";
import { checkWord, pathIds, type TopicId, topicTypesOf, wordPageId } from "./topics.js";

const MAX_HOPS = 4;
const MAX_TOPICS = 16;
const MAX_SCAN = 16;

export interface SynonymOpts extends CallOpts {
  lens?: Lens;
  fold?: FoldStep;
  /** Hops from the topic, 1 to 4 (default 4). */
  maxHops?: number;
  /** Topics gathered per closure, the topic itself included, 2 to 16 (default 16). */
  maxTopics?: number;
  /** Newest entries read per list, 1 to 16 (default 16). */
  scan?: number;
}
/** One topic joined to the asked one: how many hops away, and which Lens author's statement joined it. */
export interface Joined {
  id: TopicId;
  /** word: a word page (a root place); path: a path record. */
  kind: "word" | "path";
  hops: number;
  /** The Lens author whose "same" decided the last edge in. */
  author: PrincipalId;
}
export interface WordSynonyms {
  word: string;
  page: TopicId;
  /** Word pages the same as this word's page (word level), each with its word. */
  synonyms: readonly (Joined & { word: string })[];
}
export type SynonymsResult =
  | {
      kind: "efs.synonyms";
      status: "PRESENT";
      topic: { words: readonly string[]; id: TopicId };
      /** Places the same as the topic (the topic itself left out), nearest first. */
      places: readonly Joined[];
      /** Per word of the topic, root first: its word-level synonyms. */
      words: readonly WordSynonyms[];
      /** A hop, topic or scan bound stopped the gathering: there may be more. */
      limited: boolean;
      /** Every list was read to its start and the index vouches for it: a missing synonym is proven absent. */
      complete: boolean;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.synonyms";
      status: "ABSENT_PROVEN" | "INVALID" | "UNKNOWN";
      reason?: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

type Edge = { from: Hex; to: Hex; author: PrincipalId };

/**
 * @internal Every SAME edge the Lens keeps at these topics, on one endpoint at the basis, from both sides. `complete`
 * is false when a list was longer than `scan` or the index does not vouch for it.
 */
async function sameEdges(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  principals: readonly PrincipalId[],
  topics: readonly Hex[],
  scan: number,
): Promise<Step<{ edges: Edge[]; complete: boolean }>> {
  const d = ctx.efs.deployment;
  const { address: index, scopeFamily, bitmapStore, backlinkFamily } = d.index;
  if (!index || !scopeFamily || !bitmapStore || !backlinkFamily)
    return {
      ok: false,
      retryElsewhere: false,
      reason: reason("UNSUPPORTED_PROFILE", "never", "the deployment names no index lists to read"),
    };
  const at = basis.blockHash;
  const scopes = topics.flatMap((x) =>
    principals.map((p) => ({ x, scope: lower(scopeKey(p, PURPOSES.same, x)) })),
  );
  // 1. Heads and coverage: each author's own statements about each topic, and each topic's "what names it" list.
  const calls1 = [
    ...scopes.flatMap((c) => [
      callOf(bitmapStore, bitmapStoreAbi, "scopeHead", [c.scope]),
      callOf(index, indexAbi, "coverage", [scopeFamily, c.scope]),
    ]),
    ...topics.map((x) =>
      callOf(index, indexAbi, "postingHeadOf", [backlinkFamily, PURPOSES.same, 0, x]),
    ),
  ];
  ctx.requests += calls1.length;
  const out1 = await callsIn(s, at, calls1);
  let complete = true;
  const scopeCounts: bigint[] = [];
  for (let i = 0; i < scopes.length; i++) {
    const h = decoded<[bigint, bigint, bigint, number, number, bigint]>(
      bitmapStoreAbi,
      "scopeHead",
      out1[2 * i],
    );
    if (!h.ok) return h;
    const c = decoded<[number, bigint, bigint, number]>(indexAbi, "coverage", out1[2 * i + 1]);
    if (!c.ok) return c;
    const count = BigInt(h.value[0]);
    if (Number(c.value[0]) !== 3 || count > BigInt(scan)) complete = false; // Coverage.COMPLETE
    scopeCounts.push(count);
  }
  const backCounts: bigint[] = [];
  for (let i = 0; i < topics.length; i++) {
    const h = decoded<[number, bigint, bigint, bigint, boolean]>(
      indexAbi,
      "postingHeadOf",
      out1[2 * scopes.length + i],
    );
    if (!h.ok) return h;
    const count = BigInt(h.value[1]);
    if (Number(h.value[0]) !== 3 || count > BigInt(scan)) complete = false;
    backCounts.push(count);
  }
  // 2. The newest `scan` entries of each.
  const window = (count: bigint) => {
    const n = count < BigInt(scan) ? count : BigInt(scan);
    return { from: count - n, n: Number(n) };
  };
  const scopeWant = scopes
    .map((c, i) => ({ ...c, ...window(scopeCounts[i] as bigint) }))
    .filter((c) => c.n > 0);
  const backWant = topics
    .map((x, i) => ({ x, ...window(backCounts[i] as bigint) }))
    .filter((c) => c.n > 0);
  const calls2 = [
    ...scopeWant.map((c) =>
      callOf(bitmapStore, bitmapStoreAbi, "scopeSlice", [c.scope, c.from, c.n]),
    ),
    ...backWant.map((c) =>
      callOf(index, indexAbi, "postingSliceOf", [
        backlinkFamily,
        PURPOSES.same,
        0,
        c.x,
        c.from,
        c.n,
      ]),
    ),
  ];
  ctx.requests += calls2.length;
  const out2 = await callsIn(s, at, calls2);
  const bindings: { x: Hex; ordinal: bigint; side: "out" }[] = [];
  for (const [k, c] of scopeWant.entries()) {
    const sl = decoded<readonly bigint[]>(bitmapStoreAbi, "scopeSlice", out2[k]);
    if (!sl.ok) return sl;
    if (sl.value.length !== c.n) return badReply("scopeSlice (length)");
    for (const ord of sl.value) bindings.push({ x: c.x, ordinal: BigInt(ord), side: "out" });
  }
  const admissions: { x: Hex; ordinal: bigint }[] = [];
  for (const [k, c] of backWant.entries()) {
    const sl = decoded<[number, readonly bigint[], boolean]>(
      indexAbi,
      "postingSliceOf",
      out2[scopeWant.length + k],
    );
    if (!sl.ok) return sl;
    if (sl.value[1].length !== c.n) return badReply("postingSliceOf (length)");
    if (Number(sl.value[0]) !== 3) complete = false;
    for (const ord of sl.value[1]) admissions.push({ x: c.x, ordinal: BigInt(ord) });
  }
  // 3. A "what names it" entry is an admission: its binding.
  const out3 = await callsIn(
    s,
    at,
    admissions.map((a) =>
      callOf(d.readers.ledgerReads, ledgerReadsAbi, "admission", [d.ledger, a.ordinal]),
    ),
  );
  ctx.requests += admissions.length;
  const all: { x: Hex; ordinal: bigint; side: "out" | "in" }[] = [...bindings];
  for (const [k, a] of admissions.entries()) {
    const r = decoded<[number, { bindingOrdinal: bigint }]>(ledgerReadsAbi, "admission", out3[k]);
    if (!r.ok) return r;
    if (chainStatus(r.value[0]) !== "PRESENT")
      return badReply("admission (a listed entry has no row)");
    all.push({ x: a.x, ordinal: BigInt(r.value[1].bindingOrdinal), side: "in" });
  }
  // 4. Each binding's position and that position's cell.
  const out4 = await callsIn(
    s,
    at,
    all.map((b) =>
      callOf(d.readers.ledgerReads, ledgerReadsAbi, "bindingPosition", [d.ledger, b.ordinal]),
    ),
  );
  ctx.requests += all.length;
  const positions = new Map<Hex, { x: Hex; side: "out" | "in" }>();
  for (const [k, b] of all.entries()) {
    const p = decoded<[number, Hex]>(ledgerReadsAbi, "bindingPosition", out4[k]);
    if (!p.ok) return p;
    if (chainStatus(p.value[0]) !== "PRESENT") return badReply("bindingPosition (a listed entry)");
    positions.set(lower(p.value[1]), { x: b.x, side: b.side });
  }
  const list = [...positions.entries()];
  const out5 = await callsIn(
    s,
    at,
    list.flatMap(([pos]) => [
      callOf(d.readers.ledgerReads, ledgerReadsAbi, "positionCell", [d.ledger, pos]),
      callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [
        d.ledger,
        principals as Hex[],
        pos,
      ]),
    ]),
  );
  ctx.requests += 2 * list.length;
  const edges: Edge[] = [];
  for (const [k, [pos, { x, side }]] of list.entries()) {
    const cell = decoded<[number, Hex, Hex, Hex]>(ledgerReadsAbi, "positionCell", out5[2 * k]);
    if (!cell.ok) return cell;
    const [cst, purpose, subject, role] = cell.value;
    const sub = lower(subject);
    const rol = lower(role);
    // The list said this position is about x (as its subject, or named by it as its role): it must be.
    if (
      chainStatus(cst) !== "PRESENT" ||
      lower(purpose) !== lower(PURPOSES.same) ||
      (side === "out" ? sub !== x : rol !== x) ||
      lower(positionKey(PURPOSES.same, sub, rol)) !== pos
    )
      return badReply("positionCell (a SAME list entry that is not about its topic)");
    const h = decoded<[number, unknown, number, readonly { state: number; target: Hex }[]]>(
      ledgerViewsAbi,
      "headsAt",
      out5[2 * k + 1],
    );
    if (!h.ok) return h;
    const heads = h.value[3];
    if (heads.length !== principals.length) return badReply("headsAt (one head per Lens author)");
    // The Lens law at this position: the first author with a stance decides.
    for (const [i, head] of heads.entries()) {
      const st = headState(Number(head.state));
      if (st === "MASKED") break;
      if (st === "BOUND") {
        if (lower(head.target) !== rol)
          return badReply("headsAt (a SAME whose target is not its role)");
        edges.push({
          from: x,
          to: side === "out" ? rol : sub,
          author: principals[i] as PrincipalId,
        });
        break;
      }
    }
  }
  return { ok: true, value: { edges, complete } };
}

/**
 * The topics a Lens says are the same as `topic`, at both levels (see the file's header), at one block: the places
 * joined to it, and each of its words' word-level synonyms. Ids are never merged; a merged read of their items is a
 * later step. A topic named by id reads its words first.
 */
export async function topicSynonyms(
  efs: Efs,
  topic: readonly string[] | { kind: "topic"; id: Hex },
  o: SynonymOpts = {},
): Promise<SynonymsResult> {
  const d = efs.deployment;
  const t = topicTypesOf(d);
  const principals = (o.lens ?? efs.lens.default).principals.map((p) => lower(p) as PrincipalId);
  if (principals.length === 0) throw misuse("a Lens names at least one principal");
  const maxHops = o.maxHops ?? MAX_HOPS;
  const maxTopics = o.maxTopics ?? MAX_TOPICS;
  const scan = o.scan ?? MAX_SCAN;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_HOPS)
    throw misuse(`maxHops is 1 to ${MAX_HOPS}`);
  if (!Number.isInteger(maxTopics) || maxTopics < 2 || maxTopics > MAX_TOPICS)
    throw misuse(`maxTopics is 2 to ${MAX_TOPICS}`);
  if (!Number.isInteger(scan) || scan < 1 || scan > MAX_SCAN)
    throw misuse(`scan is 1 to ${MAX_SCAN}`);
  const extra: Evidence = { attempts: [], requests: 0 };
  let words: string[];
  if (Array.isArray(topic)) {
    if (topic.length === 0) throw misuse("a topic is at least one word");
    words = (topic as readonly string[]).map((typed, i) => {
      const w = o.fold
        ? (() => {
            const f = (o.fold as FoldStep)(typed);
            if (!f.ok) throw misuse(`word ${i} does not fold (${f.rule})`);
            return f.word;
          })()
        : typed;
      const c = checkWord(w);
      if (!c.ok)
        throw misuse(`word ${i} is not a word the chain admits (code ${c.code}: ${c.rule})`);
      return w;
    });
  } else {
    const p = await topicPath(efs, (topic as { id: Hex }).id, o);
    extra.attempts = [...p.evidence.attempts];
    extra.requests = p.evidence.requests;
    if (p.status !== "PRESENT")
      return {
        kind: "efs.synonyms",
        status: p.status,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.basis ? { basis: p.basis } : {}),
        evidence: extra,
      };
    words = [...p.words];
  }
  const id = lower(pathIds(t, words)[words.length - 1] as Hex) as TopicId;
  const pages = words.map((w) => lower(wordPageId(t, w)) as TopicId);
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.synonyms",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint(
    efs._internal.pool,
    async (s: Session) => {
      // Only the generation the deployment names (its family ids are that generation's).
      ctx.requests += 1;
      const [ix] = await callsIn(s, basis.blockHash, [callOf(d.ledger, ledgerAbi, "index", [])]);
      const live = decoded<Hex>(ledgerAbi, "index", ix);
      if (!live.ok) return live;
      if (lower(live.value) !== d.index.address)
        return {
          ok: false as const,
          retryElsewhere: false,
          reason: reason(
            "UNSUPPORTED_PROFILE",
            "never",
            "the live index is not the one the deployment names",
          ),
        };
      let limited = false;
      let complete = true;
      const kinds = new Map<Hex, "word" | "path">();
      const kindOf = async (ids: readonly Hex[]): Promise<Step<null>> => {
        const want = [...new Set(ids)].filter((x) => !kinds.has(x));
        if (!want.length) return { ok: true, value: null };
        ctx.requests += 1;
        const [out] = await callsIn(s, basis.blockHash, [
          callOf(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, want]),
        ]);
        const rec = decoded<[readonly number[], readonly { typeId: Hex }[]]>(
          ledgerViewsAbi,
          "records",
          out,
        );
        if (!rec.ok) return rec;
        if (rec.value[0].length !== want.length) return badReply("records (one per id)");
        for (const [i, x] of want.entries()) {
          const type = lower((rec.value[1][i] as { typeId: Hex }).typeId);
          // The validator admits a first SAME only between topics: anything else is a reply to refuse.
          if (
            chainStatus(rec.value[0][i] as number) !== "PRESENT" ||
            (type !== t.word && type !== t.path)
          )
            return badReply("records (a SAME end that is not a topic)");
          kinds.set(x, type === t.word ? "word" : "path");
        }
        return { ok: true, value: null };
      };
      /** Breadth first from `start`, `wordsOnly` keeping word page ↔ word page edges. */
      const closure = async (start: Hex, wordsOnly: boolean): Promise<Step<Joined[]>> => {
        const seen = new Map<Hex, Joined | null>([[start, null]]);
        let frontier: Hex[] = [start];
        for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
          const e = await sameEdges(ctx, s, basis, principals, frontier, scan);
          if (!e.ok) return e;
          if (!e.value.complete) complete = false;
          const k = await kindOf(e.value.edges.map((x) => x.to));
          if (!k.ok) return k;
          const next: Hex[] = [];
          for (const edge of e.value.edges) {
            if (seen.has(edge.to)) continue;
            const kind = kinds.get(edge.to) as "word" | "path";
            if (wordsOnly && kind !== "word") continue;
            if (seen.size >= maxTopics) {
              limited = true;
              break;
            }
            seen.set(edge.to, { id: edge.to as TopicId, kind, hops: hop, author: edge.author });
            next.push(edge.to);
          }
          frontier = next;
          if (hop === maxHops && frontier.length) limited = true; // more may lie beyond the last hop
        }
        return { ok: true, value: [...seen.values()].filter((x): x is Joined => x !== null) };
      };
      const places = await closure(id, false);
      if (!places.ok) return places;
      const perWord: WordSynonyms[] = [];
      const wordPages: Hex[] = [];
      for (const [i, w] of words.entries()) {
        const c = await closure(pages[i] as Hex, true);
        if (!c.ok) return c;
        perWord.push({
          word: w,
          page: pages[i] as TopicId,
          synonyms: c.value as (Joined & { word: string })[],
        });
        wordPages.push(...c.value.map((x) => x.id));
      }
      // The synonyms' words: each word page's body, checked against the chain's grammar.
      const distinct = [...new Set(wordPages)];
      const outs = await callsIn(
        s,
        basis.blockHash,
        distinct.map((p) =>
          callOf(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [d.ledger, p, 0, 256]),
        ),
      );
      ctx.requests += distinct.length;
      const wordOf = new Map<Hex, string>();
      for (const [k, p] of distinct.entries()) {
        const b = decoded<[number, Hex]>(ledgerReadsAbi, "bodySlice", outs[k]);
        if (!b.ok) return b;
        const bytes = hexToBytes(b.value[1]);
        const c = checkWord(bytes);
        if (chainStatus(b.value[0]) !== "PRESENT" || !c.ok || lower(wordPageId(t, bytes)) !== p)
          return badReply("a word page (body)");
        wordOf.set(p, decodeScalars(bytes)?.text ?? "");
      }
      for (const w of perWord)
        w.synonyms = w.synonyms.map((x) => ({ ...x, word: wordOf.get(x.id) as string }));
      return {
        ok: true as const,
        value: { places: places.value, words: perWord, limited, complete },
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...extra.attempts, ...pin.evidence.attempts, ...r.attempts],
    requests: extra.requests + ctx.requests,
  };
  if (!r.ok) return { kind: "efs.synonyms", status: "UNKNOWN", reason: r.reason, basis, evidence };
  return {
    kind: "efs.synonyms",
    status: "PRESENT",
    topic: { words, id },
    places: r.value.places,
    words: r.value.words,
    limited: r.value.limited,
    complete: r.value.complete,
    basis,
    evidence,
  };
}
