// SPDX-License-Identifier: MIT
// The chain's word grammar (topic-word/1, TopicProfile.wordRefusal), with no dependencies beyond the generated
// constants: shared by the tag planners and reads (src/tags/topics.ts re-exports checkWord) and by the link grammar
// (src/names/links.ts, part of the startup router's import graph), so a link names only words the chain can hold.
import { utf8Encode } from "../core/platform.js";
import { TOPICS } from "../generated/constants.js";

export type GrammarCheck =
  | { ok: true; bytes: Uint8Array }
  /** `code`: the chain's own refusal code (TopicProfile); `rule`: what it means. */
  | { ok: false; code: number; rule: string };

// Code 5 (once "starts with '~'") is unused since the list release: a '~' is code 3 wherever it stands. Never reused.
const WORD_RULES: Readonly<Record<number, string>> = {
  1: "empty or longer than 255 bytes",
  2: "malformed UTF-8",
  3: "an ASCII character other than a-z, 0-9, '-', '_' and '.'",
  4: "ends with '.'",
  6: "'0x' and 40 lowercase hex characters (an address)",
  7: "a refused character (whitespace, a control, an invisible or bidi character, a joiner or a noncharacter)",
  9: "starts with '-'",
};

/** The ASCII bytes a word may hold (TOPICS.wordAscii: a-z 0-9 - _ .), as a 128-entry table. */
const WORD_ASCII: readonly boolean[] = (() => {
  const t = new Array<boolean>(128).fill(false);
  for (const ch of TOPICS.wordAscii) t[ch.charCodeAt(0)] = true;
  return t;
})();

/** @internal The refused class of a scalar (TopicProfile.REFUSED), or 0 when it is not refused. */
export function refusedClass(cp: number): number {
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

/** @internal Strict UTF-8: the scalar at `i` and its length, or null (overlong, surrogate, above U+10FFFF, truncated). */
export function scalarAt(b: Uint8Array, i: number): { cp: number; n: number } | null {
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

const fail = (code: number): GrammarCheck => ({
  ok: false,
  code,
  rule: WORD_RULES[code] ?? `code ${code}`,
});

/**
 * The chain's word grammar (topic-word/1, TopicProfile.wordRefusal; contracts 04526b1 item 53): 1–255 bytes of strict
 * UTF-8; of ASCII only a–z, 0–9, '-', '_' and '.'; no refused scalar; not ending with '.'; not starting with '-'; not
 * '0x' and 40 lowercase hex digits. It returns the chain's FIRST refusal: the length (1); then, scanning from the
 * first byte, the first of malformed UTF-8 (2), an ASCII byte outside the 39 (3) or a refused scalar (7); then a
 * trailing '.' (4), a leading '-' (9), an address (6).
 */
export function checkWord(word: string | Uint8Array): GrammarCheck {
  const b = typeof word === "string" ? utf8Encode(word) : word;
  if (b.length === 0 || b.length > TOPICS.wordMax) return fail(1);
  for (let i = 0; i < b.length; ) {
    const c = b[i] as number;
    if (c < 0x80) {
      if (!WORD_ASCII[c]) return fail(3);
      i++;
      continue;
    }
    const s = scalarAt(b, i);
    if (!s) return fail(2);
    if (refusedClass(s.cp) !== 0) return fail(7);
    i += s.n;
  }
  if (b[b.length - 1] === 0x2e) return fail(4);
  if (b[0] === 0x2d) return fail(9);
  if (
    b.length === 42 &&
    b[0] === 0x30 &&
    b[1] === 0x78 &&
    b.subarray(2).every((c) => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))
  )
    return fail(6);
  return { ok: true, bytes: b };
}
