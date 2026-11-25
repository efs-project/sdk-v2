// SPDX-License-Identifier: MIT
// Names (the tag model spec §3.5, §3.7): what a topic, a path segment or a home is called, read under a Lens. A label is
// one author's PROPERTY statement (subject, labelKey(lang)) → a text/1 record. For each language in the reader's order,
// the Lens law picks it: the first Lens author with a BOUND label there, unless an earlier one's MASKED "no label"
// stops that language (then the next language is tried). A label is used only when its target really is a text/1
// record of an admitted text (its id is recomputed from the Type and the body read back); one that isn't is skipped,
// counted, and the next Lens author is tried. A failed read is UNKNOWN, never "no name".

import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, hexToBytes, lower, type PrincipalId } from "../core/hex.js";
import type { Ctx, Evidence } from "../files/bytes.js";
import { ledgerReadsAbi, ledgerViewsAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import type { FoldStep } from "../names/links.js";
import { decodeScalars } from "../names/name.js";
import { positionKey, recordId } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import { callsIn } from "./filenames.js";
import { badReply, callOf, decoded } from "./plan.js";
import { placeId, type TopicPlace, topicPath } from "./read.js";
import { langTag } from "./statements.js";
import {
  checkText,
  checkWord,
  labelKey,
  pathIds,
  type TopicId,
  topicTypesOf,
  wordPageId,
} from "./topics.js";

/** The most languages one read tries, and the most subjects one batch names. */
const MAX_LANGS = 8;
const MAX_SUBJECTS = 64;

export interface NameOpts extends CallOpts {
  /** Whose labels count, in order (default: the client's default Lens). */
  lens?: Lens;
  /** The reader's languages, most preferred first (BCP 47; lowercased). At least one, at most 8. */
  langs: readonly string[];
  fold?: FoldStep;
}
/** A label the Lens chose: its text, its language, who said it, and the text record. */
export interface Label {
  text: string;
  lang: string;
  author: PrincipalId;
  record: Hex;
}

export type LabelResult =
  | {
      kind: "efs.label";
      status: "PRESENT";
      label: Label;
      skipped: number;
      basis: Basis;
      evidence: Evidence;
    }
  /** No Lens author labels it in any of these languages (proven at the basis). */
  | {
      kind: "efs.label";
      status: "ABSENT_PROVEN";
      skipped: number;
      basis: Basis;
      evidence: Evidence;
    }
  | { kind: "efs.label"; status: "UNKNOWN"; reason: Reason; basis?: Basis; evidence: Evidence };

export interface SegmentName {
  word: string;
  id: TopicId;
  /** What to show: the label's text, or the word itself when nothing in the Lens labels it. */
  name: string;
  /** path: a label of this place itself; word: a label of the word (its page); none: no label, the word is shown. */
  source: "path" | "word" | "none";
  label?: Label;
}
export type TopicNameResult =
  | {
      kind: "efs.topicName";
      status: "PRESENT";
      /** One per word, root first. */
      segments: readonly SegmentName[];
      /** Labels skipped because their target is not an admitted text/1 record. */
      skipped: number;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.topicName";
      /** The id names no topic (topicPath's ABSENT_PROVEN), or its words could not be read back (INVALID). */
      status: "ABSENT_PROVEN" | "INVALID" | "UNKNOWN";
      reason?: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

const lensOf = (efs: Efs, lens: Lens | undefined): PrincipalId[] => {
  const ps = (lens ?? efs.lens.default).principals.map((p) => lower(p) as PrincipalId);
  if (ps.length === 0) throw misuse("a Lens names at least one principal");
  if (ps.length > 64) throw misuse("a Lens names at most 64 principals");
  return ps;
};
const langsOf = (langs: readonly string[] | undefined): string[] => {
  if (!Array.isArray(langs) || langs.length === 0)
    throw misuse("`langs` names at least one language (BCP 47), most preferred first");
  if (langs.length > MAX_LANGS) throw misuse(`at most ${MAX_LANGS} languages`);
  return [...new Set(langs.map(langTag))];
};

type RawHead = { state: number; target: Hex };

/**
 * @internal Each subject's label under the Lens, in language order, on one endpoint at the basis: one headsAt per
 * (subject, language), then the candidates' bodies, round by round (a round only when a candidate was not a text).
 */
export async function labelsAt(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  principals: readonly PrincipalId[],
  subjects: readonly Hex[],
  langs: readonly string[],
): Promise<Step<{ labels: (Label | null)[]; skipped: number }>> {
  const d = ctx.efs.deployment;
  const textType = topicTypesOf(d).text;
  const keys = langs.map((l) => labelKey(l));
  const cells = subjects.flatMap((subject) =>
    keys.map((key, li) => ({
      subject,
      li,
      position: lower(positionKey(PURPOSES.property, subject, key)),
    })),
  );
  ctx.requests += cells.length;
  const outs = await callsIn(
    s,
    basis.blockHash,
    cells.map((c) =>
      callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [
        d.ledger,
        principals as Hex[],
        c.position,
      ]),
    ),
  );
  // Each cell's candidates in Lens order: BOUND authors up to the first MASKED one.
  const candidates: { author: PrincipalId; target: Hex }[][] = [];
  for (const out of outs) {
    const h = decoded<[number, unknown, number, readonly RawHead[]]>(
      ledgerViewsAbi,
      "headsAt",
      out,
    );
    if (!h.ok) return h;
    const st = chainStatus(h.value[0]);
    if (st !== "PRESENT" && st !== "MASKED" && st !== "ABSENT_PROVEN")
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", `headsAt reads ${st}`),
      };
    const all = h.value[3];
    if (all.length !== principals.length) return badReply("headsAt (one head per Lens author)");
    const list: { author: PrincipalId; target: Hex }[] = [];
    for (const [i, head] of all.entries()) {
      const hs = headState(Number(head.state));
      if (hs === "MASKED") break;
      if (hs === "BOUND")
        list.push({ author: principals[i] as PrincipalId, target: lower(head.target) });
    }
    candidates.push(list);
  }
  const at = cells.map(() => 0);
  const found: (Label | null)[] = cells.map(() => null);
  const done = cells.map((_, i) => (candidates[i] as unknown[]).length === 0);
  let skipped = 0;
  const bodies = new Map<Hex, string | null>(); // record id → its text, or null when it isn't an admitted text
  for (let round = 0; done.some((x) => !x); round++) {
    if (round > principals.length) return badReply("label candidates (rounds)");
    const want = [
      ...new Set(
        cells
          .map((_, i) =>
            done[i] ? null : (candidates[i] as { target: Hex }[])[at[i] as number]?.target,
          )
          .filter((x): x is Hex => !!x && !bodies.has(x)),
      ),
    ];
    if (want.length) {
      ctx.requests += want.length;
      const got = await callsIn(
        s,
        basis.blockHash,
        want.map((id) =>
          callOf(d.readers.ledgerReads, ledgerReadsAbi, "bodySlice", [d.ledger, id, 0, 256]),
        ),
      );
      for (const [k, id] of want.entries()) {
        const b = decoded<[number, Hex]>(ledgerReadsAbi, "bodySlice", got[k]);
        if (!b.ok) return b;
        // The kernel admits a BIND only to an existing record: anything but PRESENT is a reply to refuse.
        if (chainStatus(b.value[0]) !== "PRESENT")
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", "a label names no record"),
          };
        const bytes = hexToBytes(b.value[1]);
        const isText = lower(recordId(textType, bytes)) === id && checkText(bytes).ok;
        bodies.set(id, isText ? (decodeScalars(bytes)?.text ?? null) : null);
      }
    }
    for (const [i] of cells.entries()) {
      if (done[i]) continue;
      const c = (candidates[i] as { author: PrincipalId; target: Hex }[])[at[i] as number];
      if (!c) {
        done[i] = true;
        continue;
      }
      const text = bodies.get(c.target);
      if (text) {
        const cell = cells[i] as { li: number };
        found[i] = { text, lang: langs[cell.li] as string, author: c.author, record: c.target };
        done[i] = true;
      } else {
        skipped++;
        at[i] = (at[i] as number) + 1;
      }
    }
  }
  // Per subject: the first language with a label.
  const labels = subjects.map((_, si) => {
    for (let li = 0; li < langs.length; li++) {
      const f = found[si * langs.length + li];
      if (f) return f;
    }
    return null;
  });
  return { ok: true, value: { labels, skipped } };
}

