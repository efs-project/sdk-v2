// SPDX-License-Identifier: MIT
// The interim write guard (tag PM, 2026-11-26), until the fold rule is ruled (Q53): a word with any non-ASCII character
// is written only when both candidate rules leave it unchanged. Exact, with no tables of our own: NFC already,
// unchanged by lowercasing (rule A's fixed point, final sigma included), no character that changes under
// NFKC_Casefold (rule B's fixed point), no private-use or unassigned character, and not starting with a combining
// mark (both rules refuse those). It uses the engine's Unicode data (Node 24: Unicode 16), so very new characters can
// differ between engines until the pin. Writes only: reads and links still pass such a word through.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStableWord } from "../src/names/fold.ts";
import { placeOf } from "../src/tags/plan.ts";

const evaluation = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../docs/design/fold-evaluation/vectors.json"),
    "utf8",
  ),
) as {
  vectors: { label: string; input: string; A: { word?: string }; B: { word?: string } }[];
};
const nonAscii = evaluation.vectors.filter((v) =>
  [...v.input].some((c) => c.charCodeAt(0) >= 0x80),
);
const T = {
  word: `0x${"11".repeat(32)}`,
  path: `0x${"22".repeat(32)}`,
  text: `0x${"33".repeat(32)}`,
} as never;

describe("checkStableWord", () => {
  it("covers every non-ASCII case of the fold evaluation (50)", () => {
    expect(nonAscii.length).toBe(50);
  });
  it.each(nonAscii)(
    "$label: admitted exactly when both rules leave it as it is",
    ({ input, A, B }) => {
      expect(checkStableWord(input).ok).toBe(A.word === input && B.word === input);
    },
  );

  const cases: [string, string, string | null][] = [
    ["café", "an accent, already lowercase NFC", null],
    ["kırmızı", "dotless ı in a word: both rules keep it", null],
    ["日本語", "no case", null],
    ["🚗", "an emoji", null],
    ["École", "a capital É", "lowercase"],
    ["Ｔesla", "a full-width capital", "lowercase"],
    ["ﬁle", "a ligature", "nfkc-casefold"],
    ["straße", "ß (rule B: ss)", "nfkc-casefold"],
    ["οδος", "a final sigma (rule B: σ)", "nfkc-casefold"],
    ["\u2764\ufe0f", "a variation selector", "nfkc-casefold"],
    ["a\u200db", "a zero-width joiner", "nfkc-casefold"],
    ["a\u200cb", "a zero-width non-joiner", "nfkc-casefold"],
    ["e\u0301", "not NFC (é decomposed)", "nfc"],
    ["\u0301a", "a leading combining mark", "leading-mark"],
    ["a\ue000", "a private-use character", "unassigned-or-private"],
  ];
  it.each(cases)("%j (%s)", (word, _why, check) => {
    const r = checkStableWord(word);
    expect(r.ok ? null : r.check).toBe(check);
  });

  it("ASCII words are always stable (the fold made them so)", () => {
    for (const w of ["notes", "model_y", "__init__", "cars"])
      expect(checkStableWord(w).ok).toBe(true);
  });

  it("a lone dotless ı is admitted: both rules keep it (an upper-then-lower check would wrongly refuse it)", () => {
    expect(checkStableWord("ı").ok).toBe(true);
  });
});

describe("writes only", () => {
  it("adding a statement refuses an unstable word, with copy an app can show; taking one back does not", () => {
    expect(() => placeOf(T, ["École"], undefined, true)).toThrow(
      /can't be used until the tag text rule is chosen/,
    );
    expect(placeOf(T, ["École"], undefined, false).words).toEqual(["École"]);
    expect(placeOf(T, ["café"], undefined, true).words).toEqual(["café"]);
  });
});
