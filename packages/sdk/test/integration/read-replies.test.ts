// SPDX-License-Identifier: MIT
// Reply validation on the fixture (the read-validation audit, 2026-11-26): an endpoint that lies about exactly one
// reply (test/integration/lying.ts) is never believed. Each case forges one reply a read used to trust and expects the
// read to fail over (with one endpoint: UNKNOWN), never a value or an absence; each guard removed, its case fails.
// Account 43 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, PrincipalId, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { planCreateFile, planRemoveEntries } from "../../src/files/entries.ts";
import { type FolderRef, listFolder } from "../../src/files/folders.ts";
import { listRemoved } from "../../src/files/removed.ts";
import {
  filesPageReaderAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
  lensReaderAbi,
  topicEveryoneReaderAbi,
  topicLookupReaderAbi,
} from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { positionKey } from "../../src/protocol/keys.ts";
import {
  fileNames,
  labelOf,
  placeCount,
  planLabel,
  planSame,
  planTag,
  topicItems,
  topicSynonyms,
} from "../../src/tags/index.ts";
import { topicPath } from "../../src/tags/read.ts";
import { pathId } from "../../src/tags/topics.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId; principalId: PrincipalId };
  seed: { folder: { directoryRecordId: Hex }; files: { name: string; subjectId: SubjectId }[] };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 43,
});
const lying = (
  abi: readonly unknown[],
  fn: string,
  edit: (r: unknown[]) => unknown[],
  when?: (calldata: string) => boolean,
) => lyingEfs(fixture.rpcUrl, deployment, abi, fn, edit, when);
/** Every headsAt reply's status rewritten to INVALID (9), a status no headsAt read accepts. */
const headsAtInvalid = () => lying(ledgerViewsAbi, "headsAt", ([, ...rest]) => [9, ...rest]);
let w: Awaited<ReturnType<typeof createWriter>>;
let file: SubjectId;
const target = `0x${"c4".repeat(20)}` as Address;

const run = async (p: Promise<unknown>) => {
  const r = (await p) as { status: string; parts?: unknown[]; review?: unknown };
  if (r.status !== "PLANNED") throw new Error(`not planned: ${r.status}`);
  expect((await w.runSequence(r.parts as never)).state).toBe("COMPLETE");
  return r;
};

beforeAll(async () => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [me.address, "0x56bc75e2d63100000"],
    }),
  });
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: me },
    journal: memoryJournal(),
  });
  await run(
    planTag(efs, w, { topic: ["rr-tags"], targets: [{ kind: "address", address: target }] }),
  );
  await run(planLabel(efs, w, { topic: ["rr-label"], lang: "en", text: "one" }));
  await run(planSame(efs, w, { topic: ["rr-a"], other: ["rr-b"] }));
  await run(
    planTag(efs, w, { topic: ["rr-p", "rr-c"], targets: [{ kind: "address", address: target }] }),
  );
  const made = (await run(
    planCreateFile(efs, w, {
      folder: root,
      name: "read-replies.txt",
      content: new TextEncoder().encode("x\n"),
    }),
  )) as { review: { file: { subject: SubjectId } } };
  file = made.review.file.subject;
}, 240_000);

