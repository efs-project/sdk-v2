// SPDX-License-Identifier: MIT
// Topics against the contracts' own vectors (test/vectors/topics.json and numbers.json): the word and text grammars
// with the chain's refusal codes (TopicProfile.wordRefusal / textRefusal), word-page, path, text and property ids,
// the binding number's law, and the exact actions every EfsTopics builder writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, hexToBytes, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { actionsHash } from "../src/actions/plan.ts";
import type { ActionData } from "../src/actions/types.ts";
import type { Hex } from "../src/core/hex.ts";
import { MAX_STRENGTH } from "../src/generated/constants.ts";
import {
  broaderAction,
  checkText,
  checkWord,
  childId,
  denyAction,
  labelActions,
  labelKey,
  numberOf,
  pathId,
  propertyAction,
  propertyKey,
  registerPathActions,
  sameAction,
  strengthOf,
  type TopicTypes,
  tagAction,
  textRecordId,
  untagAction,
  wordPageId,
} from "../src/tags/topics.ts";

const IN = join(import.meta.dirname, "../../../protocol-inputs/contracts/test/vectors");
const topics = JSON.parse(readFileSync(join(IN, "topics.json"), "utf8"));
const numbers = JSON.parse(readFileSync(join(IN, "numbers.json"), "utf8"));
const T: TopicTypes = {
  word: topics.typeIds["topic-word/1"],
  path: topics.typeIds["topic/1"],
  text: topics.typeIds["text/1"],
};
const bytes = (h: string) => hexToBytes(h as Hex);
const bodiesHash = (bodies: readonly Hex[]) =>
  keccak256(encodeAbiParameters([{ type: "bytes[]" }], [bodies as Hex[]]));
const norm = (a: ActionData) =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [
      k,
      typeof v === "bigint" ? String(v) : String(v).toLowerCase(),
    ]),
  );

describe("the word grammar (TopicProfile.wordRefusal)", () => {
  it.each(topics.words as { label: string; hex: string; code: number; pageId?: string }[])(
    "$label: code $code",
    ({ hex, code, pageId }) => {
      const c = checkWord(bytes(hex));
      expect(c.ok ? 0 : c.code).toBe(code);
      if (code === 0 && pageId) expect(wordPageId(T, bytes(hex))).toBe(pageId.toLowerCase());
    },
  );
});

describe("the text grammar (TopicProfile.textRefusal)", () => {
  it.each(topics.texts as { label: string; hex: string; code: number; recordId?: string }[])(
    "$label: code $code",
    ({ hex, code, recordId }) => {
      const c = checkText(bytes(hex));
      expect(c.ok ? 0 : c.code).toBe(code);
      if (code === 0 && recordId) expect(textRecordId(T, bytes(hex))).toBe(recordId.toLowerCase());
    },
  );
});

describe("topic ids", () => {
  it.each(topics.paths as { words: string[]; pageIds: string[]; id: string }[])(
    "the path /$words",
    ({ words, pageIds, id }) => {
      expect(words.map((w) => wordPageId(T, w))).toEqual(pageIds.map((p) => p.toLowerCase()));
      expect(pathId(T, words)).toBe(id.toLowerCase());
      if (words.length > 1)
        expect(childId(T, pathId(T, words.slice(0, -1)), words[words.length - 1] as string)).toBe(
          id.toLowerCase(),
        );
    },
  );
  it.each(topics.propertyKeys as { key: string; id: string }[])(
    "the property key $key",
    ({ key, id }) => {
      expect(propertyKey(key)).toBe(id.toLowerCase());
    },
  );
  it("a label key is the property key of label:<lang>", () => {
    expect(labelKey("en")).toBe(propertyKey("label:en"));
  });
  it("refuses to id a word the chain refuses, with its code", () => {
    expect(() => wordPageId(T, "Tesla")).toThrow(/code 3/);
    expect(() => pathId(T, [])).toThrow(/at least one word/);
  });
});

