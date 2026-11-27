// SPDX-License-Identifier: MIT
// Every path walk is bounded, and a cycle in the folder graph is an outcome, never a hang or a stack overflow (the
// write-path audit, 2026-11-26). Folders can form cycles without any lie: entries point down, any author may write an
// entry in any folder, and a Lens shows several authors. Here W's folder A holds W's folder B, and O's own entry in B
// points back at A. Walks follow the names they are given (one read each), never the graph on their own.
// Accounts 49 and 50 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import { type Address, bytesToHex, type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { utf8Encode } from "../../src/core/platform.ts";
import { planCreateFolder, planMoveEntries } from "../../src/files/entries.ts";
import { type FolderRef, listFolder, resolvePath } from "../../src/files/folders.ts";
import { PURPOSES } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const wAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 49 });
const oAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 50 });
const home = { kind: "home" as const, address: wAccount.address.toLowerCase() as Address };
const top = `walk${Date.now().toString(36)}`;
let w: Awaited<ReturnType<typeof createWriter>>;
let o: Awaited<ReturnType<typeof createWriter>>;
let A: FolderRef;
let B: FolderRef;

const fund = (a: Address) =>
  fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [a, "0x56bc75e2d63100000"],
    }),
  });

beforeAll(async () => {
  await fund(wAccount.address);
  await fund(oAccount.address);
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: wAccount },
    journal: memoryJournal(),
  });
  o = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: oAccount },
    journal: memoryJournal(),
  });
  const run = async (writer: typeof w, p: unknown) => {
    const r = (await p) as { status: string; parts: unknown[]; review: { created: FolderRef } };
    if (r.status !== "PLANNED") throw new Error(r.status);
    expect((await writer.runSequence(r.parts as never)).state).toBe("COMPLETE");
    return r.review.created;
  };
  A = await run(w, planCreateFolder(efs, w, { folder: home, name: top }));
  B = await run(
    w,
    planCreateFolder(efs, w, { folder: { kind: "folder", directory: A.directory }, name: "b" }),
  );
  // O's own entry "a" in W's folder B, pointing back at A (the chain refuses only a folder holding itself).
  const name = utf8Encode("a");
  const typeId = (efs.deployment.typeIds as Record<string, Hex>)["files-name/3"] as Hex;
  const blank = { purpose: ZERO_WORD, subject: ZERO_WORD, role: ZERO_WORD, target: ZERO_WORD };
  const planned = await o.planActions({
    actions: [
      {
        ...blank,
        kind: ACTION.PUBLISH,
        typeId,
        bodyHashOrRecordId: keccak256(name),
        expectedRevision: 0n,
        saltOrStrength: ZERO_WORD,
      },
      {
        kind: ACTION.BIND,
        typeId: ZERO_WORD,
        bodyHashOrRecordId: ZERO_WORD,
        purpose: PURPOSES.folder,
        subject: B.directory,
        role: keccak256(name),
        target: A.directory,
        expectedRevision: 0n,
        saltOrStrength: ZERO_WORD,
      },
    ],
    bodies: [bytesToHex(name), "0x"],
    effects: [{ code: "test.cycle", args: {} }],
  });
  if (planned.status !== "PLANNED") throw new Error(planned.status);
  expect((await o.run(planned.plan)).reconcile?.outcome).toBe("COMMITTED");
}, 240_000);

const lens = () => efs.lens.from([wAccount.address, oAccount.address]);

describe("a cycle of folders is walked only as far as the names given", () => {
  it("a path around the cycle a hundred times resolves, one read per name, and ends", async () => {
    const segments = [top, ...Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? "b" : "a"))];
    const t0 = Date.now();
    const r = await resolvePath(efs, { from: home, segments }, { lens: lens() });
    expect(r.status).toBe("PRESENT");
    if (r.status === "PRESENT") expect(r.chain).toHaveLength(segments.length);
    expect(Date.now() - t0).toBeLessThan(30_000);
  });

  it("maxSegments refuses a longer path before any read", async () => {
    const segments = [top, ...Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? "b" : "a"))];
    expect(
      await resolvePath(efs, { from: home, segments }, { lens: lens(), maxSegments: 50 }),
    ).toMatchObject({
      status: "INVALID",
      reason: { code: "LIMIT_EXCEEDED" },
      evidence: { requests: 0 },
    });
  });

  it("listing a folder of the cycle lists it, and nothing below it", async () => {
    const a = await listFolder(efs, A, { lens: lens() });
    const b = await listFolder(efs, B, { lens: lens() });
    expect(a.status === "PRESENT" && a.rows.map((x) => x.name)).toEqual(["b"]);
    expect(b.status === "PRESENT" && b.rows.map((x) => x.name)).toEqual(["a"]);
  });

  it("moving a folder below itself through the cycle is INTO_ITSELF, whichever way round the path goes", async () => {
    // Move B (in A) into A's own entry under B: the destination path home/top/b/a reaches A, then B, the folder moved.
    for (const via of [
      { from: home, segments: [top, "b", "a"] },
      { from: home, segments: [top, "b", "a", "b", "a"] },
    ]) {
      await expect(
        planMoveEntries(efs, w, {
          moves: [{ from: { folder: A, name: "b" }, to: { folder: A, name: "b2", via } }],
          lens: lens(),
        }),
      ).rejects.toMatchObject({ code: "MISUSE", details: { code: "INTO_ITSELF" } });
    }
  });
});
