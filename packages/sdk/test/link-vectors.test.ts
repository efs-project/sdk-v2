// SPDX-License-Identifier: MIT
// The link grammar against its vectors (test/vectors/links.json): object, revision, home and topic links, the
// reserved `~` segments, escapes, and the pluggable fold (a stand-in here; the real rule is efs/fold/1, to be chosen).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FoldStep,
  link,
  parseLink,
  WORD_DETAILS,
  type WordDetail,
} from "../src/names/links.ts";

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors/links.json"), "utf8"),
) as {
  cases: {
    label: string;
    input: string;
    fold: "none" | "ascii-test";
    expect: Record<string, unknown>;
  }[];
};
/** A stand-in fold for the grammar's tests only: lowercase A–Z, a run of spaces becomes one underscore. */
const asciiTest: FoldStep = (segment) => {
  if ([...segment].some((ch) => (ch.codePointAt(0) as number) < 0x20 || ch === "\u007f"))
    return { ok: false, rule: "control" };
  return {
    ok: true,
    word: segment
      .trim()
      .replace(/ +/g, "_")
      .replace(/[A-Z]/g, (c) => c.toLowerCase()),
  };
};

describe("link grammar vectors", () => {
  it.each(vectors.cases)("$label", ({ input, fold, expect: want }) => {
    // "none" parses the grammar alone (fold: null); the default fold is foldWord (test/fold.test.ts).
    const got = parseLink(input, fold === "ascii-test" ? { fold: asciiTest } : { fold: null });
    expect(got).toEqual(want);
    // Every OK parse round-trips: its canonical form parses to the same target.
    if (got.status === "OK") {
      const again = parseLink(
        got.canonical,
        fold === "ascii-test" ? { fold: asciiTest } : { fold: null },
      );
      expect(again).toMatchObject({ status: "OK", canonical: got.canonical });
    }
  });

  it("bad-word names the segment as the link spelled it, wherever the word is refused", () => {
    // Refused as typed, by the fold, or after the fold (what the fold made breaks the rule): always the typed text.
    expect(parseLink("cars/~x", { fold: null })).toMatchObject({ segment: 1, word: "~x" });
    const refuses: FoldStep = () => ({ ok: false, rule: "unstable" });
    expect(parseLink("cars/%C3%89cole", { fold: refuses })).toEqual({
      status: "INVALID",
      rule: "bad-word",
      segment: 0,
      detail: "fold-refused",
      foldRule: "unstable",
      word: "cars",
    });
    const makesSlash: FoldStep = (w) => ({ ok: true, word: w === "b" ? "x/y" : w });
    expect(parseLink("a/b", { fold: makesSlash })).toEqual({
      status: "INVALID",
      rule: "bad-word",
      segment: 1,
      detail: "slash",
      word: "b",
      code: 3,
    });
    // A fold that makes a word the link grammar's own rules pass but the chain refuses: checkWord has the last word.
    const makesBidi: FoldStep = (w) => ({ ok: true, word: w === "b" ? "x\u202ey" : w });
    expect(parseLink("a/b", { fold: makesBidi })).toEqual({
      status: "INVALID",
      rule: "bad-word",
      segment: 1,
      detail: "refused-character",
      word: "b",
      code: 7,
    });
    // Other refusals carry no word.
    expect(parseLink("cars//tesla", { fold: null })).not.toHaveProperty("word");
  });

  it("formats topic and home links from their parts, and refuses parts the grammar refuses", () => {
    expect(link({ kind: "topic", segments: [], words: ["cars", "tesla"] })).toBe("cars/tesla");
    expect(() => link({ kind: "topic", segments: ["Cars"] })).toThrow(/folded words/);
    expect(() => link({ kind: "topic", segments: [], words: ["Cars"] })).toThrow(/unfolded/);
    expect(() => link({ kind: "topic", segments: [], words: ["~efs"] })).toThrow(/forbidden-ascii/);
    const address = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;
    expect(link({ kind: "home", address, names: ["Photos", "cat 1.jpg"] })).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01/Photos/cat%201.jpg",
    );
    expect(() => link({ kind: "home", address, names: ["a/b"] })).toThrow(/files-name\/3/);
    expect(() => link({ kind: "home", address: "0x12" as never, names: [] })).toThrow(/20-byte/);
    const lens = { principals: [`0x${"0".repeat(24)}${"11".repeat(20)}` as `0x${string}`] };
    expect(link({ kind: "topic", segments: [], words: ["cars"], lens })).toBe(
      `cars?lens=0x${"11".repeat(20)}`,
    );
    expect(link({ kind: "home", address, names: [], lens })).toBe(
      `0xabcdef0123456789abcdef0123456789abcdef01?lens=0x${"11".repeat(20)}`,
    );
    const folder = `0x${"FD".repeat(32)}` as `0x${string}`;
    const f = `0x${"fd".repeat(32)}`;
    expect(link({ kind: "path", folder, names: ["Photos", "cat 1.jpg"] })).toBe(
      `~efs/o/${f}/Photos/cat%201.jpg`,
    );
    expect(link({ kind: "path", folder, names: ["photos"], lens })).toBe(
      `~efs/o/${f}/photos?lens=0x${"11".repeat(20)}`,
    );
    // No names is an object link, never a second spelling of one.
    expect(() => link({ kind: "path", folder, names: [] })).toThrow(/at least one name/);
    expect(() => link({ kind: "path", folder, names: ["a/b"] })).toThrow(/files-name\/3/);
    expect(() => link({ kind: "path", folder: "0x12" as never, names: ["a"] })).toThrow(/64 hex/);
  });
});

