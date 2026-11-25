// SPDX-License-Identifier: MIT
// Topics, the chain's way (the tag release; contracts EfsTopics.sol and TopicProfile.sol), pure and with no reads:
//   - the word and text grammars, refusing exactly what the chain refuses with its own codes, so a bad word is a
//     planning error, never a revert (vectors: test/vectors/topics.json);
//   - ids: a word's page is the topic-word/1 record of its bytes (also the root-level topic /<word>); a path of two or
//     more words is the topic/1 record (parent topic, last word's page); a home is an address as a left-padded word;
//   - the binding number: a BIND states strength n ≥ 0, an UNBIND −1 − strength (BindingNumber);
//   - the actions EfsTopics' builders write: registration, tag, deny, untag, property, label, same and broader.
// The SDK never folds here: words are checked as given. A fold (efs/fold/1, still to be ruled) runs before.
import { encodeAbiParameters, keccak256, pad, toHex } from "viem";
import type { ActionData } from "../actions/types.js";
import { misuse } from "../core/errors.js";
import { type Address, type Hex, lower, ZERO_WORD } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ACTION, MAX_STRENGTH, PURPOSES, TOPICS } from "../generated/constants.js";
import { recordId } from "../protocol/keys.js";

/** A topic's id: the record id of its word page (one word) or of its path record (two or more). */
export type TopicId = Hex & { readonly __efs?: "topic" };

/** The Topics Type ids of a deployment (provisional until the Unicode generator gate; see the release notes). */
export interface TopicTypes {
  word: Hex;
  path: Hex;
  text: Hex;
}
export function topicTypesOf(d: Pick<DeploymentInfo, "typeIds">): TopicTypes {
  const word = d.typeIds["topic-word/1"];
  const path = d.typeIds["topic/1"];
  const text = d.typeIds["text/1"];
  if (!word || !path || !text)
    throw misuse("this deployment registers no Topics Types (topic-word/1, topic/1, text/1)");
  return { word: lower(word), path: lower(path), text: lower(text) };
}

// ---- the grammars

export type GrammarCheck =
  | { ok: true; bytes: Uint8Array }
  /** `code`: the chain's own refusal code (TopicProfile); `rule`: what it means. */
  | { ok: false; code: number; rule: string };

const WORD_RULES: Readonly<Record<number, string>> = {
  1: "empty or longer than 255 bytes",
  2: "malformed UTF-8",
  3: "a forbidden ASCII byte ('/', '\\', a control, a space or A-Z)",
  4: "'.' or '..'",
  5: "starts with '~'",
  6: "'0x' and 40 lowercase hex characters (an address)",
  7: "a refused character (whitespace, a control, an invisible or bidi character, a joiner or a noncharacter)",
};
const TEXT_RULES: Readonly<Record<number, string>> = {
  20: "empty or longer than 255 bytes",
  21: "malformed UTF-8",
  22: "a control character",
  23: "a bidi control, an invisible character or a noncharacter",
};

/** The refused class of a scalar (TopicProfile.REFUSED), or 0 when it is not refused. */
function refusedClass(cp: number): number {
  const table = TOPICS.refused as unknown as readonly (readonly [number, number, number])[];
  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, cls] = table[mid] as readonly [number, number, number];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return cls;
  }
  return 0;
}

/** Strict UTF-8: the scalar at `i` and its length, or null (overlong, surrogate, above U+10FFFF, truncated). */
function scalarAt(b: Uint8Array, i: number): { cp: number; n: number } | null {
  const c = b[i] as number;
  const cont = (k: number, lo = 0x80, hi = 0xbf) => {
    const x = b[i + k];
    return x !== undefined && x >= lo && x <= hi ? x & 0x3f : -1;
  };
  if (c >= 0xc2 && c <= 0xdf) {
    const c1 = cont(1);
    return c1 < 0 ? null : { cp: ((c & 0x1f) << 6) | c1, n: 2 };
  }
  if (c >= 0xe0 && c <= 0xef) {
    const lo = c === 0xe0 ? 0xa0 : 0x80;
    const hi = c === 0xed ? 0x9f : 0xbf;
    const c1 = cont(1, lo, hi);
    const c2 = cont(2);
    return c1 < 0 || c2 < 0 ? null : { cp: ((c & 0x0f) << 12) | (c1 << 6) | c2, n: 3 };
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const lo = c === 0xf0 ? 0x90 : 0x80;
    const hi = c === 0xf4 ? 0x8f : 0xbf;
    const c1 = cont(1, lo, hi);
    const c2 = cont(2);
    const c3 = cont(3);
    return c1 < 0 || c2 < 0 || c3 < 0
      ? null
      : { cp: ((c & 0x07) << 18) | (c1 << 12) | (c2 << 6) | c3, n: 4 };
  }
  return null;
}

