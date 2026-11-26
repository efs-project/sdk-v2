// SPDX-License-Identifier: MIT
// What each topicItems row is, on a real chain: its kind (a file's subject, a folder, a revision, a topic, an address
// or another record, with the record's Type), read in one batched round trip per page; the opt-in exact tier, which
// tells a file (its creator's HEAD names a Files revision) from another app's subject; and the `kinds` filter, which
// counts what it leaves out, remembers it for de-duplication, never ends a page early and turns a failed lookup into
// UNKNOWN. Two accounts of anvil's public development mnemonic (indexes 22 and 23, used by no other test file).
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, PrincipalId, RecordId } from "../../src/core/hex.ts";
import { planCreateFile, planCreateFolder } from "../../src/files/entries.ts";
import type { FolderRef, HomeRef } from "../../src/files/folders.ts";
import { ledgerReadsAbi, ledgerViewsAbi, lensReaderAbi } from "../../src/generated/abis.ts";
import {
  homeId,
  pathId,
  planLabel,
  planTag,
  type TopicPage,
  type TopicRow,
  textRecordId,
  topicItems,
  topicTypesOf,
} from "../../src/tags/index.ts";
import { planOtherEntry } from "../../src/testing/index.ts";
import { sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const cara = mnemonicToAccount(MNEMONIC, { addressIndex: 22 });
const dex = mnemonicToAccount(MNEMONIC, { addressIndex: 23 });
const T = topicTypesOf(efs.deployment);
const typeOf = (k: string) => (efs.deployment.typeIds[k] as Hex).toLowerCase() as Hex;
const text = (s: string) => new TextEncoder().encode(s);
const journal = memoryJournal();
let wc: Awaited<ReturnType<typeof createWriter>>;
let C: PrincipalId;
let lens: { principals: PrincipalId[] };

const rpc = async (method: string, params: unknown[]) => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
};
const run = async (planned: Promise<unknown>) => {
  const p = (await planned) as { status: string; parts?: unknown[]; review?: unknown };
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  expect((await wc.runSequence(p.parts as never)).state).toBe("COMPLETE");
  return p.review as Record<string, unknown>;
};
const all = async (first: () => Promise<TopicPage>, more: (next: never) => Promise<TopicPage>) => {
  const pages: TopicPage[] = [await first()];
  for (let i = 0; i < 50; i++) {
    const last = pages[pages.length - 1] as TopicPage;
    if (last.status !== "PRESENT") throw new Error(`${last.status}: ${last.reason.detail}`);
    if (last.finished) break;
    pages.push(await more(last.next as never));
  }
  const present = pages.filter((p) => p.status === "PRESENT");
  return { pages: present, rows: present.flatMap((p) => p.rows) };
};
const kindsOf = (rows: readonly TopicRow[]) =>
  Object.fromEntries(rows.map((r) => [r.thing, [r.kind, r.typeId ?? null]]));

// The things, each filed in /kinds.
let file: Hex;
let revision: RecordId;
let folder: Hex;
let other: Hex;
let topic: Hex;
let child: Hex;
let label: Hex;
let address: Hex;

beforeAll(async () => {
  await rpc("anvil_setBalance", [cara.address, "0x56bc75e2d63100000"]);
  wc = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: cara },
    journal,
  });
  C = wc.principal;
  lens = { principals: [C] };
  const home: HomeRef = { kind: "home", address: cara.address };
  const made = await run(
    planCreateFile(efs, wc, { folder: home, name: "k.txt", content: text("k"), lens }),
  );
  file = (made["file"] as { subject: Hex }).subject;
  revision = made["revision"] as RecordId;
  folder = (
    (await run(planCreateFolder(efs, wc, { folder: home, name: "kdir", lens })))[
      "created"
    ] as FolderRef
  ).directory;
  other = (await run(planOtherEntry(efs, wc, { folder: home, name: "junk.bin", lens })))[
    "subject"
  ] as Hex;
  // Topics of their own to file as things (a root topic is its word page, topic-word/1; a child is a topic/1 path
  // record), and a label's text/1 record (another app's record, to this read).
  await run(
    planTag(efs, wc, {
      topic: ["kinds-elsewhere", "deep"],
      targets: [{ kind: "file", subject: file }],
    }),
  );
  topic = pathId(T, ["kinds-elsewhere"]);
  child = pathId(T, ["kinds-elsewhere", "deep"]);
  await run(planLabel(efs, wc, { topic: ["kinds-elsewhere"], lang: "en", text: "Elsewhere" }));
  label = textRecordId(T, "Elsewhere");
  address = homeId(dex.address);
  await run(
    planTag(efs, wc, {
      topic: ["kinds"],
      targets: [
        { kind: "file", subject: file },
        { kind: "file", subject: other },
        { kind: "folder", directory: folder as RecordId },
        { kind: "revision", recordId: revision },
        { kind: "topic", id: topic },
        { kind: "topic", id: child },
        { kind: "revision", recordId: label as RecordId },
        { kind: "address", address: dex.address },
      ] as never,
    }),
  );
});

