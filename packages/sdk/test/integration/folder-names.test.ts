// SPDX-License-Identifier: MIT
// folderNames on the fixture: a folder's name for a breadcrumb, by the spec §3.7 order (the reader's own, the
// creator's, the first Lens author's; never a stranger), from the folder's FOLDER backlinks, each checked as the read
// audit checks them; and `complete` proves what it says: a null or a reader's name, never a name an older entry
// beyond `scan` could outrank. Accounts 51 to 55 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, PrincipalId, RecordId } from "../../src/core/hex.ts";
import { planCreateFolder, planRemoveEntries } from "../../src/files/entries.ts";
import { folderNames } from "../../src/files/foldernames.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { indexAbi, ledgerReadsAbi } from "../../src/generated/abis.ts";
import { planFolderEntry } from "../../src/testing/index.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const [C, L, R, S, X] = [51, 52, 53, 54, 55].map(acct) as [
  ReturnType<typeof acct>,
  ReturnType<typeof acct>,
  ReturnType<typeof acct>,
  ReturnType<typeof acct>,
  ReturnType<typeof acct>,
];
const home = (a: { address: string }) => ({
  kind: "home" as const,
  address: a.address.toLowerCase() as Address,
});
const tag = `fn${Date.now().toString(36)}`;
const writers = new Map<string, Awaited<ReturnType<typeof createWriter>>>();
const writer = (a: typeof C) => writers.get(a.address) as Awaited<ReturnType<typeof createWriter>>;
const lensOf = (...as: (typeof C)[]) => efs.lens.from(as.map((a) => a.address as Address));
const run = async (w: Awaited<ReturnType<typeof createWriter>>, p: Promise<unknown>) => {
  const r = (await p) as { status: string; parts?: unknown[]; review?: { created?: FolderRef } };
  if (r.status !== "PLANNED") throw new Error(`not planned: ${JSON.stringify(r)}`);
  expect((await w.runSequence(r.parts as never)).state).toBe("COMPLETE");
  return r;
};
const folder = async (name: string): Promise<FolderRef> =>
  (
    (await run(writer(C), planCreateFolder(efs, writer(C), { folder: home(C), name }))).review as {
      created: FolderRef;
    }
  ).created;
const link = (
  by: typeof C,
  at: { kind: "home"; address: Address } | FolderRef,
  name: string,
  target: FolderRef,
) => run(writer(by), planFolderEntry(efs, writer(by), { folder: at, name, target }));
const principal = (a: typeof C) => writer(a).principal as PrincipalId;

beforeAll(async () => {
  for (const a of [C, L, R, S, X]) {
    await fetch(fixture.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [a.address, "0x56bc75e2d63100000"],
      }),
    });
    writers.set(
      a.address,
      await createWriter(efs, {
        authorizer: { kind: "local", profile: "direct", account: a },
        journal: memoryJournal(),
      }),
    );
  }
}, 120_000);

