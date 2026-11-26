// SPDX-License-Identifier: MIT
// Reply validation on the fixture (the read-validation audit, 2026-11-26): an endpoint that lies about exactly one
// reply (test/integration/lying.ts) is never believed. Each case forges one reply a read used to trust and expects the
// read to fail over (with one endpoint: UNKNOWN), never a value or an absence; each guard removed, its case fails.
// Account 43 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { planCreateFile } from "../../src/files/entries.ts";
import { type FolderRef, listFolder } from "../../src/files/folders.ts";
import {
  filesPageReaderAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
  lensReaderAbi,
} from "../../src/generated/abis.ts";
import { fileNames, planLabel, planSame, planTag, topicSynonyms } from "../../src/tags/index.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 43,
});
const lying = (abi: readonly unknown[], fn: string, edit: (r: unknown[]) => unknown[]) =>
  lyingEfs(fixture.rpcUrl, deployment, abi, fn, edit);
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
