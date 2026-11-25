// SPDX-License-Identifier: MIT
// Tags on a real chain (the tag release): registration strictly before the first tag, the 16-bit number, lone
// negatives, number changes and untags, and the topic readers' views with the page laws: Mine, Everyone and Raw,
// exact and roll-up; who decided each row; a short or padded page that is never the end; repeats removed by thing
// across pages; and restore's alsoPlaced, which tags never change. Two accounts of anvil's public development
// mnemonic (indexes 13 and 14, used by no other test file), funded here.
import { readFileSync } from "node:fs";
import { decodeFunctionData, decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { budgetOf, gasPlanFor, packBatches } from "../../src/actions/split.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, PrincipalId, RecordId } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planCreateFolder,
  planRemoveEntries,
  planRestoreEntries,
} from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import {
  topicEveryoneReaderAbi,
  topicLookupReaderAbi,
  topicMineReaderAbi,
} from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { positionKey } from "../../src/protocol/keys.ts";
import {
  authorCount,
  homeId,
  pathId,
  placeCount,
  planDeny,
  planTag,
  planUntag,
  type TopicPage,
  tagsOf,
  topicChildren,
  topicItems,
  topicPath,
  topicTypesOf,
  wordPage,
} from "../../src/tags/index.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const MNEMONIC = "test test test test test test test test test test test junk";
const ann = mnemonicToAccount(MNEMONIC, { addressIndex: 13 });
const ben = mnemonicToAccount(MNEMONIC, { addressIndex: 14 });
const T = topicTypesOf(efs.deployment);
const text = (s: string) => new TextEncoder().encode(s);
const journal = memoryJournal();
const writerFor = (account: typeof ann) =>
  createWriter(efs, { authorizer: { kind: "local", profile: "direct", account }, journal });
let wa: Awaited<ReturnType<typeof writerFor>>;
let wb: Awaited<ReturnType<typeof writerFor>>;
let A: PrincipalId;
let B: PrincipalId;
let folder: FolderRef;
const files: { kind: "file"; subject: Hex }[] = [];

const rpc = async (method: string, params: unknown[]) => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
};
const run = async (
  writer: typeof wa,
  planned: Promise<{ status: string } & Record<string, unknown>>,
) => {
  const p = (await planned) as {
    status: string;
    parts?: unknown[];
    review?: Record<string, unknown>;
  };
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  expect((await writer.runSequence(p.parts as never)).state).toBe("COMPLETE");
  return p.review as Record<string, unknown>;
};
/** Every row of a listing, page by page, with the pages' shapes. */
const all = async (first: () => Promise<TopicPage>, more: (next: never) => Promise<TopicPage>) => {
  const pages: TopicPage[] = [await first()];
  for (let i = 0; i < 50; i++) {
    const last = pages[pages.length - 1] as TopicPage;
    if (last.status !== "PRESENT") throw new Error(`${last.status}: ${last.reason.detail}`);
    if (last.finished) break;
    pages.push(await more(last.next as never));
  }
  const rows = pages.flatMap((p) => (p.status === "PRESENT" ? p.rows : []));
  return { pages, rows };
};

beforeAll(async () => {
  for (const a of [ann, ben]) await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]);
  wa = await writerFor(ann);
  wb = await writerFor(ben);
  A = wa.principal;
  B = wb.principal;
  const made = await run(
    wa,
    planCreateFolder(efs, wa, { folder: root, name: "tags-test" }) as never,
  );
  folder = made["created"] as FolderRef;
  for (const n of ["f0.txt", "f1.txt", "f2.txt", "f3.txt"]) {
    const r = await run(
      wa,
      planCreateFile(efs, wa, { folder, name: n, content: text(n) }) as never,
    );
    files.push(r["file"] as { kind: "file"; subject: Hex });
  }
});