describe("folderNames: the spec's order, never a stranger", () => {
  it("the creator's entry names it, proven (read to its end); the reader's own entry comes first", async () => {
    const F = await folder(`${tag}-guides`);
    const one = await folderNames(efs, [{ folder: F.directory, reader: principal(X) }], {
      lens: lensOf(L),
    });
    expect(one).toMatchObject({
      status: "PRESENT",
      rows: [
        {
          folder: F.directory,
          creator: principal(C),
          complete: true,
          name: {
            text: `${tag}-guides`,
            author: principal(C),
            why: "creator",
            parent: { kind: "home" },
          },
        },
      ],
    });
    await link(R, home(R), "my guides", F);
    const mine = await folderNames(efs, [{ folder: F.directory, reader: principal(R) }], {
      lens: lensOf(L),
    });
    expect(mine.status === "PRESENT" && mine.rows[0]?.name).toMatchObject({
      text: "my guides",
      why: "reader",
    });
  });

  it("a stranger outside the Lens never names it, and a removed entry doesn't count", async () => {
    const H = await folder(`${tag}-spam`);
    await link(S, home(S), "BUY NOW", H);
    await run(
      writer(C),
      planRemoveEntries(efs, writer(C), { entries: [{ folder: home(C), name: `${tag}-spam` }] }),
    );
    const r = await folderNames(efs, [{ folder: H.directory, reader: principal(X) }], {
      lens: lensOf(L),
    });
    expect(r).toMatchObject({
      status: "PRESENT",
      rows: [{ name: null, complete: true, creator: principal(C) }],
    });
    // In the Lens, the same author's entry is a rule-3 name.
    const withS = await folderNames(efs, [{ folder: H.directory, reader: principal(X) }], {
      lens: lensOf(L, S),
    });
    expect(withS.status === "PRESENT" && withS.rows[0]?.name).toMatchObject({
      text: "BUY NOW",
      why: "lens",
    });
  });

  it("a creator's entry older than the 16 newest: the Lens author's name, complete false; a reader's own is proven", async () => {
    const K = await folder(`${tag}-deep`);
    for (let i = 0; i < 16; i++) await link(L, home(L), `k${i}`, K);
    const partial = await folderNames(efs, [{ folder: K.directory, reader: principal(X) }], {
      lens: lensOf(L),
      scan: 16,
    });
    expect(partial).toMatchObject({
      status: "PRESENT",
      rows: [{ complete: false, name: { text: "k15", author: principal(L), why: "lens" } }],
    });
    // The reader's own newest entry is proven by a partial scan: nothing older can outrank it.
    await link(R, home(R), "reader's", K);
    const own = await folderNames(efs, [{ folder: K.directory, reader: principal(R) }], {
      lens: lensOf(L),
      scan: 16,
    });
    expect(own.status === "PRESENT" && own.rows[0]).toMatchObject({
      complete: true,
      name: { why: "reader" },
    });
  }, 240_000);

  it("refuses what can never work, before any read", async () => {
    await expect(folderNames(efs, [])).rejects.toMatchObject({ code: "MISUSE" });
    const many = Array.from({ length: 33 }, () => ({ folder: `0x${"11".repeat(32)}` as RecordId }));
    await expect(folderNames(efs, many)).rejects.toMatchObject({ code: "MISUSE" });
    await expect(
      folderNames(efs, [{ folder: `0x${"11".repeat(32)}` as RecordId }], { scan: 17 }),
    ).rejects.toMatchObject({
      code: "MISUSE",
    });
  });
});

describe("folderNames: every reply checked (one lying endpoint, UNKNOWN, never a name)", () => {
  let F: FolderRef;
  beforeAll(async () => {
    F = await folder(`${tag}-checked`);
  });
  it("a slice not the length asked, or a position cell that is not the entry's own position", async () => {
    const honest = await folderNames(efs, [{ folder: F.directory }], { lens: lensOf(L) });
    expect(honest.status).toBe("PRESENT");
    const longer = lyingEfs(
      fixture.rpcUrl,
      deployment,
      indexAbi,
      "postingSliceOf",
      ([st, xs, more]) => [st, [...(xs as bigint[]), ...(xs as bigint[])], more],
    );
    expect(await folderNames(longer, [{ folder: F.directory }], { lens: lensOf(L) })).toMatchObject(
      {
        status: "UNKNOWN",
      },
    );
    const forged = lyingEfs(
      fixture.rpcUrl,
      deployment,
      ledgerReadsAbi,
      "positionCell",
      // another parent with the true name: only binding the cell back to its position catches it
      ([st, p, , role]) => [st, p, `0x${"0".repeat(24)}${S.address.slice(2).toLowerCase()}`, role],
    );
    expect(await folderNames(forged, [{ folder: F.directory }], { lens: lensOf(L) })).toMatchObject(
      {
        status: "UNKNOWN",
      },
    );
  });
});