const asBytes = (x: string | Uint8Array): Uint8Array => (typeof x === "string" ? utf8Encode(x) : x);
const fail = (code: number, rules: Readonly<Record<number, string>>): GrammarCheck => ({
  ok: false,
  code,
  rule: rules[code] ?? `code ${code}`,
});

/**
 * The chain's word grammar (topic-word/1, TopicProfile.wordRefusal): 1–255 bytes of strict UTF-8; no '/', '\', ASCII
 * control, space or A–Z; no refused scalar; not '.' or '..'; not starting with '~'; not '0x' and 40 lowercase hex
 * digits. The length code first, then the first byte code found from the start, then the whole-word shapes.
 */
export function checkWord(word: string | Uint8Array): GrammarCheck {
  const b = asBytes(word);
  if (b.length === 0 || b.length > TOPICS.wordMax) return fail(1, WORD_RULES);
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    if (c < 0x80) {
      if (c <= 0x20 || c === 0x2f || c === 0x5c || c === 0x7f || (c >= 0x41 && c <= 0x5a))
        return fail(3, WORD_RULES);
      i++;
      continue;
    }
    const s = scalarAt(b, i);
    if (!s) return fail(2, WORD_RULES);
    if (refusedClass(s.cp) !== 0) return fail(7, WORD_RULES);
    i += s.n;
  }
  if ((b.length === 1 || b.length === 2) && b.every((c) => c === 0x2e)) return fail(4, WORD_RULES);
  if (b[0] === 0x7e) return fail(5, WORD_RULES);
  if (
    b.length === 42 &&
    b[0] === 0x30 &&
    b[1] === 0x78 &&
    b.subarray(2).every((c) => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))
  )
    return fail(6, WORD_RULES);
  return { ok: true, bytes: b };
}

/**
 * The chain's text grammar (text/1, for labels; TopicProfile.textRefusal): 1–255 bytes of strict UTF-8; no C0, DEL or
 * C1 control; no bidi control, invisible scalar or noncharacter. '/', spaces, uppercase and joiners are admitted.
 */
export function checkText(text: string | Uint8Array): GrammarCheck {
  const b = asBytes(text);
  if (b.length === 0 || b.length > TOPICS.textMax) return fail(20, TEXT_RULES);
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    if (c < 0x80) {
      if (c < 0x20 || c === 0x7f) return fail(22, TEXT_RULES);
      i++;
      continue;
    }
    const s = scalarAt(b, i);
    if (!s) return fail(21, TEXT_RULES);
    if (s.cp >= 0x80 && s.cp <= 0x9f) return fail(22, TEXT_RULES);
    const cls = refusedClass(s.cp);
    if (cls === TOPICS.refusedClasses.BIDI || cls === TOPICS.refusedClasses.INVISIBLE)
      return fail(23, TEXT_RULES);
    if (cls === TOPICS.refusedClasses.NONCHARACTER) return fail(23, TEXT_RULES);
    i += s.n;
  }
  return { ok: true, bytes: b };
}

const wordBytes = (word: string | Uint8Array): Uint8Array => {
  const c = checkWord(word);
  if (!c.ok)
    throw misuse(`not a word the chain admits (code ${c.code}: ${c.rule})`, {
      code: c.code,
    });
  return c.bytes;
};

// ---- ids

