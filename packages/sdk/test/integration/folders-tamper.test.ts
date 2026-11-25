// SPDX-License-Identifier: MIT
// Folder reads and plans against an endpoint whose replies are tampered with or fail: the real fixture chain behind
// a fetch that rewrites chosen eth_call results. Coverage is never overstated, an empty page is never "empty" unless
// COMPLETE, a reply that contradicts itself is refused, and a failed read is UNKNOWN, never absence.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId } from "../../src/core/hex.ts";
import { planRemoveEntries } from "../../src/files/entries.ts";
import {
  type FolderRef,
  listFolder,
  lookupEntry,
  openObject,
  resolvePath,
} from "../../src/files/folders.ts";
import {
  filesPageReaderAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
  lensReaderAbi,
} from "../../src/generated/abis.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
  seed: {
    folder: { directoryRecordId: RecordId };
    files: { name: string; headRecordId: RecordId; subjectId: Hex }[];
  };
};
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const docs: FolderRef = { kind: "folder", directory: deployment.seed.folder.directoryRecordId };
// A public development account (anvil mnemonic index 12); it only plans here, nothing is sent.
const carl = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 12,
});

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

  it("a follow-up read that sees another basis is read again, and the page says how many times", async () => {
    let left = 1;
    const efs = efsWith({
      [sel(lensReaderAbi, "resolveManyAt")]: (result) => {
        if (left-- <= 0) return result;
        const [q, sels] = decodeFunctionResult({
          abi: lensReaderAbi,
          functionName: "resolveManyAt",
          data: result,
        }) as unknown as [{ status: number }, unknown[]];
        // BASIS_STALE, as anvil's burst mining can make it (tools/anvil-blockhash-repro).
        return encodeFunctionResult({
          abi: lensReaderAbi,
          functionName: "resolveManyAt",
          result: [{ ...q, status: 11 }, sels] as never,
        });
      },
    });
    const page = await listFolder(efs, docs);
    expect(page).toMatchObject({ status: "PRESENT", rereads: 1 });
    expect(page.evidence.attempts.filter((a) => a.outcome === "FAILED")).toHaveLength(1);
    // A clean read carries no count.
    expect(
      "rereads" in (await listFolder(createEfs({ rpcs: [fixture.rpcUrl], deployment }), docs)),
    ).toBe(false);
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

// openObject reads the kind and, in the same batch, the file's HEAD. The kind decides routing, so once an endpoint has
// read it, a HEAD or revision read that then fails on every endpoint still answers FILE, with its open UNKNOWN.
describe("openObject when the file's open fails on every endpoint (fixture)", () => {
  const readme = deployment.seed.files.find((f) => f.name === "readme.txt")?.subjectId as Hex;
  const RESOLVE = sel(lensReaderAbi, "resolve");
  const RECORDS = sel(ledgerViewsAbi, "records");
  const SUBJECT_INFO = sel(ledgerReadsAbi, "subjectInfo");
  const B = "http://endpoint-b.invalid/";
  /** Two endpoints, both the fixture chain, each with its own edits; counts each endpoint's HEAD calls. */
  const twoEndpoints = (a: Record<Hex, Edit>, b: Record<Hex, Edit>) => {
    const heads = { a: 0, b: 0 };
    const fetch: FetchLike = (url, init) => {
      const which = url === B ? "b" : "a";
      if (String(init.body ?? "").includes(RESOLVE.slice(2))) heads[which] += 1;
      return tampered(which === "b" ? b : a)(fixture.rpcUrl, init);
    };
    return { efs: createEfs({ rpcs: [fixture.rpcUrl, B], deployment, fetch }), heads };
  };
  const headDown: Record<Hex, Edit> = { [RESOLVE]: failWith };

  it("the kind is read, the HEAD fails everywhere: FILE with its creator, open UNKNOWN", async () => {
    const { efs, heads } = twoEndpoints(headDown, headDown);
    const o = await openObject(efs, readme);
    if (o.status !== "FILE") throw new Error(o.status);
    expect(o.file).toEqual({ kind: "file", subject: readme.toLowerCase() });
    expect(o.creator).toMatch(/^0x[0-9a-f]{64}$/);
    expect(o.open).toMatchObject({ kind: "efs.open", status: "UNKNOWN" });
    expect(heads.a).toBeGreaterThan(0);
    expect(heads.b).toBeGreaterThan(0); // failover reached the second endpoint before giving up
    // The same file on an honest client opens, with the same creator.
    const honest = await openObject(createEfs({ rpcs: [fixture.rpcUrl], deployment }), readme);
    expect(honest.status === "FILE" && [honest.creator, honest.open.status]).toEqual([
      o.creator,
      "PRESENT",
    ]);
  });

  it("the kind itself can't be read anywhere: the whole answer is UNKNOWN", async () => {
    const down: Record<Hex, Edit> = { [RECORDS]: failWith, [RESOLVE]: failWith };
    const { efs } = twoEndpoints(down, down);
    expect((await openObject(efs, readme)).status).toBe("UNKNOWN");
  });

  it("endpoints that disagree on the creator keep no kind: the whole answer is UNKNOWN", async () => {
    const otherCreator: Edit = (result) => {
      const [st, x] = decodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "subjectInfo",
        data: result,
      }) as unknown as [number, bigint, Hex];
      return encodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "subjectInfo",
        result: [st, x, `0x${"77".repeat(32)}`] as never,
      }) as Hex;
    };
    const { efs } = twoEndpoints({ ...headDown, [SUBJECT_INFO]: otherCreator }, headDown);
    expect((await openObject(efs, readme)).status).toBe("UNKNOWN");
  });
});
