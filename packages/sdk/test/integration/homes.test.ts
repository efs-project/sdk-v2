// SPDX-License-Identifier: MIT
// Homes on a real chain: an address is a folder parent (FilesFinalValidator code 2 admits an address-shaped subject),
// so anyone can attach files and folders to anyone's address. Reads (list, look up, resolve, open a home link) and
// every folder write take a home where they take a folder, with the same honesty: a home always exists, so an empty
// one is an empty COMPLETE page, never ABSENT_PROVEN; a missing name is ABSENT_PROVEN; pages are PARTIAL until the
// end; a cursor a write overtook is refused. A home's owner is the address's own author identity (the gateway's
// Keys.principalFor): the key principal of a key account, the Realm's contract principal of a contract.
// Two accounts of anvil's public development mnemonic (indexes 18 and 19, used by no other test file), funded here.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, PrincipalId, RecordId } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planCreateFolder,
  planHideEntries,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
  planUnhideEntries,
} from "../../src/files/entries.ts";
import {
  type FolderRef,
  type HomeRef,
  listFolder,
  lookupEntry,
  openHome,
  openPath,
  resolvePath,
} from "../../src/files/folders.ts";
import { listRemoved } from "../../src/files/removed.ts";
import { filesPageReaderAbi } from "../../src/generated/abis.ts";
import { link, parseLink } from "../../src/names/links.ts";
import { contractPrincipal, keyPrincipal } from "../../src/protocol/keys.ts";
import { planOtherEntry, recordingFetch } from "../../src/testing/index.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  ledger: Address;
  realmOrigin: Hex;
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 18 });
const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 19 });
const text = (s: string) => new TextEncoder().encode(s);
const journal = memoryJournal();
const writerFor = (account: typeof alice) =>
  createWriter(efs, { authorizer: { kind: "local", profile: "direct", account }, journal });
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await r.json()) as { result: unknown }).result;
};
const home = (address: Address): HomeRef => ({ kind: "home", address });

let wa: Awaited<ReturnType<typeof writerFor>>;
let wb: Awaited<ReturnType<typeof writerFor>>;
let A: PrincipalId;
let B: PrincipalId;
const bobHome = home(bob.address.toLowerCase() as Address);
const aliceHome = home(alice.address.toLowerCase() as Address);
const bobAddress = bob.address.toLowerCase() as Address;
/** Alice first, then Bob: the view in which Alice's attachments to Bob's home show. */
let aliceView: { principals: PrincipalId[] };
/** Bob's own view of his home: Bob first (efs.lens.place), then Alice. */
let bobView: { principals: PrincipalId[] };

const run = async (
  writer: typeof wa,
  planned: Promise<{ status: string } & Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const p = (await planned) as { status: string; parts?: unknown[]; review?: unknown };
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  expect((await writer.runSequence(p.parts as never)).state).toBe("COMPLETE");
  return p.review as Record<string, unknown>;
};

beforeAll(async () => {
  for (const a of [alice, bob]) await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]); // 100 ETH
  wa = await writerFor(alice);
  wb = await writerFor(bob);
  A = wa.principal;
  B = wb.principal;
  aliceView = { principals: [A, B] };
  bobView = efs.lens.place({ reader: bob.address, owner: B, base: { principals: [A] } }) as {
    principals: PrincipalId[];
  };
});