describe("the binding number (BindingNumber)", () => {
  it.each(numbers.numbers as { state: number; strength: number; has: boolean; number: number }[])(
    "state $state, strength $strength",
    ({ state, strength, has, number }) => {
      expect(numberOf(state, strength)).toBe(has ? number : null);
    },
  );
  it("a number is a BIND's strength (n ≥ 0) or an UNBIND's (−1 − n), and nothing outside the range", () => {
    expect(MAX_STRENGTH).toBe(numbers.maxStrength);
    expect(strengthOf(0)).toEqual({ unbind: false, strength: 0 });
    expect(strengthOf(75)).toEqual({ unbind: false, strength: 75 });
    expect(strengthOf(-1)).toEqual({ unbind: true, strength: 0 });
    expect(strengthOf(-65_536)).toEqual({ unbind: true, strength: 65_535 });
    for (const bad of [65_536, -65_537, 1.5, Number.NaN])
      expect(() => strengthOf(bad)).toThrow(/number/);
  });
});

describe("the EfsTopics builders", () => {
  const home = topics.inputs.home as Hex;
  const thing = topics.inputs.thing as Hex;
  const cars = pathId(T, ["cars"]);
  const tesla = pathId(T, ["cars", "tesla"]);
  const ours: Record<string, { actions: ActionData[]; bodies: Hex[] }> = {
    "register the word tesla": registerPathActions(T, ["tesla"]),
    "register /cars/tesla/model_y": registerPathActions(T, ["cars", "tesla", "model_y"]),
    // Only what is missing: the pages by word index, the path records by prefix length (2..n).
    "one new leaf /cars/tesla/model_3 with its page": registerPathActions(
      T,
      ["cars", "tesla", "model_3"],
      { pages: [2], paths: [3] },
    ),
    "one new leaf on an existing page": registerPathActions(T, ["cars", "tesla"], {
      pages: [],
      paths: [2],
    }),
    "tag a thing in /cars/tesla with +75": one(tagAction(tesla, thing, 0n, 75)),
    "tag a home with 0": one(tagAction(home, thing, 0n, 0)),
    "not this, a lone negative (-1)": one(denyAction(cars, thing, 0n, -1)),
    "a negative change -1 -> -5 at revision 1": one(denyAction(cars, thing, 1n, -5)),
    "a property with an address value": one(
      propertyAction(cars, propertyKey("moved-to"), home, 0n),
    ),
    "label /cars/tesla in English": labelActions(T, tesla, "en", "Tesla, Inc.", 0n),
    "/cars/tesla is the same as /tesla": one(sameAction(tesla, pathId(T, ["tesla"]), 0n)),
    "/cars/tesla is narrower than /cars": one(broaderAction(tesla, cars, 0n)),
  };
  function one(a: ActionData) {
    return { actions: [a], bodies: ["0x" as Hex] };
  }
  it.each(
    topics.builders as {
      label: string;
      actions: ActionData[];
      bodies: Hex[];
      actionsHash: Hex;
      bodiesHash: Hex;
    }[],
  )("$label", (b) => {
    const got = ours[b.label];
    if (!got) throw new Error(`no SDK builder for "${b.label}"`);
    expect(got.actions.map(norm)).toEqual(b.actions.map(norm));
    expect(got.bodies.map((x) => x.toLowerCase())).toEqual(b.bodies.map((x) => x.toLowerCase()));
    expect(actionsHash(got.actions)).toBe(b.actionsHash.toLowerCase());
    expect(bodiesHash(got.bodies)).toBe(b.bodiesHash.toLowerCase());
  });
  it("untag is a RELEASE with nothing in it but the position", () => {
    const a = untagAction(tesla, thing, 3n);
    expect(a).toMatchObject({ kind: 7, subject: tesla, role: thing, expectedRevision: 3n });
    expect(BigInt(a.saltOrStrength)).toBe(0n);
  });
});
