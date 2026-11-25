// SPDX-License-Identifier: MIT
// The HEAD law on a real chain: a file's HEAD must name a revision whose own file word is that file. The ledger admits a
// HEAD bound to another file's revision (or at a folder's record id) until the tag release refuses it, and the lens
// reader does not check, so the SDK does: such a HEAD opens INVALID and is never edited, never shown as the content.
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
  // Point a's HEAD at b's revision (a's HEAD binding is at revision 1 after its create).
  await send(bindHead(a, revB, 1n));
});

describe("the HEAD law (fixture)", () => {
  it("a HEAD bound to another file's revision opens INVALID, never as that file's bytes", async () => {
    const o = await openFile(efs, { kind: "file", subject: a }, { lens });
    expect(o).toMatchObject({ status: "INVALID", reason: { code: "UNSUPPORTED_PROFILE" } });
    expect(o.status === "INVALID" && o.reason?.detail).toMatch(/another file/);
  });

  it("openObject's file open says the same", async () => {
    const o = await openObject(efs, a, { lens });
    if (o.status !== "FILE") throw new Error(o.status);
    expect(o.open.status).toBe("INVALID");
  });

  it("a revision link that names another file is INVALID; its own file still opens it", async () => {
    expect((await openFile(efs, { kind: "revision", recordId: revB, file: a })).status).toBe(
      "INVALID",
    );
    expect((await openFile(efs, { kind: "revision", recordId: revA, file: a })).status).toBe(
      "PRESENT",
    );
  });

  it("an edit on that HEAD is refused, with or without a named media type, never planned", async () => {
    for (const mediaType of [undefined, "text/plain"]) {
      const r = await planEditFile(efs, w, {
        file: { kind: "file", subject: a },
        base: { kind: "revision", recordId: revB },
        content: text("edited\n"),
        lens,
        ...(mediaType ? { mediaType } : {}),
      });
      expect(r).toMatchObject({ status: "UNKNOWN", reason: { code: "UNSUPPORTED_PROFILE" } });
    }
  });

  it("a HEAD at a folder's record id: the folder still opens as FOLDER, and as a file it is INVALID", async () => {
    await send(bindHead(docs, revB, 0n));
    expect((await openObject(efs, docs, { lens })).status).toBe("FOLDER");
    expect(
      (await openFile(efs, { kind: "file", subject: docs as unknown as SubjectId }, { lens }))
        .status,
    ).toBe("INVALID");
  });
});
