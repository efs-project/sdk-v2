// SPDX-License-Identifier: MIT
// Folder reads and plans against an endpoint whose replies are tampered with or fail: the real fixture chain behind
// a fetch that rewrites chosen eth_call results. Coverage is never overstated, an empty page is never "empty" unless
// COMPLETE, a reply that contradicts itself is refused, and a failed read is UNKNOWN, never absence.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult, getAbiItem, toFunctionSelector } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId } from "../../src/core/hex.ts";
import { planRemoveEntries } from "../../src/files/entries.ts";
import { type FolderRef, listFolder, lookupEntry, resolvePath } from "../../src/files/folders.ts";
import { filesPageReaderAbi, ledgerViewsAbi, lensReaderAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
  seed: {
    folder: { directoryRecordId: RecordId };
    files: { name: string; headRecordId: RecordId }[];
  };
};
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const docs: FolderRef = { kind: "folder", directory: deployment.seed.folder.directoryRecordId };
// A public development account (anvil mnemonic index 12); it only plans here, nothing is sent.
const carl = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 12,
});

type Edit = (result: Hex) => Hex | { error: { code: number; message: string } };
const sel = (abi: readonly unknown[], name: string): Hex =>
  toFunctionSelector(getAbiItem({ abi: abi as never, name } as never) as never) as Hex;

/** A fetch to the fixture whose eth_call replies for the given selectors pass through `edit`. */
function tampered(edits: Record<Hex, Edit>): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    const sent = JSON.parse(init.body ?? "null");
    const reqs = Array.isArray(sent) ? sent : [sent];
    const got = JSON.parse(await res.text());
    const outs = Array.isArray(got) ? got : [got];
    for (const r of reqs) {
      if (r?.method !== "eth_call") continue;
      const edit = edits[String(r.params?.[0]?.data ?? "").slice(0, 10) as Hex];
      const item = outs.find((o: { id: number }) => o.id === r.id);
      if (!edit || !item || typeof item.result !== "string") continue;
      const e = edit(item.result as Hex);
      if (typeof e === "string") item.result = e;
      else {
        delete item.result;
        item.error = e.error;
      }
    }
    const body = JSON.stringify(Array.isArray(got) ? outs : outs[0]);
    return {
      ok: true,
      status: 200,
      headers: res.headers,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}
const efsWith = (edits: Record<Hex, Edit>) =>
  createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: tampered(edits) });

const LIST = sel(filesPageReaderAbi, "listDirectory");
type Page = Record<string, unknown> & { rows: unknown[] };
/** Rewrite a listDirectory reply's page. */
const editPage =
  (f: (p: Page) => Page): Edit =>
  (result) => {
    const page = decodeFunctionResult({
      abi: filesPageReaderAbi,
      functionName: "listDirectory",
      data: result,
    }) as unknown as Page;
    return encodeFunctionResult({
      abi: filesPageReaderAbi,
      functionName: "listDirectory",
      result: f({ ...page }) as never,
    });
  };
const failWith: Edit = () => ({ error: { code: -32000, message: "the node is sick" } });