describe("bad-word details are a closed union (WordDetail)", () => {
  // A Record over the union: a value added to or removed from WordDetail is a type error here, as in a client's map.
  const ALL: Record<WordDetail, true> = {
    length: true,
    "malformed-utf8": true,
    slash: true,
    control: true,
    "forbidden-ascii": true,
    unfolded: true,
    "trailing-dot": true,
    "leading-dash": true,
    "address-shaped": true,
    "refused-character": true,
    "fold-refused": true,
  };
  it("WORD_DETAILS lists exactly the union", () => {
    expect([...WORD_DETAILS].sort()).toEqual(Object.keys(ALL).sort());
  });

  it("every chain word code reaches a detail (never a raw code), with the chain's code", () => {
    const topics = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../protocol-inputs/contracts/test/vectors/topics.json"),
        "utf8",
      ),
    ) as { words: { hex: string; code: number }[] };
    const keep: FoldStep = (segment) => ({ ok: true, word: segment }); // the word exactly as given
    const seen = new Set<number>();
    for (const w of topics.words) {
      if (w.code === 0 || w.code === 8) continue;
      // every byte escaped, so the segment carries the word's exact bytes
      const escaped = (w.hex.slice(2).match(/../g) ?? [])
        .map((h) => `%${h.toUpperCase()}`)
        .join("");
      const got = parseLink(`x/${escaped}`, { fold: keep });
      if (got.status !== "INVALID") continue; // a segment the link grammar can't carry is bad-escape, not a word
      if (got.rule !== "bad-word") continue;
      expect(WORD_DETAILS).toContain(got.detail);
      if (got.code !== undefined) seen.add(got.code);
    }
    // 2 (malformed UTF-8) never reaches the word rules through a link: the segment's escape is refused first
    // (bad-escape), and a fold returns a string, which is always well-formed. Every other code does.
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 3, 4, 6, 7, 9]);
  });

  it("a caller's fold that refuses gives detail fold-refused and its own rule, with no code", () => {
    const got = parseLink("cars/tesla", { fold: () => ({ ok: false, rule: "my-rule" }) });
    expect(got).toEqual({
      status: "INVALID",
      rule: "bad-word",
      segment: 0,
      word: "cars",
      detail: "fold-refused",
      foldRule: "my-rule",
    });
  });
});