describe("homes: reads (fixture)", () => {
  it("a home always exists: an untouched address is an empty COMPLETE page, and a name in it is ABSENT_PROVEN", async () => {
    const nobody = "0x00000000000000000000000000000000000e5e05" as Address;
    const page = await listFolder(efs, home(nobody));
    expect(page).toMatchObject({
      status: "PRESENT",
      folder: { kind: "home", address: nobody, owner: keyPrincipal(nobody) },
      rows: [],
      coverage: { state: "COMPLETE" },
    });
    expect(await lookupEntry(efs, { folder: home(nobody), name: "a.txt" })).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    expect(
      await resolvePath(efs, { from: home(nobody), segments: ["photos", "cat.jpg"] }),
    ).toMatchObject({ status: "ABSENT_PROVEN", segment: 0, chain: [] });
  });

  it("an empty home is COMPLETE only when the index vouches for it at the basis; else UNKNOWN, never empty", async () => {
    const nobody = "0x00000000000000000000000000000000000e5e06" as Address;
    // The index's own answer, rewritten: coverage UNKNOWN (1) or PARTIAL (2), with no complete-from-origin claim.
    const withCoverage = (listingCoverage: number) => {
      const edit: Edit = (result) => {
        const page = decodeFunctionResult({
          abi: filesPageReaderAbi,
          functionName: "listDirectory",
          data: result,
        }) as unknown as Record<string, unknown>;
        return encodeFunctionResult({
          abi: filesPageReaderAbi,
          functionName: "listDirectory",
          result: { ...page, completeFromOrigin: false, listingCoverage } as never,
        });
      };
      return createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({ [sel(filesPageReaderAbi, "listDirectory")]: edit }),
      });
    };
    for (const coverage of [1, 2])
      expect(await listFolder(withCoverage(coverage), home(nobody))).toMatchObject({
        status: "UNKNOWN",
        folder: { kind: "home", address: nobody },
        reason: { code: "NOT_YET_DECIDABLE" },
      });
    // Untampered, the index vouches: an empty COMPLETE page.
    expect(await listFolder(efs, home(nobody))).toMatchObject({
      status: "PRESENT",
      rows: [],
      coverage: { state: "COMPLETE" },
    });
  });

  it("a home's owner is the address's author identity: a contract's is its contract principal, a 7702 account's its key", async () => {
    const ledger = deployment.ledger.toLowerCase() as Address;
    expect(await listFolder(efs, home(ledger))).toMatchObject({
      status: "PRESENT",
      folder: { owner: contractPrincipal(deployment.realmOrigin, ledger) },
    });
    // EIP-7702: exactly the 23-byte designator `ef0100 ‖ address` is still the signing key's namespace.
    const delegated = "0x00000000000000000000000000000000007e0702" as Address;
    await rpc("anvil_setCode", [delegated, `0xef0100${alice.address.slice(2)}`]);
    expect(await listFolder(efs, home(delegated))).toMatchObject({
      folder: { owner: keyPrincipal(delegated) },
    });
    const opened = await openHome(efs, ledger, { reader: alice.address });
    expect(opened).toMatchObject({
      kind: "efs.home",
      status: "PRESENT",
      home: {
        kind: "home",
        address: ledger,
        owner: contractPrincipal(deployment.realmOrigin, ledger),
      },
    });
    // The reader, then the home's owner, then the client's default Lens.
    expect(opened.status === "PRESENT" && opened.lens.principals.slice(0, 2)).toEqual([
      A,
      contractPrincipal(deployment.realmOrigin, ledger),
    ]);
  });

  it("a home's owner holds only as of its read: code deployed at the address between two reads switches it", async () => {
    // A counterfactual contract: a key-principal home until code lands there, then the Realm's contract principal.
    const later = "0x00000000000000000000000000000000000c0de5" as Address;
    expect(await openHome(efs, later)).toMatchObject({
      status: "PRESENT",
      home: { owner: keyPrincipal(later) },
    });
    await rpc("anvil_setCode", [later, "0x6000"]);
    expect(await openHome(efs, later)).toMatchObject({
      status: "PRESENT",
      home: { owner: contractPrincipal(deployment.realmOrigin, later) },
    });
    // Cleared: the key's own namespace again.
    await rpc("anvil_setCode", [later, "0x"]);
    expect(await listFolder(efs, home(later))).toMatchObject({
      folder: { owner: keyPrincipal(later) },
    });
  });

  it("the zero address is never a home, and a malformed one is MISUSE", async () => {
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    await expect(listFolder(efs, home(zero))).rejects.toMatchObject({ code: "MISUSE" });
    await expect(listFolder(efs, home("0x1234" as Address))).rejects.toMatchObject({
      code: "MISUSE",
    });
    // An address-shaped word (12 leading zero bytes) given as a folder id names a home, never a record: refused, not
    // read as "no such folder" while the home's entries sit at that same word.
    await expect(
      listFolder(efs, {
        kind: "folder",
        directory: keyPrincipal(alice.address) as unknown as RecordId,
      }),
    ).rejects.toMatchObject({ code: "MISUSE" });
  });
});

