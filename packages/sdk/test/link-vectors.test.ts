// SPDX-License-Identifier: MIT
// The link grammar against its vectors (test/vectors/links.json): object, revision, home and topic links, the
// reserved `~` segments, escapes, and the pluggable fold (a stand-in here; the real rule is efs/fold/1, to be chosen).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FoldStep, link, parseLink } from "../src/names/links.ts";

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
    const got = parseLink(input, fold === "ascii-test" ? { fold: asciiTest } : {});
    expect(got).toEqual(want);
    // Every OK parse round-trips: its canonical form parses to the same target.
    if (got.status === "OK") {
      const again = parseLink(got.canonical, fold === "ascii-test" ? { fold: asciiTest } : {});
      expect(again).toMatchObject({ status: "OK", canonical: got.canonical });
    }
  });

  it("formats topic and home links from their parts, and refuses parts the grammar refuses", () => {
    expect(link({ kind: "topic", segments: [], words: ["cars", "tesla"] })).toBe("cars/tesla");
    expect(() => link({ kind: "topic", segments: ["Cars"] })).toThrow(/folded words/);
    expect(() => link({ kind: "topic", segments: [], words: ["Cars"] })).toThrow(/unfolded/);
    expect(() => link({ kind: "topic", segments: [], words: ["~efs"] })).toThrow(/reserved-tilde/);
    const address = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01" as const;
    expect(link({ kind: "home", address, names: ["Photos", "cat 1.jpg"] })).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01/Photos/cat%201.jpg",
    );
    expect(() => link({ kind: "home", address, names: ["a/b"] })).toThrow(/files-name\/2/);
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
    expect(() => link({ kind: "path", folder, names: ["a/b"] })).toThrow(/files-name\/2/);
    expect(() => link({ kind: "path", folder: "0x12" as never, names: ["a"] })).toThrow(/64 hex/);
  });
});