describe("folder reads against tampered or failing replies (fixture)", () => {
  it("a fresh scan the index can't vouch for is PARTIAL INDEX_PARTIAL, never 'the listing ended'", async () => {
    const efs = efsWith({
      [LIST]: editPage((p) => ({ ...p, completeFromOrigin: false, listingCoverage: 2 })),
    });
    const page = await listFolder(efs, docs);
    expect(page).toMatchObject({
      status: "PRESENT",
      coverage: { state: "PARTIAL", why: "INDEX_PARTIAL" },
    });
    expect(page.status === "PRESENT" && page.rows.length).toBe(3);
    expect(page.status === "PRESENT" && page.next).toBeUndefined();
  });

  it("an empty page is 'empty' only when COMPLETE: otherwise UNKNOWN, never an empty folder", async () => {
    const efs = efsWith({
      [LIST]: editPage((p) => ({ ...p, rows: [], completeFromOrigin: false, listingCoverage: 2 })),
    });
    expect(await listFolder(efs, docs)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "NOT_YET_DECIDABLE" },
    });
  });

  it("an index whose coverage is UNKNOWN is reported as such", async () => {
    const efs = efsWith({
      [LIST]: editPage((p) => ({ ...p, completeFromOrigin: false, listingCoverage: 1 })),
    });
    expect(await listFolder(efs, docs)).toMatchObject({
      status: "PRESENT",
      coverage: { state: "UNKNOWN" },
    });
  });

  it("a reader that claims COMPLETE with more to read is refused", async () => {
    const efs = efsWith({ [LIST]: editPage((p) => ({ ...p, next: "0x01" })) });
    expect(await listFolder(efs, docs)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("a page whose Lens resolution fails, or names another target, is UNKNOWN", async () => {
    const failing = efsWith({ [sel(lensReaderAbi, "resolveManyAt")]: failWith });
    expect((await listFolder(failing, docs)).status).toBe("UNKNOWN");
    const swapped = efsWith({
      [sel(lensReaderAbi, "resolveManyAt")]: (result) => {
        const [q, sels] = decodeFunctionResult({
          abi: lensReaderAbi,
          functionName: "resolveManyAt",
          data: result,
        }) as unknown as [unknown, { target: Hex }[]];
        const moved = sels.map((x) => ({ ...x, target: `0x${"77".repeat(32)}` as Hex }));
        return encodeFunctionResult({
          abi: lensReaderAbi,
          functionName: "resolveManyAt",
          result: [q, moved] as never,
        });
      },
    });
    expect(await listFolder(swapped, docs)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  });

  it("lookups: a failed heads read is UNKNOWN (never ABSENT_PROVEN), and a selection that skips the Lens law is refused", async () => {
    const HEADS_AT = sel(ledgerViewsAbi, "headsAt");
    expect(
      (await lookupEntry(efsWith({ [HEADS_AT]: failWith }), { folder: docs, name: "readme.txt" }))
        .status,
    ).toBe("UNKNOWN");
    // An endpoint that reports nothing selected while its own heads hold a bound entry.
    const lying = efsWith({
      [HEADS_AT]: (result) => {
        const [, selected, , all, basis] = decodeFunctionResult({
          abi: ledgerViewsAbi,
          functionName: "headsAt",
          data: result,
        }) as unknown as [number, unknown, number, unknown[], unknown];
        return encodeFunctionResult({
          abi: ledgerViewsAbi,
          functionName: "headsAt",
          result: [3, selected, 0, all, basis] as never, // ABSENT_PROVEN
        });
      },
    });
    expect((await lookupEntry(lying, { folder: docs, name: "readme.txt" })).status).toBe("UNKNOWN");
    expect((await resolvePath(lying, { from: root, segments: ["docs"] })).status).toBe("UNKNOWN");
  });

  it("a planner whose reads fail plans nothing: UNKNOWN", async () => {
    const efs = efsWith({ [sel(ledgerViewsAbi, "heads")]: failWith });
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: carl },
      journal: memoryJournal(),
    });
    expect(
      await planRemoveEntries(efs, w, { entries: [{ folder: docs, name: "readme.txt" }] }),
    ).toMatchObject({
      status: "UNKNOWN",
    });
  });

  it("a lookup or a path in something that is not a folder is INVALID, never ABSENT_PROVEN", async () => {
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const file = deployment.seed.files[0]?.headRecordId as RecordId;
    const notFolder: FolderRef = { kind: "folder", directory: file };
    expect(await lookupEntry(efs, { folder: notFolder, name: "x" })).toMatchObject({
      status: "INVALID",
    });
    expect(await resolvePath(efs, { from: notFolder, segments: ["x"] })).toMatchObject({
      status: "INVALID",
      segment: 0,
    });
  });
});