describe("homes: attaching to someone's address (fixture)", () => {
  it("Alice attaches a file to Bob's home; it lists under her name, and Bob's own view puts his entry first", async () => {
    const made = await run(
      wa,
      planCreateFile(efs, wa, { folder: bobHome, name: "hello.txt", content: text("hi bob\n") }),
    );
    expect(made).toMatchObject({
      folder: { kind: "home", address: bobAddress },
      name: "hello.txt",
    });
    const page = await listFolder(efs, bobHome, { lens: aliceView });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.folder).toMatchObject({ kind: "home", address: bobAddress, owner: B });
    expect(page.rows.find((r) => r.name === "hello.txt")).toMatchObject({
      author: A,
      kind: "file",
    });
    expect(page.coverage).toEqual({ state: "COMPLETE" });

    // Bob puts his own hello.txt in his home: his view (Bob first) shows his, and lists Alice's as a candidate.
    await run(
      wb,
      planCreateFile(efs, wb, { folder: bobHome, name: "hello.txt", content: text("mine\n") }),
    );
    expect(bobView.principals.slice(0, 2)).toEqual([B, A]);
    const look = await lookupEntry(efs, { folder: bobHome, name: "hello.txt" }, { lens: bobView });
    if (look.status !== "PRESENT") throw new Error(look.status);
    expect(look.selected.author).toBe(B);
    expect(look.candidates.map((c) => c.author)).toEqual([B, A]);
    expect(look.entry.folder).toMatchObject({ kind: "home", address: bobAddress });
  });

  it("a folder in a home resolves by path, and a home link opens under the reader then the home's owner", async () => {
    const made = await run(wb, planCreateFolder(efs, wb, { folder: bobHome, name: "photos" }));
    const photos = made["created"] as FolderRef;
    expect(photos.owner).toBe(B);
    await run(
      wb,
      planCreateFile(efs, wb, { folder: photos, name: "cat.jpg", content: text("meow") }),
    );
    const r = await resolvePath(
      efs,
      { from: bobHome, segments: ["photos", "cat.jpg"] },
      { lens: bobView },
    );
    if (r.status !== "PRESENT") throw new Error(r.status);
    expect(r.chain.map((s) => [s.folder.kind, s.name, s.author])).toEqual([
      ["home", "photos", B],
      ["folder", "cat.jpg", B],
    ]);
    expect(r.chain[0]?.folder).toMatchObject({ kind: "home", address: bobAddress, owner: B });

    const parsed = parseLink(
      link({ kind: "home", address: bobAddress, names: ["photos", "cat.jpg"] }),
    );
    if (parsed.status !== "OK" || parsed.target.kind !== "home") throw new Error("not a home link");
    const opened = await openPath(efs, parsed.target, { reader: alice.address });
    expect(opened).toMatchObject({ status: "PRESENT", target: { kind: "file" } });
    expect("lens" in opened && opened.lens.principals.slice(0, 2)).toEqual([A, B]);
    const mine = await openHome(efs, bob.address, { reader: bob.address });
    expect(mine).toMatchObject({ status: "PRESENT", home: { address: bobAddress, owner: B } });
    expect(mine.status === "PRESENT" && mine.lens.principals[0]).toBe(B);

    // A home link carrying its own Lens needs no separate owner read: it walks the names directly. Counted on the
    // wire: one code probe, the one resolvePath batches with the first name to check the home itself; the default
    // Lens adds openHome's own.
    const rec = recordingFetch(globalThis.fetch as never);
    const counting = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: rec.fetch });
    const probes = () =>
      rec.calls
        .flatMap((c) => (Array.isArray(c.request) ? c.request : [c.request]))
        .filter(
          (q: { method?: string; params?: [{ to?: string; data?: string }] }) =>
            q.method === "eth_call" &&
            q.params?.[0]?.to === undefined &&
            String(q.params?.[0]?.data).includes("3b602052"),
        ).length;
    const withLens = parseLink(
      link({ kind: "home", address: bobAddress, names: ["photos", "cat.jpg"], lens: bobView }),
    );
    if (withLens.status !== "OK" || withLens.target.kind !== "home")
      throw new Error("no lens link");
    const given = await openPath(counting, withLens.target);
    expect(given).toMatchObject({ status: "PRESENT" });
    expect("lens" in given && given.lens).toEqual(bobView);
    expect(probes()).toBe(1);
    await openPath(counting, parsed.target);
    expect(probes()).toBe(3);
  });

  it("pages in a home are PARTIAL until the end, and a cursor a later write overtook is refused", async () => {
    const first = await listFolder(efs, bobHome, { lens: aliceView, limit: 1 });
    if (first.status !== "PRESENT" || !first.next) throw new Error("no cursor");
    expect(first.coverage).toEqual({ state: "PARTIAL", why: "MORE_PAGES" });
    await run(
      wa,
      planCreateFile(efs, wa, { folder: bobHome, name: "later.txt", content: text("l") }),
    );
    const stale = await listFolder(efs, bobHome, { lens: aliceView, limit: 1, cursor: first.next });
    expect(stale).toMatchObject({ status: "UNKNOWN", reason: { code: "BASIS_STALE" } });
  });
});