describe("topic row kinds (fixture)", () => {
  it("every row says what it is: a created subject, a folder, a revision, a topic, an address, another record with its Type", async () => {
    const page = await topicItems(efs, ["kinds"], { view: "mine", lens });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.finished).toBe(true);
    expect(kindsOf(page.rows)).toEqual({
      // Without the exact tier a created subject is only "subject": a file, or another app's subject.
      [file]: ["subject", null],
      [other]: ["subject", null],
      [folder]: ["folder", typeOf("files-directory/1")],
      [revision]: ["revision", typeOf("files-root/1")],
      [topic]: ["topic", typeOf("topic-word/1")],
      [child]: ["topic", typeOf("topic/1")],
      [label]: ["other", typeOf("text/1")],
      [address]: ["address", null],
    });
    expect(page.counts.filtered).toBe(0);
  });

  it("the exact tier: a subject whose creator's HEAD names a Files revision is a file, one with none is other", async () => {
    for (const view of ["mine", "everyone", "raw"] as const) {
      const page = await topicItems(efs, ["kinds"], { view, lens, kindsExact: true });
      if (page.status !== "PRESENT") throw new Error(page.status);
      const k = kindsOf(page.rows);
      expect(k[file]).toEqual(["file", null]);
      expect(k[other]).toEqual(["other", null]);
      expect(k[folder]).toEqual(["folder", typeOf("files-directory/1")]);
      expect(Object.values(k).some(([kind]) => kind === "subject")).toBe(false);
    }
  });

  it("kinds: ['file'] lists only files (the exact tier on), counts the rest, and a short page is never the end", async () => {
    const { pages, rows } = await all(
      () => topicItems(efs, ["kinds"], { view: "mine", lens, kinds: ["file"], entries: 2 }),
      (next) =>
        topicItems(efs, ["kinds"], {
          view: "mine",
          lens,
          kinds: ["file"],
          entries: 2,
          cursor: next,
        }),
    );
    expect(rows.map((r) => [r.thing, r.kind])).toEqual([[file, "file"]]);
    expect(pages.reduce((n, p) => n + (p.status === "PRESENT" ? p.counts.filtered : 0), 0)).toBe(7);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages.slice(0, -1)) expect(p).toMatchObject({ finished: false });
    expect(pages.some((p) => p.status === "PRESENT" && !p.finished && p.rows.length === 0)).toBe(
      true,
    );
    expect(pages[pages.length - 1]).toMatchObject({ finished: true, scan: "EXHAUSTED" });
  });

  it("kinds fills the page from further calls: rows wanted count only rows the filter keeps", async () => {
    const page = await topicItems(efs, ["kinds"], {
      view: "mine",
      lens,
      kinds: ["folder", "address"],
      rows: 2,
    });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.rows.map((r) => r.kind).sort()).toEqual(["address", "folder"]);
  });

  it("a filtered thing is remembered: filed twice in a roll-up, it is filtered once and then a repeat", async () => {
    await run(
      planTag(efs, wc, {
        topic: ["kroll", "a"],
        targets: [{ kind: "address", address: dex.address }],
      }),
    );
    await run(
      planTag(efs, wc, {
        topic: ["kroll", "b"],
        targets: [{ kind: "address", address: dex.address }],
      }),
    );
    await run(
      planTag(efs, wc, {
        topic: ["kroll", "b"],
        targets: [{ kind: "folder", directory: folder }] as never,
      }),
    );
    const opts = {
      view: "mine" as const,
      lens,
      below: true,
      kinds: ["folder" as const],
      entries: 1,
    };
    const { pages, rows } = await all(
      () => topicItems(efs, ["kroll"], opts),
      (next) => topicItems(efs, ["kroll"], { ...opts, cursor: next }),
    );
    expect(rows.map((r) => r.thing)).toEqual([folder]);
    const sum = (f: (p: Extract<TopicPage, { status: "PRESENT" }>) => number) =>
      pages.reduce((n, p) => n + (p.status === "PRESENT" ? f(p) : 0), 0);
    expect(sum((p) => p.counts.filtered)).toBe(1);
    expect(sum((p) => p.dedup.dropped)).toBe(1);
  });

  it("a filter is part of the listing: a cursor from another filter is MISUSE, and so is a kind that is not one", async () => {
    const first = await topicItems(efs, ["kinds"], { view: "mine", lens, entries: 1 });
    if (first.status !== "PRESENT" || !first.next) throw new Error("expected a cursor");
    await expect(
      topicItems(efs, ["kinds"], {
        view: "mine",
        lens,
        entries: 1,
        kinds: ["file"],
        cursor: first.next,
      }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    await expect(
      topicItems(efs, ["kinds"], { view: "mine", lens, kinds: ["files" as never] }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    // "subject" means "not refined": it can't be asked for with the exact tier on.
    await expect(
      topicItems(efs, ["kinds"], { view: "mine", lens, kinds: ["subject"], kindsExact: true }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    await expect(
      topicItems(efs, ["kinds"], { view: "mine", lens, kinds: ["subject", "file"] }),
    ).rejects.toMatchObject({ code: "MISUSE" });
  });

  it("a kind that can't be read makes the page UNKNOWN, never a guessed kind", async () => {
    const fail = { error: { code: -32000, message: "nope" } };
    for (const [abi, fn] of [
      [ledgerViewsAbi, "records"],
      [ledgerReadsAbi, "subjectInfo"],
    ] as const) {
      const lying = createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({ [sel(abi, fn)]: () => fail }),
      });
      expect(await topicItems(lying, ["kinds"], { view: "mine", lens })).toMatchObject({
        status: "UNKNOWN",
      });
    }
    // A records reply that decodes but answers neither PRESENT nor a proven absence (here 0, no status at all).
    const noStatus = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({
        [sel(ledgerViewsAbi, "records")]: (result) => {
          const out = decodeFunctionResult({
            abi: ledgerViewsAbi,
            functionName: "records",
            data: result,
          }) as unknown as unknown[];
          return encodeFunctionResult({
            abi: ledgerViewsAbi,
            functionName: "records",
            // Every output kept; the statuses (the first) set to 0.
            result: out.map((v, i) => (i === 0 ? (v as number[]).map(() => 0) : v)) as never,
          }) as Hex;
        },
      }),
    });
    expect(await topicItems(noStatus, ["kinds"], { view: "mine", lens })).toMatchObject({
      status: "UNKNOWN",
    });
    // The exact tier's own reads: the creator's HEAD (LensReader.resolve) failing is UNKNOWN too.
    const noHead = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({ [sel(lensReaderAbi, "resolve")]: () => fail }),
    });
    expect(await topicItems(noHead, ["kinds"], { view: "mine", lens })).toMatchObject({
      status: "PRESENT",
    });
    expect(
      await topicItems(noHead, ["kinds"], { view: "mine", lens, kindsExact: true }),
    ).toMatchObject({ status: "UNKNOWN" });
  });
  it("the exact tier reads the record a HEAD names: a HEAD on a folder record is other, on no record UNKNOWN", async () => {
    const headOn = (target: Hex) =>
      createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({
          [sel(lensReaderAbi, "resolve")]: (result) => {
            const [q, s] = decodeFunctionResult({
              abi: lensReaderAbi,
              functionName: "resolve",
              data: result,
            }) as unknown as [unknown, Record<string, unknown>];
            return encodeFunctionResult({
              abi: lensReaderAbi,
              functionName: "resolve",
              result: [q, { ...s, target }] as never,
            }) as Hex;
          },
        }),
      });
    const onFolder = await topicItems(headOn(folder), ["kinds"], {
      view: "mine",
      lens,
      kindsExact: true,
    });
    if (onFolder.status !== "PRESENT") throw new Error(onFolder.status);
    expect(kindsOf(onFolder.rows)[file]).toEqual(["other", null]);
    expect(
      await topicItems(headOn(`0x${"77".repeat(32)}`), ["kinds"], {
        view: "mine",
        lens,
        kindsExact: true,
      }),
    ).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("without a filter, `rows` still bounds the page: kinds are read once, for the rows it returns", async () => {
    const page = await topicItems(efs, ["kinds"], { view: "mine", lens, rows: 2 });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.rows.length).toBe(2);
    expect(page.finished).toBe(false);
    expect(page.rows.every((r) => r.kind !== undefined)).toBe(true);
  });
});
