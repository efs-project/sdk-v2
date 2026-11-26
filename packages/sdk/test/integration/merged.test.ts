// SPDX-License-Identifier: MIT
// topicItemsMerged on a real chain (tag spec 3.5): a topic's items with its Lens's synonyms, merged newest first on
// the global binding ordinal, one row per thing (the newest filing that shows, naming its list), across pages; a
// Lens author's "not this" at the viewed topic hiding a row that came through a synonym (spec 3.1's one walk, asked
// of lens[0..decider], or the whole Lens for the public tier), with a hidden row never marked seen; synonyms only from
// the Lens; word swaps of a multi-word path (registered paths, nearest first, last word first under the cap); and a
// synonym list that can't be read named in `missing`. Three accounts of anvil's public development mnemonic (indexes
// 24, 25 and 26, used by no other test file).
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, PrincipalId } from "../../src/core/hex.ts";
import { topicLookupReaderAbi, topicMineReaderAbi } from "../../src/generated/abis.ts";
import {
  homeId,
  type MergedPage,
  pathId,
  planDeny,
  planSame,
  planTag,
  topicItems,
  topicItemsMerged,
  topicTypesOf,
} from "../../src/tags/index.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const ella = mnemonicToAccount(MNEMONIC, { addressIndex: 24 });
const finn = mnemonicToAccount(MNEMONIC, { addressIndex: 25 });
const gus = mnemonicToAccount(MNEMONIC, { addressIndex: 26 });
const T = topicTypesOf(efs.deployment);
const journal = memoryJournal();
const writerFor = (account: typeof ella) =>
  createWriter(efs, { authorizer: { kind: "local", profile: "direct", account }, journal });
type W = Awaited<ReturnType<typeof writerFor>>;
let we: W;
let wf: W;
let wg: W;
let E: PrincipalId;
let F: PrincipalId;
let G: PrincipalId;
const lens = (...ps: PrincipalId[]) => ({ principals: ps });

const rpc = async (method: string, params: unknown[]) => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
};
const run = async (w: W, planned: Promise<unknown>) => {
  const p = (await planned) as { status: string; parts?: unknown[] };
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  expect((await w.runSequence(p.parts as never)).state).toBe("COMPLETE");
};
/** A thing: an address no other test files (the tag needs no record). */
const addr = (n: number) => `0x${"e1".repeat(18)}${n.toString(16).padStart(4, "0")}` as Address;
const thing = (n: number) => homeId(addr(n));
const tag = (w: W, topic: string[], n: number) =>
  run(w, planTag(efs, w, { topic, targets: [{ kind: "address", address: addr(n) }] }));
const deny = (w: W, topic: string[], n: number) =>
  run(w, planDeny(efs, w, { topic, targets: [{ kind: "address", address: addr(n) }] }));
const same = (w: W, topic: string[], other: string[]) => run(w, planSame(efs, w, { topic, other }));
const present = (p: MergedPage) => {
  if (p.status !== "PRESENT") throw new Error(`${p.status}: ${p.reason.detail}`);
  return p;
};
const rowsOf = (p: MergedPage) => present(p).rows.map((r) => [r.thing, r.via.how]);
const all = async (
  first: () => Promise<MergedPage>,
  more: (next: never) => Promise<MergedPage>,
) => {
  const pages = [present(await first())];
  for (let i = 0; i < 50; i++) {
    const last = pages[pages.length - 1] as Extract<MergedPage, { status: "PRESENT" }>;
    if (last.finished) break;
    pages.push(present(await more(last.next as never)));
  }
  return { pages, rows: pages.flatMap((p) => p.rows) };
};

beforeAll(async () => {
  for (const a of [ella, finn, gus])
    await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]);
  we = await writerFor(ella);
  wf = await writerFor(finn);
  wg = await writerFor(gus);
  E = we.principal;
  F = wf.principal;
  G = wg.principal;
});

