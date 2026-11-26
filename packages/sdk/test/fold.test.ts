// SPDX-License-Identifier: MIT
// The interim word fold (PM default D15, until Q53 rules the fold): a word made only of ASCII goes through the fold
// evaluation's white-space step (trimmed; a run of white space with the underscores touching it becomes one
// underscore), then A–Z become a–z. Any other word is left exactly as typed. Both candidate rules give this same word
// for every ASCII input (every all-ASCII vector of the evaluation, below), so the word doesn't change when the rule
// is ruled (its topic id still can, with the refused table); a mixed word is left alone because a rule could fold it
// differently (Straße, École).
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    // Underscores touching white space join its run (the evaluation's `pre`); others stay.
    ["model _ y", "model_y"],
    ["a_ b", "a_b"],
    ["a _b", "a_b"],
    ["_ tesla", "_tesla"],
    ["model__y", "model__y"],
    ["__init__", "__init__"],
    ["a\nb", "a_b"],
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

describe("every all-ASCII vector of the fold evaluation gives both candidate rules' result", () => {
  const evaluation = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../docs/design/fold-evaluation/vectors.json"),
      "utf8",
    ),
  ) as {
    vectors: {
      label: string;
      input: string;
      A: { word?: string; refused?: string };
      B: { word?: string; refused?: string };
    }[];
  };
  const ascii = evaluation.vectors.filter((v) => [...v.input].every((c) => c.charCodeAt(0) < 0x80));
  it("covers every all-ASCII case (24)", () => {
    expect(ascii.length).toBe(24);
  });
  // The evaluation judged its words by the grammar before the list release; since then the chain also refuses ASCII
  // punctuation (contracts 04526b1 item 53), so a word a rule makes can still be one the chain refuses (the qualifier
  // `mercury_(planet)`: code 3). The fold must make each rule's word; the chain's grammar decides the rest.
  const LIST_RELEASE_REFUSES = new Set(["qualifier"]);
  it.each(ascii)("$label", ({ label, input, A, B }) => {
    const word = fold(input);
    const checked = checkWord(word);
    for (const rule of [A, B]) {
      if (rule.word !== undefined) {
        expect(word).toBe(rule.word);
        expect(checked.ok).toBe(!LIST_RELEASE_REFUSES.has(label));
      } else expect(checked.ok).toBe(false);
    }
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