/** A word's page (and the root-level topic /<word>): the topic-word/1 record of its bytes. MISUSE for a refused word. */
export function wordPageId(t: TopicTypes, word: string | Uint8Array): TopicId {
  return lower(recordId(t.word, wordBytes(word))) as unknown as TopicId;
}
/** The body of a path record: abi.encode(parent topic, the last word's page). */
export function pathBody(t: TopicTypes, parent: Hex, word: string | Uint8Array): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }],
    [parent, wordPageId(t, word)],
  );
}
/** The topic one word below `parent`: the topic/1 record (parent, word page). */
export function childId(t: TopicTypes, parent: Hex, word: string | Uint8Array): TopicId {
  return lower(recordId(t.path, pathBody(t, parent, word))) as unknown as TopicId;
}
/** A path's topic id, from its words alone: never an author, a Realm or a chain. */
export function pathId(t: TopicTypes, words: readonly (string | Uint8Array)[]): TopicId {
  if (words.length === 0) throw misuse("a topic is at least one word");
  let id = wordPageId(t, words[0] as string | Uint8Array);
  for (const w of words.slice(1)) id = childId(t, id, w);
  return id;
}
/** Every prefix's topic id, from the root word down: ids[k] is the topic of the first k + 1 words. */
export function pathIds(t: TopicTypes, words: readonly (string | Uint8Array)[]): TopicId[] {
  if (words.length === 0) throw misuse("a topic is at least one word");
  const ids: TopicId[] = [wordPageId(t, words[0] as string | Uint8Array)];
  for (const w of words.slice(1)) ids.push(childId(t, ids[ids.length - 1] as Hex, w));
  return ids;
}
/** A home: the address as a left-padded word (no record, no hash). */
export function homeId(address: Address): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw misuse("a home is a 20-byte address");
  return lower(pad(address, { size: 32 }));
}
/** A text/1 record (a label's display string). MISUSE for a refused text. */
export function textRecordId(t: TopicTypes, text: string | Uint8Array): Hex {
  const c = checkText(text);
  if (!c.ok) throw misuse(`not a text the chain admits (code ${c.code}: ${c.rule})`);
  return lower(recordId(t.text, c.bytes));
}
const PROPERTY_KEY_DOMAIN = keccak256(utf8Encode("efs/property-key/1"));
/** A property's key: keccak256(abi.encode(keccak256("efs/property-key/1"), keccak256(key))). */
export function propertyKey(key: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [PROPERTY_KEY_DOMAIN, keccak256(utf8Encode(key))],
    ),
  );
}
/** A label's key in one language: the property key of "label:" ‖ the BCP 47 tag. */
export const labelKey = (lang: string): Hex => propertyKey(`label:${lang}`);

// ---- the number

/** BindingNumber.numberOf: BOUND (1) → strength, MASKED (2) → −1 − strength, any other state → no number. */
export function numberOf(state: number, strength: number): number | null {
  if (state === 1) return strength;
  if (state === 2) return -1 - strength;
  return null;
}
/** The action a number takes: a BIND with strength n (n ≥ 0) or an UNBIND with strength −1 − n. MISUSE outside. */
export function strengthOf(n: number): { unbind: boolean; strength: number } {
  if (!Number.isSafeInteger(n) || n > MAX_STRENGTH || n < -1 - MAX_STRENGTH)
    throw misuse(`a tag's number is an integer from ${-1 - MAX_STRENGTH} to ${MAX_STRENGTH}`, {
      number: n,
    });
  return n >= 0 ? { unbind: false, strength: n } : { unbind: true, strength: -1 - n };
}
const word32 = (n: number | bigint): Hex => pad(toHex(n), { size: 32 });

// ---- the actions (EfsTopics' builders, action for action)

const blank: ActionData = {
  kind: 0,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  saltOrStrength: ZERO_WORD,
};
const publishOf = (typeId: Hex, body: Uint8Array | Hex): { action: ActionData; body: Hex } => {
  const hex = typeof body === "string" ? body : toHex(body);
  return {
    action: { ...blank, kind: ACTION.PUBLISH, typeId, bodyHashOrRecordId: keccak256(hex) },
    body: hex,
  };
};
/** The PUBLISH of a word's page. */
export const wordPageAction = (
  t: TopicTypes,
  word: string | Uint8Array,
): { action: ActionData; body: Hex } => publishOf(t.word, wordBytes(word));
/** The PUBLISH of the path record (parent, word page). */
export const pathRecordAction = (
  t: TopicTypes,
  parent: Hex,
  word: string | Uint8Array,
): { action: ActionData; body: Hex } => publishOf(t.path, pathBody(t, parent, word));

/**
 * Registering a path, in the order the chain needs (registerPath / registerChild): the word pages first, then the
 * path records from two words on, parent first. `missing` names only what to publish: `pages` by word index and
 * `paths` by prefix length (2..n). Default: all of them.
 */