describe("tags (fixture)", () => {
  it("tags a file in a new 3-word topic: the topics are registered first, in one save, and it reads back", async () => {
    const words = ["cars", "tesla", "model_y"];
    const review = await run(
      wa,
      planTag(efs, wa, { topic: words, targets: [files[0] as never], number: 75 }) as never,
    );
    expect(review["newTopics"]).toEqual([
      { words: ["cars"], id: pathId(T, ["cars"]) },
      { words: ["cars", "tesla"], id: pathId(T, ["cars", "tesla"]) },
      { words, id: pathId(T, words) },
    ]);
    expect(review["records"]).toBe(5); // three word pages, two path records
    expect(review["statements"]).toMatchObject([{ number: 75, before: null, first: true }]);
    const mine = await topicItems(efs, words, { view: "mine", lens: { principals: [A] } });
    expect(mine).toMatchObject({ status: "PRESENT", finished: true });
    expect(mine.status === "PRESENT" && mine.rows).toMatchObject([
      {
        thing: files[0]?.subject,
        number: 75,
        decider: { kind: "lens", index: 0, author: A, number: 75 },
      },
    ]);
    // Everyone through a Lens of a stranger: someone says yes, so the public tier decides.
    const ev = await topicItems(efs, words, { view: "everyone", lens: { principals: [B] } });
    expect(ev.status === "PRESENT" && ev.rows).toMatchObject([
      { thing: files[0]?.subject, decider: { kind: "public" }, yes: 1n, statements: 1n },
    ]);
    // The roll-up of /cars shows it, filed under /cars/tesla/model_y.
    const below = await topicItems(efs, ["cars"], {
      view: "mine",
      lens: { principals: [A] },
      below: true,
    });
    expect(below.status === "PRESENT" && below.rows).toMatchObject([
      { thing: files[0]?.subject, topic: pathId(T, words) },
    ]);
    // The topic's words come back from its records.
    expect(await topicPath(efs, pathId(T, words))).toMatchObject({ status: "PRESENT", words });
  });

  it("a stranger's 'not this' neither hides a row nor adds one; a Lens author's hides it from that Lens", async () => {
    const words = ["cars", "tesla", "model_y"];
    await run(wb, planDeny(efs, wb, { topic: words, targets: [files[0] as never] }) as never);
    // Lens A: A's yes decides; Lens B: B's no hides it; Lens [stranger]: the public tier still shows it.
    const byA = await topicItems(efs, words, { lens: { principals: [A, B] } });
    expect(byA.status === "PRESENT" && byA.rows).toMatchObject([
      { decider: { kind: "lens", author: A } },
    ]);
    const byB = await topicItems(efs, words, { lens: { principals: [B, A] } });
    expect(byB.status === "PRESENT" && byB.rows).toEqual([]);
    expect(await authorCount(efs, words, files[0]?.subject as Hex)).toMatchObject({
      status: "PRESENT",
      statements: 2n,
      yes: 1n,
    });
    // Raw applies no rule.
    const raw = await topicItems(efs, words, { view: "raw" });
    expect(raw.status === "PRESENT" && raw.rows).toMatchObject([{ decider: { kind: "none" } }]);
    // A lone negative on a thing nobody tagged: listed in Raw, never in Everyone.
    await run(
      wb,
      planDeny(efs, wb, { topic: words, targets: [files[1] as never], number: -5 }) as never,
    );
    const ev = await topicItems(efs, words, { lens: { principals: [A] } });
    expect(ev.status === "PRESENT" && ev.rows.map((r) => r.thing)).toEqual([files[0]?.subject]);
    const raw2 = await topicItems(efs, words, { view: "raw" });
    expect(raw2.status === "PRESENT" && raw2.rows.map((r) => r.thing).sort()).toEqual(
      [files[0]?.subject, files[1]?.subject].sort(),
    );
  });

  it("the number: a change is one re-bind, the same number is UNCHANGED, and untag says nothing again", async () => {
    const words = ["cars", "tesla", "model_y"];
    const changed = await run(
      wa,
      planTag(efs, wa, { topic: words, targets: [files[0] as never], number: 3 }) as never,
    );
    expect(changed["statements"]).toMatchObject([{ number: 3, before: 75, first: false }]);
    expect(changed["newTopics"]).toEqual([]);
    // An existing topic republishes nothing: every word page is found, not only the path records.
    expect(changed["records"]).toBe(0);
    expect(
      await planTag(efs, wa, { topic: words, targets: [files[0] as never], number: 3 }),
    ).toMatchObject({ status: "REFUSED", refused: [{ index: 0, code: "UNCHANGED" }] });
    await run(wa, planUntag(efs, wa, { topic: words, targets: [files[0] as never] }) as never);
    const mine = await topicItems(efs, words, { view: "mine", lens: { principals: [A] } });
    expect(mine.status === "PRESENT" && mine.rows).toEqual([]);
    expect(await planUntag(efs, wa, { topic: words, targets: [files[0] as never] })).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 0, code: "NOT_STATED" }],
    });
    // Out of range numbers and refused words never reach a plan.
    await expect(
      planTag(efs, wa, { topic: words, targets: [files[0] as never], number: 65_536 }),
    ).rejects.toThrow(/number/);
    await expect(
      planTag(efs, wa, { topic: ["Cars"], targets: [files[0] as never] }),
    ).rejects.toThrow(/code 3/);
  });

  it("a short page is never the end: lone negatives ahead of one real tag page through to it", async () => {
    const words = ["padded"];
    // The real tag first, then nine lone negatives on other things (newer, so read first).
    await run(wa, planTag(efs, wa, { topic: words, targets: [files[2] as never] }) as never);
    const others = Array.from({ length: 9 }, (_, i) => ({
      kind: "address" as const,
      address: `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex,
    }));
    await run(wb, planDeny(efs, wb, { topic: words, targets: others as never }) as never);
    const { pages, rows } = await all(
      () => topicItems(efs, words, { lens: { principals: [A] }, entries: 3 }),
      (next) => topicItems(efs, words, { lens: { principals: [A] }, entries: 3, cursor: next }),
    );
    expect(rows.map((r) => r.thing)).toEqual([files[2]?.subject]);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages.slice(0, -1)) {
      expect(p).toMatchObject({ status: "PRESENT", finished: false });
      expect(p.status === "PRESENT" && p.next).toBeTruthy();
    }
    expect(pages.slice(0, -1).some((p) => p.status === "PRESENT" && p.rows.length === 0)).toBe(
      true,
    );
    expect(pages[pages.length - 1]).toMatchObject({ finished: true, scan: "EXHAUSTED" });
    expect(await placeCount(efs, words)).toMatchObject({ status: "PRESENT", positionsEver: 10n });
  });

  it("a roll-up removes repeats by thing across pages: one row for a thing filed under two children", async () => {
    await run(
      wa,
      planTag(efs, wa, { topic: ["brands", "x"], targets: [files[3] as never] }) as never,
    );
    await run(
      wa,
      planTag(efs, wa, { topic: ["brands", "y"], targets: [files[3] as never] }) as never,
    );
    await run(
      wa,
      planTag(efs, wa, { topic: ["brands", "z"], targets: [files[2] as never] }) as never,
    );
    const { rows, pages } = await all(
      () =>
        topicItems(efs, ["brands"], {
          view: "mine",
          lens: { principals: [A] },
          below: true,
          rows: 1,
        }),
      (next) =>
        topicItems(efs, ["brands"], {
          view: "mine",
          lens: { principals: [A] },
          below: true,
          rows: 1,
          cursor: next,
        }),
    );
    expect(rows.map((r) => r.thing).sort()).toEqual([files[2]?.subject, files[3]?.subject].sort());
    // The newest filing that shows is the one kept: /brands/y for files[3].
    expect(rows.find((r) => r.thing === files[3]?.subject)?.topic).toBe(pathId(T, ["brands", "y"]));
    expect(pages.every((p) => p.status === "PRESENT" && p.dedup.state === "COMPLETE")).toBe(true);
    // The directory: /brands has three children, each with its own word.
    const kids = await topicChildren(efs, ["brands"]);
    expect(kids.status === "PRESENT" && kids.rows.map((r) => r.word).sort()).toEqual([
      "x",
      "y",
      "z",
    ]);
    // The word page of "x": the root /x is not registered, so its one place is /brands/x.
    const wp = await wordPage(efs, "x");
    expect(
      wp.status === "PRESENT" && wp.rows.some((r) => r.topic === pathId(T, ["brands", "x"])),
    ).toBe(true);
    // tagsOf: every place files[3] is filed at.
    const of = await tagsOf(efs, files[3]?.subject as Hex);
    expect(of.status === "PRESENT" && of.rows.map((r) => r.topic).sort()).toEqual(
      [pathId(T, ["brands", "x"]), pathId(T, ["brands", "y"])].sort(),
    );
  });

  it("a home is a place: tags at an address need no record, and its id is the padded address", async () => {
    const home = { kind: "home" as const, address: ann.address };
    const review = await run(
      wa,
      planTag(efs, wa, { topic: home, targets: [files[1] as never], number: 1 }) as never,
    );
    expect(review["place"]).toMatchObject({ kind: "home", id: homeId(ann.address) });
    expect(review["records"]).toBe(0);
    const page = await topicItems(efs, home, { view: "mine", lens: { principals: [A] } });
    expect(page.status === "PRESENT" && page.rows.map((r) => r.thing)).toEqual([files[1]?.subject]);
  });

  it("a deep new path registers in earlier parts, the tag last, and never a shortened path", async () => {
    const words = Array.from({ length: 64 }, (_, i) => `deep${i}`);
    const p = await planTag(efs, wa, { topic: words, targets: [files[0] as never] });
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(p.review.newTopics.length).toBe(64);
    expect(p.parts.length).toBeGreaterThan(1);
    const last = p.parts[p.parts.length - 1];
    expect(last?.effects.map((e) => e.code)).toContain("tags.tag");
    expect(
      p.parts.slice(0, -1).every((x) => x.effects.every((e) => e.code === "tags.register")),
    ).toBe(true);
    expect((await wa.runSequence(p.parts)).state).toBe("COMPLETE");
    const mine = await topicItems(efs, words, { view: "mine", lens: { principals: [A] } });
    expect(mine.status === "PRESENT" && mine.rows.map((r) => r.thing)).toEqual([files[0]?.subject]);
  });

  it("restore's alsoPlaced counts folder placements only: a tag on the file never changes it", async () => {
    const made = await run(
      wa,
      planCreateFile(efs, wa, { folder, name: "also.txt", content: text("also") }) as never,
    );
    const file = made["file"] as { kind: "file"; subject: Hex };
    await run(wa, planRemoveEntries(efs, wa, { entries: [{ folder, name: "also.txt" }] }) as never);
    const before = await planRestoreEntries(efs, wa, { entries: [{ folder, name: "also.txt" }] });
    if (before.status !== "PLANNED") throw new Error(before.status);
    await run(wa, planTag(efs, wa, { topic: ["also"], targets: [file as never] }) as never);
    const after = await planRestoreEntries(efs, wa, { entries: [{ folder, name: "also.txt" }] });
    if (after.status !== "PLANNED") throw new Error(after.status);
    expect(after.review.entries[0]?.alsoPlaced).toBe(before.review.entries[0]?.alsoPlaced);
    expect(after.review.entries[0]?.alsoPlaced).toBe(0);
  });
});

/** The fixture behind a fetch whose `fn` replies (of `abi`) pass through `f`, decoded and re-encoded. */
const forged = (abi: readonly unknown[], fn: string, f: (out: unknown[]) => unknown[]) => {
  const edit: Edit = (result) => {
    const out = decodeFunctionResult({
      abi: abi as never,
      functionName: fn,
      data: result,
    } as never) as unknown[];
    return encodeFunctionResult({
      abi: abi as never,
      functionName: fn,
      result: f(out) as never,
    } as never) as Hex;
  };
  return createEfs({
    rpcs: [fixture.rpcUrl],
    deployment,
    fetch: tampered({ [sel(abi, fn)]: edit }),
  });
};
const stranger = `0x${"0".repeat(24)}${"56".repeat(20)}` as PrincipalId;
const rowsOf = (out: unknown[]) => out[1] as Record<string, unknown>[];

describe("tag reads refuse a tampered endpoint (fixture)", () => {
  const words = ["brands", "x"];
  it("a row whose position is not its (topic, thing): UNKNOWN, never a row", async () => {
    const lying = forged(topicMineReaderAbi, "mine", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, thing: `0x${"77".repeat(32)}` })),
    ]);
    expect(
      await topicItems(lying, words, { view: "mine", lens: { principals: [A] } }),
    ).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("a Mine row that names an author who is not at that Lens index: UNKNOWN, never a borrowed author", async () => {
    const lying = forged(topicMineReaderAbi, "mine", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, principalId: stranger })),
    ]);
    expect(
      await topicItems(lying, words, { view: "mine", lens: { principals: [A] } }),
    ).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("tagsOf: a place whose position does not name the thing: UNKNOWN", async () => {
    const lying = forged(topicLookupReaderAbi, "about", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, position: `0x${"66".repeat(32)}` })),
    ]);
    expect(await tagsOf(lying, files[3]?.subject as Hex)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("a word page listing a place whose word is another: UNKNOWN, never labelled with the word asked for", async () => {
    const other = pathId(T, ["brands", "y"]);
    const lying = forged(topicLookupReaderAbi, "wordPage", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, place: other })),
    ]);
    expect(await wordPage(lying, "x")).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("a page that is not the end but gives no resume point: UNKNOWN, never a cursor that can't move", async () => {
    const lying = forged(topicLookupReaderAbi, "children", (out) => [
      { ...(out[0] as Record<string, unknown>), next: "0x" },
      out[1],
    ]);
    expect(await topicChildren(lying, ["brands"], { limit: 1 })).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });
});

describe("tags: the review's cases (fixture)", () => {
  const deep = Array.from({ length: 64 }, (_, i) => `deep${i}`);
  it("deep first tags: every atomic batch packBatches makes stays within one transaction's budget", async () => {
    const targets = Array.from({ length: 20 }, (_, i) => ({
      kind: "address" as const,
      address: `0x${(0xd00 + i).toString(16).padStart(40, "0")}` as Hex,
    }));
    const p = await planTag(efs, wa, { topic: deep, targets: targets as never });
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(p.review.records).toBe(0); // the topic exists already
    expect(p.parts.length).toBeGreaterThan(1);
    const g = gasPlanFor(efs.deployment);
    if (!g.ok) throw new Error(g.reason.code);
    const budget = budgetOf(g.txGasCap, g.headroom);
    for (const part of p.parts) expect(part.gas).toBeGreaterThan(0);
    for (const batch of packBatches(p.parts, g)) {
      const sum = batch.reduce((n, k) => n + (p.parts[k]?.gas ?? Number.POSITIVE_INFINITY), 0);
      if (batch.length > 1) expect(sum).toBeLessThanOrEqual(budget);
    }
    // Re-priced from bare actions (no per-level terms), a part with tag binds is never batched.
    const bare = p.parts.map(({ gas: _g, total: _t, ...rest }) => rest);
    expect(packBatches(bare, g).every((b) => b.length === 1)).toBe(true);
    expect((await wa.runSequence(p.parts)).state).toBe("COMPLETE");
  });

  it("65 record targets: the existence reads go in chunks of 64, never a false TARGET_ABSENT", async () => {
    const ids = [...pathIds64(), pathId(T, ["cars"])];
    expect(ids.length).toBe(65);
    const p = await planTag(efs, wa, {
      topic: ["many"],
      targets: ids.map((id) => ({ kind: "topic" as const, id })) as never,
    });
    expect(p.status).toBe("PLANNED");
    const absent = await planTag(efs, wa, {
      topic: ["many"],
      targets: [...ids, `0x${"5e".repeat(32)}` as Hex].map((id) => ({
        kind: "topic" as const,
        id,
      })) as never,
    });
    expect(absent).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 65, code: "TARGET_ABSENT" }],
    });
  });
  function pathIds64(): Hex[] {
    return deep.map((_, i) => pathId(T, deep.slice(0, i + 1)));
  }

  it("a word page with limit 1: the root topic alone first (reading nothing is honest there), then the rest", async () => {
    await run(wa, planTag(efs, wa, { topic: ["x"], targets: [files[0] as never] }) as never);
    const first = await wordPage(efs, "x", { limit: 1 });
    if (first.status !== "PRESENT") throw new Error(`${first.status}: ${first.reason.detail}`);
    expect(first.rows.map((r) => r.topic)).toEqual([pathId(T, ["x"])]);
    expect(first.finished).toBe(false);
    const rest = await wordPage(efs, "x", { limit: 1, cursor: first.next as never });
    expect(rest.status === "PRESENT" && rest.rows.map((r) => r.topic)).toEqual([
      pathId(T, ["brands", "x"]),
    ]);
  });

  it("a Lens author's hidden child topic hides everything filed at or below it from that Lens's roll-up", async () => {
    // A says "not this" about the child /brands/z as a child of /brands: files[2] is filed only there.
    await run(
      wa,
      planDeny(efs, wa, {
        topic: ["brands"],
        targets: [{ kind: "topic", id: pathId(T, ["brands", "z"]) } as never],
      }) as never,
    );
    for (const view of ["mine", "everyone"] as const) {
      const byA = await topicItems(efs, ["brands"], {
        view,
        lens: { principals: [A] },
        below: true,
      });
      if (byA.status !== "PRESENT") throw new Error(byA.status);
      expect(byA.rows.map((r) => r.thing)).not.toContain(files[2]?.subject);
      expect(byA.rows.map((r) => r.thing)).toContain(files[3]?.subject); // filed under x and y, which show
      expect(byA.counts.hiddenByChild).toBeGreaterThan(0);
    }
    // Through a Lens that hides nothing, it shows; and Raw applies no rule.
    const byB = await topicItems(efs, ["brands"], { lens: { principals: [B] }, below: true });
    expect(byB.status === "PRESENT" && byB.rows.map((r) => r.thing)).toContain(files[2]?.subject);
  });

  it("a read the node refuses as too big is tried again with smaller bounds before it is UNKNOWN", async () => {
    const mineSel = sel(topicMineReaderAbi, "mine");
    let refusals = 0;
    const tight: FetchLike = async (url, init) => {
      const sent = JSON.parse(init.body ?? "null");
      const reqs = (Array.isArray(sent) ? sent : [sent]) as {
        id: number;
        method: string;
        params: [{ data?: string }];
      }[];
      const big = reqs.filter((r) => {
        const data = r.method === "eth_call" ? String(r.params?.[0]?.data ?? "") : "";
        if (!data.startsWith(mineSel)) return false;
        const { args } = decodeFunctionData({ abi: topicMineReaderAbi, data: data as Hex });
        return Number(args[5]) > 30; // `limit` entries: three halvings from the bound of 246 get under it
      });
      if (!big.length) return fetch(url, init as RequestInit) as never;
      refusals += big.length;
      const out = reqs.map((r) => ({
        jsonrpc: "2.0",
        id: r.id,
        error: { code: -32000, message: "out of gas" },
      }));
      const text = JSON.stringify(Array.isArray(sent) ? out : out[0]);
      return { ok: true, status: 200, headers: new Headers(), text: async () => text } as never;
    };
    const small = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: tight });
    const page = await topicItems(small, ["brands"], {
      view: "mine",
      lens: { principals: [A] },
      below: true,
    });
    expect(page).toMatchObject({ status: "PRESENT" });
    expect(page.status === "PRESENT" && page.counts.backoffs).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it("forged rows the readers would never give: UNKNOWN", async () => {
    const zeroYes = forged(topicEveryoneReaderAbi, "everyone", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, yes: 0n })),
    ]);
    expect(await topicItems(zeroYes, ["brands", "x"], { lens: { principals: [A] } })).toMatchObject(
      {
        status: "UNKNOWN",
        reason: { code: "RPC_ERROR" },
      },
    );
    const negative = forged(topicMineReaderAbi, "mine", (out) => [
      out[0],
      rowsOf(out).map((r) => ({ ...r, number: -1 })),
    ]);
    expect(
      await topicItems(negative, ["brands", "x"], { view: "mine", lens: { principals: [A] } }),
    ).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
    // A roll-up row filed at a topic that is not below the place (its position made consistent with it).
    const elsewhere = pathId(T, ["cars", "tesla"]);
    const outside = forged(topicMineReaderAbi, "mine", (out) => [
      out[0],
      rowsOf(out).map((r) => ({
        ...r,
        topic: elsewhere,
        position: positionKey(PURPOSES.tag, elsewhere, r["thing"] as Hex),
      })),
    ]);
    expect(
      await topicItems(outside, ["brands"], {
        view: "mine",
        lens: { principals: [A] },
        below: true,
      }),
    ).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });
});