describe("topicItemsMerged (fixture)", () => {
  it("merges a topic and its Lens synonyms newest first, and every row names the list it came from", async () => {
    await tag(we, ["ma1"], 1);
    await tag(we, ["ma2"], 2);
    await same(we, ["ma1"], ["ma2"]);
    await tag(we, ["ma1"], 3);
    await tag(we, ["ma2"], 4);
    for (const view of ["mine", "everyone"] as const) {
      const page = present(await topicItemsMerged(efs, ["ma1"], { view, lens: lens(E) }));
      expect(rowsOf(page)).toEqual([
        [thing(4), "same"],
        [thing(3), "self"],
        [thing(2), "same"],
        [thing(1), "self"],
      ]);
      expect(page.rows[0]?.via).toEqual({ place: pathId(T, ["ma2"]), how: "same", hops: 1 });
      expect(page.lists.map((l) => [l.place, l.how])).toEqual([
        [pathId(T, ["ma1"]), "self"],
        [pathId(T, ["ma2"]), "same"],
      ]);
      expect(page.missing).toEqual([]);
      expect(page.complete).toBe(true);
      expect(page.finished).toBe(true);
      expect(page.rows.every((r) => r.kind === "address")).toBe(true);
    }
  });

  it("one row per thing: the newest filing that shows wins, and a later sighting is a repeat", async () => {
    await same(we, ["mb1"], ["mb2"]);
    await tag(we, ["mb1"], 10);
    await tag(we, ["mb2"], 10);
    const page = present(await topicItemsMerged(efs, ["mb1"], { view: "mine", lens: lens(E) }));
    expect(rowsOf(page)).toEqual([[thing(10), "same"]]);
    expect(page.dedup).toEqual({ state: "COMPLETE", dropped: 1 });
  });

  it("pages through the merge with a cursor: the same rows in the same order, never repeated", async () => {
    await same(we, ["mc1"], ["mc2"]);
    for (let n = 20; n < 26; n++) await tag(we, [n % 2 ? "mc1" : "mc2"], n);
    const one = present(await topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E) }));
    const { pages, rows } = await all(
      () => topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E), rows: 1 }),
      (next) =>
        topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E), rows: 1, cursor: next }),
    );
    expect(rows.map((r) => r.thing)).toEqual(one.rows.map((r) => r.thing));
    expect(rows.map((r) => r.thing)).toEqual([25, 24, 23, 22, 21, 20].map(thing));
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages.slice(0, -1)) expect(p.finished).toBe(false);
    // A resumed list re-reads its last call: what was decided before is left out, never counted as a repeat.
    expect(pages.every((p) => p.dedup.dropped === 0)).toBe(true);
    // Two rows a page: each list returns two, one of each is shown, and the resumed list re-reads the one shown.
    const two = await all(
      () => topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E), rows: 2 }),
      (next) =>
        topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E), rows: 2, cursor: next }),
    );
    expect(two.rows.map((r) => r.thing)).toEqual([25, 24, 23, 22, 21, 20].map(thing));
    expect(two.pages.every((p) => p.dedup.dropped === 0)).toBe(true);
  });

  it("the merge waits for a list that may still hold a newer row: padding ahead of it never reorders the merge", async () => {
    // In ordinal order: /mi2 gets 93, /mi1 gets 95, then two of Gus's lone negatives at /mi1 (entries nobody says
    // yes to), /mi2 gets 97, /mi1 gets 98. With 2 entries a list, /mi1 reads 98 and a negative (its floor is 98, and
    // 95 is unread), while /mi2 reads 97 and 93: 97 and 93 must wait for /mi1 to reach 95.
    await same(we, ["mi1"], ["mi2"]);
    await tag(we, ["mi2"], 93);
    await tag(we, ["mi1"], 95);
    await deny(wg, ["mi1"], 94);
    await deny(wg, ["mi1"], 96);
    await tag(we, ["mi2"], 97);
    await tag(we, ["mi1"], 98);
    const o = { view: "everyone" as const, lens: lens(E), entries: 4 };
    const { pages, rows } = await all(
      () => topicItemsMerged(efs, ["mi1"], o),
      (next) => topicItemsMerged(efs, ["mi1"], { ...o, cursor: next }),
    );
    expect(rows.map((r) => r.thing)).toEqual([98, 97, 95, 93].map(thing));
    expect(pages.length).toBeGreaterThan(1);
  });

  it("a 'not this' at another synonym hides only that synonym's own row", async () => {
    await same(we, ["md1"], ["md2"]);
    await same(we, ["md1"], ["md3"]);
    await deny(we, ["md2"], 30);
    await tag(wf, ["md2"], 30);
    await tag(we, ["md3"], 30);
    const page = present(await topicItemsMerged(efs, ["md1"], { view: "everyone", lens: lens(E) }));
    expect(rowsOf(page)).toEqual([[thing(30), "same"]]);
    expect(page.rows[0]?.via.place).toBe(pathId(T, ["md3"]));
    expect(page.counts.hiddenAtViewed).toBe(0);
  });

  it("a 'not this' at the viewed topic hides a row from a synonym, asked of lens[0..decider] only", async () => {
    await same(we, ["me1"], ["me2"]);
    // x: Ella (lens 0) says "not this" at /me1; Finn (lens 1) files it at /me2. Finn decides the /me2 row, so
    // lens[0..1] is asked at /me1: Ella's "not this" hides it.
    await deny(we, ["me1"], 40);
    await tag(wf, ["me2"], 40);
    // y: Ella files it at /me2 (she decides that row), and Finn says "not this" at /me1: only lens[0..0] is asked,
    // so Ella's own yes beats a later Lens author's "not this".
    await tag(we, ["me2"], 41);
    await deny(wf, ["me1"], 41);
    for (const view of ["mine", "everyone"] as const) {
      const page = present(await topicItemsMerged(efs, ["me1"], { view, lens: lens(E, F) }));
      expect(rowsOf(page)).toEqual([[thing(41), "same"]]);
      expect(page.counts.hiddenAtViewed).toBe(1);
    }
    // The plain read of /me2 still shows both: the check is the merged view's, at the viewed topic.
    const plain = await topicItems(efs, ["me2"], { view: "mine", lens: lens(E, F) });
    expect(plain.status === "PRESENT" && plain.rows.map((r) => r.thing).sort()).toEqual(
      [thing(40), thing(41)].sort(),
    );
  });

  it("a row hidden at the viewed topic is never marked seen: an older filing that shows still appears", async () => {
    await same(we, ["mf1"], ["mf2"]);
    await same(we, ["mf1"], ["mf3"]);
    await deny(wf, ["mf1"], 50);
    await tag(we, ["mf2"], 50); // older, decided by Ella (lens 0): shown
    await tag(wf, ["mf3"], 50); // newer, decided by Finn (lens 1): Finn's own "not this" at /mf1 hides it
    const page = present(await topicItemsMerged(efs, ["mf1"], { view: "mine", lens: lens(E, F) }));
    expect(rowsOf(page)).toEqual([[thing(50), "same"]]);
    expect(page.rows[0]?.via.place).toBe(pathId(T, ["mf2"]));
    expect(page.counts.hiddenAtViewed).toBe(1);
    expect(page.dedup.dropped).toBe(0);
  });

  it("Everyone: a public-tier row from a synonym is asked of the whole Lens at the viewed topic", async () => {
    await same(we, ["mg1"], ["mg2"]);
    await tag(wg, ["mg2"], 60); // Gus is in nobody's Lens: the public tier
    await tag(wg, ["mg2"], 61);
    await deny(we, ["mg1"], 60);
    const page = present(await topicItemsMerged(efs, ["mg1"], { view: "everyone", lens: lens(E) }));
    expect(rowsOf(page)).toEqual([[thing(61), "same"]]);
    expect(page.rows[0]?.decider).toEqual({ kind: "public" });
    expect(page.counts.hiddenAtViewed).toBe(1);
  });

  it("the nobody-here shortcut trusts only a COMPLETE zero: any other coverage asks the heads", async () => {
    // Reuses /me1 (Ella's "not this" of x at /me1, Finn's x at /me2). The count says nobody stated anything at
    // (/me1, x): with PARTIAL coverage the heads are asked anyway, and Ella's "not this" still hides the row.
    const countSays = (coverage: number) =>
      createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({
          [sel(topicLookupReaderAbi, "authorCount")]: (result) => {
            const out = decodeFunctionResult({
              abi: topicLookupReaderAbi,
              functionName: "authorCount",
              data: result,
            }) as unknown as unknown[];
            return encodeFunctionResult({
              abi: topicLookupReaderAbi,
              functionName: "authorCount",
              result: [out[0], coverage, 0n, 0n] as never,
            }) as Hex;
          },
        }),
      });
    const partial = present(
      await topicItemsMerged(countSays(2), ["me1"], { view: "mine", lens: lens(E, F) }),
    );
    expect(rowsOf(partial)).toEqual([[thing(41), "same"]]);
    // A COMPLETE zero is the index vouching that nobody is there: no heads are asked, so x shows.
    const complete = present(
      await topicItemsMerged(countSays(3), ["me1"], { view: "mine", lens: lens(E, F) }),
    );
    expect(
      rowsOf(complete)
        .map(([t]) => t)
        .sort(),
    ).toEqual([thing(40), thing(41)].sort());
  });

  it("synonyms come only from the Lens: a stranger's 'same' merges nothing into the view", async () => {
    await same(wg, ["mh1"], ["mh2"]);
    await tag(wg, ["mh2"], 70);
    for (const view of ["mine", "everyone"] as const) {
      const page = present(await topicItemsMerged(efs, ["mh1"], { view, lens: lens(E) }));
      expect(page.lists.map((l) => l.how)).toEqual(["self"]);
      expect(page.rows).toEqual([]);
    }
    const withGus = present(
      await topicItemsMerged(efs, ["mh1"], { view: "everyone", lens: lens(E, G) }),
    );
    expect(rowsOf(withGus)).toEqual([[thing(70), "same"]]);
  });

  it("word swaps: a multi-word path takes its words' synonyms, registered paths only, nearest first, last word first", async () => {
    await same(we, ["mcarz"], ["mcar"]);
    await same(we, ["mtsl"], ["mtslz"]);
    await same(we, ["mtsl"], ["mtslq"]); // /mcarz/mtslq and /mcar/mtslq are never registered: no lists
    await tag(we, ["mcarz", "mtsl"], 80); // the viewed topic
    await tag(we, ["mcar", "mtsl"], 81); // one swap (the first word)
    await tag(we, ["mcarz", "mtslz"], 82); // one swap (the last word)
    await tag(we, ["mcar", "mtslz"], 83); // two swaps
    const page = present(
      await topicItemsMerged(efs, ["mcarz", "mtsl"], { view: "mine", lens: lens(E) }),
    );
    expect(page.lists.map((l) => [l.place, l.how, l.hops])).toEqual([
      [pathId(T, ["mcarz", "mtsl"]), "self", 0],
      [pathId(T, ["mcarz", "mtslz"]), "swap", 1],
      [pathId(T, ["mcar", "mtsl"]), "swap", 1],
      [pathId(T, ["mcar", "mtslz"]), "swap", 2],
    ]);
    expect(rowsOf(page)).toEqual([
      [thing(83), "swap"],
      [thing(82), "swap"],
      [thing(81), "swap"],
      [thing(80), "self"],
    ]);
    // Under a cap of two lists, the last word's swap is kept, and the cut is reported.
    const capped = present(
      await topicItemsMerged(efs, ["mcarz", "mtsl"], {
        view: "mine",
        lens: lens(E),
        synonyms: { maxLists: 2 },
      }),
    );
    expect(capped.lists.map((l) => l.place)).toEqual([
      pathId(T, ["mcarz", "mtsl"]),
      pathId(T, ["mcarz", "mtslz"]),
    ]);
    expect(capped.synonyms.limited).toBe(true);
    expect(capped.complete).toBe(false);
    // One hop allowed: the two-swap path is left out.
    const near = present(
      await topicItemsMerged(efs, ["mcarz", "mtsl"], {
        view: "mine",
        lens: lens(E),
        synonyms: { maxHops: 1 },
      }),
    );
    expect(near.lists.map((l) => l.hops)).toEqual([0, 1, 1]);
  });

  it("a synonym list the chain refuses is named in `missing`, and the rest still shows; the topic's own refused is INVALID", async () => {
    // Reuses /ma1 and /ma2.
    const refuse = (place: Hex) => {
      const edit: Edit = (result) => {
        const out = decodeFunctionResult({
          abi: topicMineReaderAbi,
          functionName: "mine",
          data: result,
        }) as unknown as [Record<string, unknown>, Record<string, unknown>[]];
        if (!out[1].some((r) => String(r["topic"]).toLowerCase() === place)) return result;
        const q = out[0]["q"] as Record<string, unknown>;
        return encodeFunctionResult({
          abi: topicMineReaderAbi,
          functionName: "mine",
          result: [{ ...out[0], q: { ...q, status: 12 } }, out[1]] as never,
        }) as Hex;
      };
      return createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({ [sel(topicMineReaderAbi, "mine")]: edit }),
      });
    };
    const synonymRefused = present(
      await topicItemsMerged(refuse(pathId(T, ["ma2"])), ["ma1"], { view: "mine", lens: lens(E) }),
    );
    expect(rowsOf(synonymRefused)).toEqual([
      [thing(3), "self"],
      [thing(1), "self"],
    ]);
    expect(synonymRefused.missing).toMatchObject([
      {
        place: pathId(T, ["ma2"]),
        how: "same",
        status: "INVALID",
        reason: { code: "LIMIT_EXCEEDED" },
      },
    ]);
    expect(synonymRefused.complete).toBe(false);
    expect(synonymRefused.coverage).toBe("PARTIAL");
    expect(synonymRefused.finished).toBe(true);
    expect(
      await topicItemsMerged(refuse(pathId(T, ["ma1"])), ["ma1"], { view: "mine", lens: lens(E) }),
    ).toMatchObject({ status: "INVALID", reason: { code: "LIMIT_EXCEEDED" } });
  });

  it("a list whose entries do not strictly fall is the endpoint's fault: UNKNOWN, never a row", async () => {
    const swapped = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({
        [sel(topicMineReaderAbi, "mine")]: (result) => {
          const out = decodeFunctionResult({
            abi: topicMineReaderAbi,
            functionName: "mine",
            data: result,
          }) as unknown as [unknown, unknown[]];
          return encodeFunctionResult({
            abi: topicMineReaderAbi,
            functionName: "mine",
            result: [out[0], [...out[1]].reverse()] as never,
          }) as Hex;
        },
      }),
    });
    expect(await topicItemsMerged(swapped, ["ma1"], { view: "mine", lens: lens(E) })).toMatchObject(
      { status: "UNKNOWN" },
    );
  });

  it("kinds filter the merged rows too, counting what they leave out", async () => {
    const page = present(
      await topicItemsMerged(efs, ["ma1"], { view: "mine", lens: lens(E), kinds: ["folder"] }),
    );
    expect(page.rows).toEqual([]);
    expect(page.counts.filtered).toBe(4);
    expect(page.finished).toBe(true);
  });

  it("MISUSE: Raw (no Lens, so no synonyms), a home, and a cursor from another listing", async () => {
    await expect(
      topicItemsMerged(efs, ["ma1"], { view: "raw" as never, lens: lens(E) }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    await expect(
      topicItemsMerged(efs, { kind: "home", address: ella.address }, { lens: lens(E) }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    const first = present(
      await topicItemsMerged(efs, ["mc1"], { view: "mine", lens: lens(E), rows: 1 }),
    );
    await expect(
      topicItemsMerged(efs, ["ma1"], { view: "mine", lens: lens(E), cursor: first.next as never }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    await expect(
      topicItemsMerged(efs, ["mc1"], {
        view: "everyone",
        lens: lens(E),
        cursor: first.next as never,
      }),
    ).rejects.toMatchObject({ code: "MISUSE" });
  });
});