describe("a headsAt status no headsAt read accepts is the endpoint's fault", () => {
  it("planTag (your head, its revision and the refusals come from it)", async () => {
    const r = await planTag(headsAtInvalid(), w, {
      topic: ["rr-tags"],
      targets: [{ kind: "address", address: target }],
      number: 7,
    });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("planLabel", async () => {
    const r = await planLabel(headsAtInvalid(), w, {
      topic: ["rr-label"],
      lang: "en",
      text: "two",
    });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("topicSynonyms", async () => {
    const r = await topicSynonyms(headsAtInvalid(), ["rr-a"], {
      lens: efs.lens.from([me.address]),
    });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("fileNames", async () => {
    const r = await fileNames(headsAtInvalid(), [{ file }]);
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });
});

const stranger = `0x${"0".repeat(24)}${"ee".repeat(20)}` as Hex;
const mine = () => efs.lens.from([me.address]);

describe("the Lens reader's decider and refusals", () => {
  it("openFile: a decider outside the Lens (at the reply's own index) is not believed", async () => {
    const lie = lying(lensReaderAbi, "resolve", ([q, sel]) => [
      q,
      { ...(sel as object), principalId: stranger },
    ]);
    const r = await openFile(lie, { kind: "file", subject: file }, { lens: mine() });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
    // the same file, honestly answered
    expect((await openFile(efs, { kind: "file", subject: file }, { lens: mine() })).status).toBe(
      "PRESENT",
    );
  });

  it("openFile: a refusal a one-principal query can't earn (LIMIT_EXCEEDED) fails over, never INVALID for good", async () => {
    const lie = lying(lensReaderAbi, "resolve", ([q, sel]) => [
      { ...(q as object), status: 12 },
      sel,
    ]);
    const r = await openFile(lie, { kind: "file", subject: file }, { lens: mine() });
    expect(r).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR", retry: "transient" },
    });
  });

  it("listFolder: a resolveManyAt decider outside the Lens is not believed", async () => {
    const lie = lying(lensReaderAbi, "resolveManyAt", ([q, out]) => [
      q,
      (out as object[]).map((x) => ({ ...x, principalId: stranger })),
    ]);
    const r = await listFolder(lie, root, { lens: mine() });
    expect(r).toMatchObject({ status: "UNKNOWN" });
    expect((await listFolder(efs, root, { lens: mine() })).status).toBe("PRESENT");
  });

  it("listFolder: a page served as ABSENT_PROVEN is not a page", async () => {
    const lie = lying(filesPageReaderAbi, "listDirectory", ([page]) => [
      { ...(page as { q: object }), q: { ...(page as { q: object }).q, status: 3 } },
    ]);
    const r = await listFolder(lie, root, { lens: mine() });
    expect(r).toMatchObject({ status: "UNKNOWN" });
  });

  it("listFolder: an UNSUPPORTED page is this endpoint's fault (transient), never INVALID for good", async () => {
    const lie = lying(filesPageReaderAbi, "listDirectory", ([page]) => [
      { ...(page as { q: object }), q: { ...(page as { q: object }).q, status: 10 } },
    ]);
    const r = await listFolder(lie, root, { lens: mine() });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { retry: "transient" } });
  });
});

describe("a HEAD whose revision reads absent", () => {
  it("openFile: the endpoint's fault (fail over, then UNKNOWN), never ABSENT_PROVEN", async () => {
    const lie = lying(ledgerReadsAbi, "record", ([, ...rest]) => [3, ...rest]); // every record ABSENT_PROVEN
    const r = await openFile(lie, { kind: "file", subject: file }, { lens: mine() });
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });
});

describe("topic readers", () => {
  it("placeCount: a count served PRESENT with a coverage other than COMPLETE is not a count", async () => {
    const honest = await placeCount(efs, ["rr-tags"]);
    expect(honest).toMatchObject({ status: "PRESENT", coverage: "COMPLETE" });
    const lie = lying(topicLookupReaderAbi, "placeCount", ([q, , ...rest]) => [q, 2, ...rest]); // PARTIAL
    const r = await placeCount(lie, ["rr-tags"]);
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("topicItems: a refusal a sound reader can't give this query (LIMIT_EXCEEDED) fails over, never INVALID for good", async () => {
    const lie = lying(topicEveryoneReaderAbi, "everyone", ([info, rows]) => [
      { ...(info as { q: object }), q: { ...(info as { q: object }).q, status: 12 } },
      rows,
    ]);
    const r = await topicItems(lie, ["rr-tags"], { lens: mine() });
    expect(r).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR", retry: "transient" },
    });
  });

  it("a hand-built Lens of more than 64 principals is MISUSE before any request (listFolder, topicItems)", async () => {
    // efs.lens.from refuses it already; a Lens written as a literal reaches the reads
    const many = {
      principals: Array.from({ length: 65 }, (_, i) =>
        efs.lens.principalOf(`0x${(i + 1).toString(16).padStart(40, "0")}` as Address),
      ),
    };
    await expect(listFolder(efs, root, { lens: many })).rejects.toMatchObject({ code: "MISUSE" });
    await expect(topicItems(efs, ["rr-tags"], { lens: many })).rejects.toMatchObject({
      code: "MISUSE",
    });
  });
});

describe("a label's text record is read hash-checked", () => {
  it("labelOf: a body that doesn't hash to its record is the endpoint's fault, never a label skipped", async () => {
    const honest = await labelOf(efs, ["rr-label"], { lens: mine(), langs: ["en"] });
    expect(honest).toMatchObject({ status: "PRESENT", label: { text: "one" } });
    const lie = lying(ledgerReadsAbi, "record", ([st, h, , ...rest]) => [
      st,
      h,
      toHex("forged"),
      ...rest,
    ]);
    const r = await labelOf(lie, ["rr-label"], { lens: mine(), langs: ["en"] });
    expect(r).toMatchObject({ status: "UNKNOWN" });
  });
});

describe("topicPath: a parent below the first level is the endpoint's fault when it fails", () => {
  const types = deployment as unknown as { typeIds: Record<string, Hex> };
  const T = () => ({
    word: types.typeIds["topic-word/1"] as Hex,
    path: types.typeIds["topic/1"] as Hex,
    text: types.typeIds["text/1"] as Hex,
  });
  const child = () => pathId(T(), ["rr-p", "rr-c"]);
  const parent = () => pathId(T(), ["rr-p"]).slice(2).toLowerCase();
  const forParent = (calldata: string) => calldata.toLowerCase().includes(parent());

  it("honestly, the words of a two-word topic", async () => {
    expect(await topicPath(efs, child())).toMatchObject({
      status: "PRESENT",
      words: ["rr-p", "rr-c"],
    });
  });

  it("a parent read as absent: fail over (UNKNOWN), never ABSENT_PROVEN", async () => {
    const lie = lying(ledgerReadsAbi, "record", ([, ...rest]) => [3, ...rest], forParent);
    expect(await topicPath(lie, child())).toMatchObject({ status: "UNKNOWN" });
  });

  it("a parent read as another Type: fail over (UNKNOWN), never INVALID", async () => {
    const lie = lying(
      ledgerReadsAbi,
      "record",
      ([st, h, ...rest]) => [st, { ...(h as object), typeId: T().text }, ...rest],
      forParent,
    );
    expect(await topicPath(lie, child())).toMatchObject({ status: "UNKNOWN" });
  });
});

describe("an unnamed listing row is tied to the folder by its cell", () => {
  it("listFolder: a row moved to another folder's entry (its name dropped) is not listed here", async () => {
    // Under a Lens of you then the seeder, your file's row in the root is forged to name no name and stand at the
    // seed's docs/readme.txt position with its target: headsAt there agrees (the seeder's entry), so only the
    // position's cell (docs, not the root) can tell.
    const docs = deployment.seed.folder.directoryRecordId;
    const readme = deployment.seed.files.find((f) => f.name === "readme.txt")
      ?.subjectId as SubjectId;
    const elsewhere = positionKey(PURPOSES.folder, docs, keccak256(toHex("readme.txt")));
    const lens = { principals: [efs.lens.principalOf(me.address), deployment.root.principalId] };
    const honest = await listFolder(efs, root, { lens });
    expect(honest.status).toBe("PRESENT");
    const lie = lying(filesPageReaderAbi, "listDirectory", ([page]) => {
      const p = page as { rows: { target: Hex }[] };
      return [
        {
          ...p,
          rows: p.rows.map((r) =>
            r.target.toLowerCase() === file.toLowerCase()
              ? { ...r, name: "0x", position: elsewhere, target: readme }
              : r,
          ),
        },
      ];
    });
    const r = await listFolder(lie, root, { lens });
    expect(r).toMatchObject({ status: "UNKNOWN" });
  });
});

describe("a position's cell is bound to the position asked about", () => {
  // The role of a name that has a record (the seed's "docs"), so only the position binding can catch the swap.
  const otherRole = keccak256(toHex("docs"));
  const forgedRole = () =>
    lying(ledgerReadsAbi, "positionCell", ([st, purpose, subject]) => [
      st,
      purpose,
      subject,
      otherRole,
    ]);

  it("fileNames: a cell whose role isn't the entry's is not believed", async () => {
    expect((await fileNames(efs, [{ file }])).status).toBe("PRESENT");
    const r = await fileNames(forgedRole(), [{ file }]);
    expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("listRemoved: a cell whose role isn't the removed entry's is not believed (runs last: it removes the file)", async () => {
    await run(planRemoveEntries(efs, w, { entries: [{ folder: root, name: "read-replies.txt" }] }));
    const author = efs.lens.principalOf(me.address);
    const honest = await listRemoved(efs, { folder: root, author });
    expect(honest.status).toBe("PRESENT");
    const r = await listRemoved(forgedRole(), { folder: root, author });
    expect(r).toMatchObject({ status: "UNKNOWN" });
  });
});