describe("homes: moves, removes, hides (fixture)", () => {
  it("moves between a home and a folder, both ways, with `via` from a home", async () => {
    const made = await run(wa, planCreateFolder(efs, wa, { folder: aliceHome, name: "inbox" }));
    const inbox = made["created"] as FolderRef;
    // Alice moves her hello.txt from Bob's home into her own home's inbox, by a path from her home.
    await run(
      wa,
      planMoveEntries(efs, wa, {
        moves: [
          {
            from: { folder: bobHome, name: "hello.txt" },
            to: {
              folder: inbox,
              name: "from-bob.txt",
              via: { from: aliceHome, segments: ["inbox"] },
            },
          },
        ],
        lens: aliceView,
      }),
    );
    const left = await lookupEntry(
      efs,
      { folder: bobHome, name: "hello.txt" },
      { lens: aliceView },
    );
    expect(left.status === "PRESENT" && left.selected.author).toBe(B); // Bob's own stays; Alice's left
    const there = await resolvePath(
      efs,
      { from: aliceHome, segments: ["inbox", "from-bob.txt"] },
      { lens: aliceView },
    );
    expect(there).toMatchObject({ status: "PRESENT" });
    // And back out of the folder, into Bob's home.
    await run(
      wa,
      planMoveEntries(efs, wa, {
        moves: [
          {
            from: { folder: inbox, name: "from-bob.txt" },
            to: { folder: bobHome, name: "back.txt" },
          },
        ],
        lens: aliceView,
      }),
    );
    const back = await lookupEntry(efs, { folder: bobHome, name: "back.txt" }, { lens: aliceView });
    expect(back.status === "PRESENT" && back.selected.author).toBe(A);

    // A folder moves too (a folder move needs `via`): into the inbox by a path from Alice's home, then back to the
    // home itself by an empty path from it.
    await run(wa, planCreateFolder(efs, wa, { folder: aliceHome, name: "box" }));
    await run(
      wa,
      planMoveEntries(efs, wa, {
        moves: [
          {
            from: { folder: aliceHome, name: "box" },
            to: { folder: inbox, via: { from: aliceHome, segments: ["inbox"] } },
          },
        ],
        lens: aliceView,
      }),
    );
    expect(
      await resolvePath(efs, { from: aliceHome, segments: ["inbox", "box"] }, { lens: aliceView }),
    ).toMatchObject({ status: "PRESENT", target: { kind: "folder" } });
    await run(
      wa,
      planMoveEntries(efs, wa, {
        moves: [
          {
            from: { folder: inbox, name: "box" },
            to: { folder: aliceHome, via: { from: aliceHome, segments: [] } },
          },
        ],
        lens: aliceView,
      }),
    );
    expect(
      await lookupEntry(efs, { folder: aliceHome, name: "box" }, { lens: aliceView }),
    ).toMatchObject({
      status: "PRESENT",
      selected: { kind: "folder", author: A },
    });
  });

  it("remove, restore, hide and unhide in a home, with Show removed listing it", async () => {
    await run(
      wa,
      planRemoveEntries(efs, wa, {
        entries: [{ folder: bobHome, name: "back.txt" }],
        lens: aliceView,
      }),
    );
    const removed = await listRemoved(efs, { folder: bobHome, author: A });
    if (removed.status !== "PRESENT") throw new Error(removed.status);
    expect(removed.folder).toMatchObject({ kind: "home", address: bobAddress });
    expect(removed.rows.find((r) => r.name === "back.txt")).toMatchObject({
      state: "RELEASED",
      last: "KNOWN",
    });
    await run(
      wa,
      planRestoreEntries(efs, wa, {
        entries: [{ folder: bobHome, name: "back.txt" }],
        lens: aliceView,
      }),
    );
    // Bob hides Alice's later.txt in his home: gone in his view, back after Unhide.
    const hid = await run(
      wb,
      planHideEntries(efs, wb, {
        entries: [{ folder: bobHome, name: "later.txt" }],
        lens: bobView,
      }),
    );
    expect(hid).toMatchObject({ entries: [{ shownNow: { author: A }, shownAfter: null }] });
    expect(
      await lookupEntry(efs, { folder: bobHome, name: "later.txt" }, { lens: bobView }),
    ).toMatchObject({
      status: "MASKED",
      by: B,
    });
    await run(
      wb,
      planUnhideEntries(efs, wb, {
        entries: [{ folder: bobHome, name: "later.txt" }],
        lens: bobView,
      }),
    );
    const shown = await lookupEntry(efs, { folder: bobHome, name: "later.txt" }, { lens: bobView });
    expect(shown.status === "PRESENT" && shown.selected.author).toBe(A);
  });
});

