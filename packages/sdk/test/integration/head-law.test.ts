// SPDX-License-Identifier: MIT
// The HEAD law on a real chain: a file's HEAD must name a revision whose own file word is that file. Since the tag
// release the chain refuses any other HEAD at write time (FilesFinalValidator code 8, inside E_INDEX_CALL): one bound
// to another file's revision, or at a folder's record id, is refused before signing and never admitted. The SDK still
// checks the law when it reads (a revision link naming another file is INVALID), as a second line of defence.
// Uses anvil's public development mnemonic, index 16 (no other test file uses it).
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { openObject } from "../../src/files/folders.ts";
import { bindHead, putInline } from "./recipes.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex } };
};
const docs = deployment.seed.folder.directoryRecordId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const erin = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 16,
});
const lens = efs.lens.mineFirst(erin.address);
const text = (s: string) => new TextEncoder().encode(s);
let w: Awaited<ReturnType<typeof createWriter>>;
let a: SubjectId;
let revA: RecordId;
let revB: RecordId;

const send = async (input: Parameters<typeof w.planActions>[0]) => {
  const p = await w.planActions(input);
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  expect((await w.run(p.plan)).reconcile?.outcome).toBe("COMMITTED");
};
/** E_FILES_FINAL(code, leaf), as the index wraps it in E_INDEX_CALL. */
const filesFinal = (code: number) =>
  `0xaf7811e9${code.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
/** A plan the chain refuses: the send is STALE (nothing went out) and names the validator's code. */
const refused = async (input: Parameters<typeof w.planActions>[0], code: number) => {
  const p = await w.planActions(input);
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  const r = await w.run(p.plan);
  expect(r.send).toMatchObject({ status: "STALE", revert: { error: "E_INDEX_CALL" } });
  expect(r.send.status === "STALE" && String(r.send.revert?.args?.[0])).toBe(filesFinal(code));
};
const revisionOf = async (subject: SubjectId) => {
  const o = await openFile(efs, { kind: "file", subject }, { lens });
  if (o.status !== "PRESENT") throw new Error(o.status);
  return o.file.revision;
};

beforeAll(async () => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [erin.address, "0x56bc75e2d63100000"],
    }),
  });
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: erin },
    journal: memoryJournal(),
  });
  const putA = putInline(
    efs,
    w.principal,
    docs,
    "head-law-a.txt",
    text("a\n"),
    keccak256(toHex("head-law-a")),
  );
  const putB = putInline(
    efs,
    w.principal,
    docs,
    "head-law-b.txt",
    text("b\n"),
    keccak256(toHex("head-law-b")),
  );
  await send(putA);
  await send(putB);
  a = putA.file;
  revA = await revisionOf(putA.file);
  revB = await revisionOf(putB.file);
});

describe("the HEAD law (fixture)", () => {
  it("the chain refuses a HEAD bound to another file's revision (code 8): never sent, never admitted", async () => {
    // a's HEAD binding is at revision 1 after its create.
    await refused(bindHead(a, revB, 1n), 8);
    expect(await revisionOf(a)).toBe(revA);
  });

  it("the chain refuses a HEAD at a folder's record id too (code 8): the folder still opens as FOLDER", async () => {
    await refused(bindHead(docs, revB, 0n), 8);
    expect((await openObject(efs, docs, { lens })).status).toBe("FOLDER");
    expect(
      (await openFile(efs, { kind: "file", subject: docs as unknown as SubjectId }, { lens }))
        .status,
    ).toBe("ABSENT_PROVEN");
  });

  it("a revision link that names another file is INVALID; its own file still opens it", async () => {
    expect((await openFile(efs, { kind: "revision", recordId: revB, file: a })).status).toBe(
      "INVALID",
    );
    expect((await openFile(efs, { kind: "revision", recordId: revA, file: a })).status).toBe(
      "PRESENT",
    );
  });

  it("an edit from a base of another file is refused, with or without a named media type, never planned", async () => {
    for (const mediaType of [undefined, "text/plain"]) {
      const r = await planEditFile(efs, w, {
        file: { kind: "file", subject: a },
        base: { kind: "revision", recordId: revB },
        content: text("edited\n"),
        lens,
        ...(mediaType ? { mediaType } : {}),
      });
      expect(r.status).not.toBe("PLANNED");
    }
  });
});