/** What a topic or home is called under a Lens: its label in the reader's first language that has one. */
export async function labelOf(efs: Efs, subject: TopicPlace, o: NameOpts): Promise<LabelResult> {
  const principals = lensOf(efs, o.lens);
  const langs = langsOf(o.langs);
  const { id } = placeId(efs, subject, o.fold);
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.label",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint(
    efs._internal.pool,
    (s) => labelsAt(ctx, s, basis, principals, [id], langs),
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { kind: "efs.label", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const label = r.value.labels[0];
  return label
    ? { kind: "efs.label", status: "PRESENT", label, skipped: r.value.skipped, basis, evidence }
    : { kind: "efs.label", status: "ABSENT_PROVEN", skipped: r.value.skipped, basis, evidence };
}

/**
 * Every segment's display name for a topic under a Lens (spec §3.5): a path-level label of that place, else the
 * word-level label (the word's page) in the reader's languages, else the word itself. The root segment's place is its
 * word's page, so its label is word-level. One batch of label reads; a topic named by id reads its words first.
 */
export async function topicName(
  efs: Efs,
  topic: readonly string[] | { kind: "topic"; id: Hex },
  o: NameOpts,
): Promise<TopicNameResult> {
  const t = topicTypesOf(efs.deployment);
  const principals = lensOf(efs, o.lens);
  const langs = langsOf(o.langs);
  let words: string[];
  const extra: Evidence = { attempts: [], requests: 0 };
  if (Array.isArray(topic)) {
    if (topic.length === 0) throw misuse("a topic is at least one word");
    words = (topic as readonly string[]).map((typed, i) => {
      let w = typed;
      if (o.fold) {
        const f = o.fold(typed);
        if (!f.ok) throw misuse(`word ${i} does not fold (${f.rule})`, { index: i });
        w = f.word;
      }
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
        kind: "efs.topicName",
        status: p.status,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.basis ? { basis: p.basis } : {}),
        evidence: extra,
      };
    words = [...p.words];
  }
  if (words.length * 2 > MAX_SUBJECTS)
    throw misuse(`a topic of at most ${MAX_SUBJECTS / 2} words is named in one read`);
  const ids = pathIds(t, words).map((x) => lower(x) as TopicId);
  const pages = words.map((w) => lower(wordPageId(t, w)));
  // Subjects: every place below the root (path level), then every word's page (word level; the root is one).
  const placeSubjects = ids.slice(1);
  const subjects = [...placeSubjects, ...pages];
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.topicName",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint(
    efs._internal.pool,
    (s) => labelsAt(ctx, s, basis, principals, subjects, langs),
    o,
  );
  const evidence: Evidence = {
    attempts: [...extra.attempts, ...pin.evidence.attempts, ...r.attempts],
    requests: extra.requests + ctx.requests,
  };
  if (!r.ok) return { kind: "efs.topicName", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const { labels, skipped } = r.value;
  const segments: SegmentName[] = words.map((word, i) => {
    const pathLabel = i === 0 ? null : labels[i - 1];
    const wordLabel = labels[placeSubjects.length + i];
    const label = pathLabel ?? wordLabel ?? null;
    return {
      word,
      id: ids[i] as TopicId,
      name: label ? label.text : word,
      source: pathLabel ? "path" : wordLabel ? "word" : "none",
      ...(label ? { label } : {}),
    };
  });
  return { kind: "efs.topicName", status: "PRESENT", segments, skipped, basis, evidence };
}