describe("homes: an entry with no file version, and blocking it (fixture)", () => {
  it("planOtherEntry places a junk row in someone's home or a folder; the owner blocks it", async () => {
    const salt = `0x${"0c".repeat(32)}` as Hex;
    const placed = await run(
      wb,
      planOtherEntry(efs, wb, { folder: aliceHome, name: "junk.bin", salt, lens: aliceView }),
    );
    expect(placed).toMatchObject({ kind: "efs.otherEntryReview", entry: { name: "junk.bin" } });
    const listed = await listFolder(efs, aliceHome, { lens: aliceView });
    expect(
      listed.status === "PRESENT" && listed.rows.find((r) => r.name === "junk.bin"),
    ).toMatchObject({
      kind: "other",
      author: B,
    });
    // Alice blocks it in her home.
    await run(
      wa,
      planHideEntries(efs, wa, {
        entries: [{ folder: aliceHome, name: "junk.bin" }],
        lens: aliceView,
      }),
    );
    expect(
      await lookupEntry(efs, { folder: aliceHome, name: "junk.bin" }, { lens: aliceView }),
    ).toMatchObject({
      status: "MASKED",
      by: A,
    });
    // Bob's own entry is already there: NAME_TAKEN_MINE; the same salt again: MISUSE.
    expect(
      await planOtherEntry(efs, wb, { folder: aliceHome, name: "junk.bin", lens: aliceView }),
    ).toMatchObject({ status: "REFUSED", refused: [{ code: "NAME_TAKEN_MINE" }] });
    await expect(
      planOtherEntry(efs, wb, { folder: aliceHome, name: "other.bin", salt, lens: aliceView }),
    ).rejects.toMatchObject({ code: "MISUSE" });
    // In a folder too.
    const made = await run(wa, planCreateFolder(efs, wa, { folder: aliceHome, name: "spamtrap" }));
    const trap = made["created"] as FolderRef;
    await run(wb, planOtherEntry(efs, wb, { folder: trap, name: "junk.bin", lens: aliceView }));
    const inTrap = await listFolder(efs, trap, { lens: aliceView });
    expect(inTrap.status === "PRESENT" && inTrap.rows.map((r) => [r.name, r.kind])).toEqual([
      ["junk.bin", "other"],
    ]);
  });
});