export function registerPathActions(
  t: TopicTypes,
  words: readonly (string | Uint8Array)[],
  missing: { pages?: readonly number[]; paths?: readonly number[] } = {},
): { actions: ActionData[]; bodies: Hex[] } {
  const ids = pathIds(t, words);
  const pages = missing.pages ?? words.map((_, i) => i);
  const paths = missing.paths ?? words.map((_, i) => i + 1).filter((n) => n >= 2);
  const out = [
    ...pages.map((i) => wordPageAction(t, words[i] as string | Uint8Array)),
    ...[...paths]
      .sort((a, b) => a - b)
      .map((n) => pathRecordAction(t, ids[n - 2] as Hex, words[n - 1] as string | Uint8Array)),
  ];
  return { actions: out.map((x) => x.action), bodies: out.map((x) => x.body) };
}

const bindKind = (
  kind: number,
  purpose: Hex,
  subject: Hex,
  role: Hex,
  target: Hex,
  expectedRevision: bigint,
  strength: number,
): ActionData => ({
  ...blank,
  kind,
  purpose,
  subject: lower(subject),
  role: lower(role),
  target: lower(target),
  expectedRevision,
  saltOrStrength: word32(strength),
});

/** "thing is in topic, with number n ≥ 0": a TAG BIND whose target is the thing. */
export function tagAction(topic: Hex, thing: Hex, expectedRevision: bigint, n: number): ActionData {
  const s = strengthOf(n);
  if (s.unbind) throw misuse("a tag's number is 0 or more: deny with a negative one");
  return bindKind(ACTION.BIND, PURPOSES.tag, topic, thing, thing, expectedRevision, s.strength);
}
/** "not this", n < 0 (−1 by default): a TAG UNBIND, which may be a first statement (a lone negative). */
export function denyAction(topic: Hex, thing: Hex, expectedRevision: bigint, n = -1): ActionData {
  const s = strengthOf(n);
  if (!s.unbind) throw misuse("a denial's number is below 0");
  return bindKind(
    ACTION.UNBIND,
    PURPOSES.tag,
    topic,
    thing,
    ZERO_WORD,
    expectedRevision,
    s.strength,
  );
}
/** Back to "said nothing": a TAG RELEASE of your own statement. */
export function untagAction(topic: Hex, thing: Hex, expectedRevision: bigint): ActionData {
  return bindKind(ACTION.RELEASE, PURPOSES.tag, topic, thing, ZERO_WORD, expectedRevision, 0);
}
/** A property of `subject`: (PROPERTY, subject, key) → value. */
export function propertyAction(
  subject: Hex,
  key: Hex,
  value: Hex,
  expectedRevision: bigint,
  n = 0,
): ActionData {
  return bindKind(ACTION.BIND, PURPOSES.property, subject, key, value, expectedRevision, n);
}
/** A label of `subject` in `lang`: the text record, then the PROPERTY bind to it. */
export function labelActions(
  t: TopicTypes,
  subject: Hex,
  lang: string,
  text: string,
  expectedRevision: bigint,
): { actions: ActionData[]; bodies: Hex[] } {
  const c = checkText(text);
  if (!c.ok) throw misuse(`not a text the chain admits (code ${c.code}: ${c.rule})`);
  const rec = publishOf(t.text, c.bytes);
  const bind = propertyAction(subject, labelKey(lang), textRecordId(t, c.bytes), expectedRevision);
  return { actions: [rec.action, bind], bodies: [rec.body, "0x"] };
}
/** The PUBLISH of a text/1 record (a label's display string). MISUSE for a refused text. */
export function textRecordAction(
  t: TopicTypes,
  text: string | Uint8Array,
): { action: ActionData; body: Hex } {
  const c = checkText(text);
  if (!c.ok) throw misuse(`not a text the chain admits (code ${c.code}: ${c.rule})`);
  return publishOf(t.text, c.bytes);
}
/** Back to "said nothing" for any statement of yours: a RELEASE at (purpose, subject, role). */
export function releaseAction(
  purpose: Hex,
  subject: Hex,
  role: Hex,
  expectedRevision: bigint,
): ActionData {
  return bindKind(ACTION.RELEASE, purpose, subject, role, ZERO_WORD, expectedRevision, 0);
}
/** "subject is the same topic as other": (SAME, subject, other) → other. */
export const sameAction = (subject: Hex, other: Hex, expectedRevision: bigint): ActionData =>
  bindKind(ACTION.BIND, PURPOSES.same, subject, other, other, expectedRevision, 0);
/** "subject is narrower than broader": (BROADER, subject, broader) → broader. */
export const broaderAction = (subject: Hex, broader: Hex, expectedRevision: bigint): ActionData =>
  bindKind(ACTION.BIND, PURPOSES.broader, subject, broader, broader, expectedRevision, 0);
