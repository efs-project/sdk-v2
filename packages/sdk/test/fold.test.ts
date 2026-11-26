// SPDX-License-Identifier: MIT
// The interim word fold (PM default D15, until Q53 rules the fold): a word made only of ASCII is trimmed of spaces and
// tabs, each run of them inside becomes one underscore (ruled: D-B 2026-09-10, spec §6), and A–Z become a–z. Any other
// word is left exactly as typed. Either candidate rule (NFKC_Casefold, or lowercase) gives the same word for every
// ASCII input, so no id made here changes when the rule is ruled; a mixed word is left alone because a rule could
// fold it differently (Straße, École).
import { describe, expect, it } from "vitest";
import { FOLD_RULE, foldWord } from "../src/names/fold.ts";
import { parseLink } from "../src/names/links.ts";
import { checkWord, pathId } from "../src/tags/topics.ts";

const fold = (w: string) => {
  const f = foldWord(w);
  if (!f.ok) throw new Error(f.rule);
  return f.word;
};
const T = {
  word: `0x${"11".repeat(32)}`,
  path: `0x${"22".repeat(32)}`,
  text: `0x${"33".repeat(32)}`,
} as never;

describe("foldWord (interim, all-ASCII words only)", () => {
  const vectors: [string, string][] = [
    ["Notes", "notes"],
    ["My Notes", "my_notes"],
    ["  notes  ", "notes"],
    ["\tTabbed\t", "tabbed"],
    ["a  \t  b", "a_b"],
    ["a b", "a_b"],
    ["a_b", "a_b"],
    ["already-folded", "already-folded"],
    ["   ", ""],
    // Not all ASCII: exactly as typed, capitals and spaces included.
    ["Straße", "Straße"],
    ["École", "École"],
    ["Ｔesla", "Ｔesla"],
    ["My École", "My École"],
  ];
  it.each(vectors)("%j folds to %j", (typed, word) => {
    expect(fold(typed)).toBe(word);
  });

  it("folding twice is folding once", () => {
    for (const [typed] of vectors) expect(fold(fold(typed))).toBe(fold(typed));
  });

  it("a folded all-ASCII word passes the chain's grammar; only spaces folds to empty, which it refuses", () => {
    for (const typed of ["Notes", "My Notes", "  notes  ", "\tTabbed\t", "a  \t  b"])
      expect(checkWord(fold(typed)).ok).toBe(true);
    expect(checkWord(fold("   "))).toMatchObject({ ok: false, code: 1 });
  });

  it("mixed words stay as today: an ASCII capital is still refused, and other capitals pass as typed", () => {
    expect(checkWord(fold("Straße"))).toMatchObject({ ok: false, code: 3 });
    expect(checkWord(fold("My École"))).toMatchObject({ ok: false, code: 3 });
    // É is not ASCII: the grammar admits it today, as typed (a word a ruling may fold differently: Q53).
    expect(checkWord(fold("École")).ok).toBe(true);
  });

  it("`a b` and `a_b` are one topic", () => {
    expect(pathId(T, [fold("Cars"), fold("a b")])).toBe(pathId(T, ["cars", "a_b"]));
  });

  it("is named, so an app can say which fold it applied", () => {
    expect(FOLD_RULE).toBe("efs-sdk/fold/interim-ascii-1");
  });
});

describe("links fold by default", () => {
  it("a typed topic path opens its folded topic, and its canonical form is the folded one", () => {
    const got = parseLink("Cars/Tesla");
    expect(got).toMatchObject({
      status: "OK",
      target: { kind: "topic", segments: ["Cars", "Tesla"], words: ["cars", "tesla"] },
      canonical: "cars/tesla",
    });
    // fold: null parses the grammar alone (segments, no words).
    expect(parseLink("Cars/Tesla", { fold: null })).toMatchObject({
      status: "OK",
      target: { kind: "topic", segments: ["Cars", "Tesla"] },
    });
  });
});
