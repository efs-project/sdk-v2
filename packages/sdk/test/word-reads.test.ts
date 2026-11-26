// SPDX-License-Identifier: MIT
// A read by words never looks up a word the chain can't hold (the client's `a%E2%80%AEb`, 2026-11-26): a page for
// such a word would read "nobody used this word" when the word can't exist at all, and carry a bidi override into the
// page title. Every read that takes words folds them, then checks them with the chain's grammar (checkWord) before
// they become an id: a refused word is MISUSE, thrown before any request. Words: a bidi override, a zero-width
// joiner, a no-break space and a backslash (codes 7, 7, 7 and 3), alone and as the second word of a path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain/rpc.ts";
import { createEfs } from "../src/client.ts";
import { EfsFault } from "../src/core/errors.ts";
import { checkWord } from "../src/names/word.ts";
import {
  authorCount,
  labelOf,
  placeCount,
  topicBroader,
  topicChildren,
  topicItems,
  topicItemsMerged,
  topicName,
  topicSynonyms,
  wordPage,
} from "../src/tags/index.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
let requests = 0;
const fetch: FetchLike = async () => {
  requests++;
  throw new Error("no request should be made");
};
const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment, fetch });
const THING = `0x${"ab".repeat(32)}` as const;

const REFUSED = ["a\u202eb", "a\u200db", "a\u00a0b", "a\\b"];

/** Every read by words, called with `words` (a sync throw and a rejection both count). */
const READS: Record<string, (words: string[]) => unknown> = {
  topicItems: (w) => topicItems(efs, w),
  topicItemsMerged: (w) => topicItemsMerged(efs, w),
  topicChildren: (w) => topicChildren(efs, w),
  wordPage: (w) => wordPage(efs, w[w.length - 1] as string),
  placeCount: (w) => placeCount(efs, w),
  authorCount: (w) => authorCount(efs, w, THING),
  labelOf: (w) => labelOf(efs, w, { langs: ["en"] }),
  topicName: (w) => topicName(efs, w, { langs: ["en"] }),
  topicSynonyms: (w) => topicSynonyms(efs, w),
  topicBroader: (w) => topicBroader(efs, w),
};

async function outcome(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return "resolved";
  } catch (e) {
    return e;
  }
}

describe("reads by words refuse a word the chain refuses, before any request", () => {
  it("the words are ones the chain refuses (and the interim fold leaves as typed)", () => {
    expect(REFUSED.map((w) => checkWord(w))).toMatchObject([
      { ok: false, code: 7 },
      { ok: false, code: 7 },
      { ok: false, code: 7 },
      { ok: false, code: 3 },
    ]);
  });

  for (const [name, read] of Object.entries(READS))
    it(`${name}: MISUSE, and nothing is asked of the chain`, async () => {
      for (const word of REFUSED)
        for (const words of [[word], ["cars", word]]) {
          const before = requests;
          const e = await outcome(() => read(words));
          expect(e, `${name}(${JSON.stringify(words)})`).toBeInstanceOf(EfsFault);
          expect((e as EfsFault).code).toBe("MISUSE");
          expect(requests).toBe(before);
        }
    });
});
