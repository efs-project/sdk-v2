// SPDX-License-Identifier: MIT
// Folder writes on a real chain: create a folder and files under a parent, two authors at one name (the Lens decides,
// every candidate is listed), remove (release falls through, hide masks), restore, rename and move (atomic, the link
// keeps working, a path through the old name answers ABSENT_PROVEN), batches, and the refusals that plan nothing.
// Two accounts of anvil's public development mnemonic (indexes 10 and 11, used by no other test file), funded here.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, keccak256, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import { type Hex, type PrincipalId, type RecordId, ZERO_WORD } from "../../src/core/hex.ts";
import { openFile, readBytes } from "../../src/files/bytes.ts";
import {
  planCreateFile,
  planCreateFolder,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
} from "../../src/files/entries.ts";
import { type FolderRef, listFolder, lookupEntry, resolvePath } from "../../src/files/folders.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { bindingKey, positionKey } from "../../src/protocol/keys.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const alice = mnemonicToAccount(MNEMONIC, { addressIndex: 10 });
const bob = mnemonicToAccount(MNEMONIC, { addressIndex: 11 });
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

let w: Awaited<ReturnType<typeof writerFor>>;
let wb: Awaited<ReturnType<typeof writerFor>>;
let A: PrincipalId;
let B: PrincipalId;
let both: { principals: PrincipalId[] };
let folder: FolderRef;

/** Plan, expect PLANNED, send, expect COMPLETE; returns the review. */
const run = async <R>(
  writer: typeof w,
  planned: Promise<
    | { status: "PLANNED"; parts: Parameters<typeof w.runSequence>[0]; review: R }
    | { status: string }
  >,
) => {
  const p = await planned;
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  const done = await writer.runSequence(
    (p as { parts: Parameters<typeof w.runSequence>[0] }).parts,
  );
  expect(done.state).toBe("COMPLETE");
  return { review: (p as { review: R }).review, sequenceId: done.sequenceId };
};

beforeAll(async () => {
  for (const a of [alice, bob]) await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]); // 100 ETH
  w = await writerFor(alice);
  wb = await writerFor(bob);
  A = w.principal;
  B = wb.principal;
  both = { principals: [A, B] };
});

describe("folder writes (fixture)", () => {
  it("creates a folder under a parent, then files in it: inline, and typed (one chunk)", async () => {
    const made = await run(
      w,
      planCreateFolder(efs, w, { folder: root, name: "folder-writes", lens: both }),
    );
    expect(made.review).toMatchObject({
      kind: "efs.createFolderReview",
      name: "folder-writes",
      author: A,
      parts: 1,
      visibleInLens: true,
      shownInstead: null,
    });
    folder = { kind: "folder", directory: made.review.created.directory };
    // The save names what it did, from the journal alone (read directly: it may already be final, and so no longer
    // listed as pending, when other test files mine blocks on this shared chain).
    const rec = await journal.getSequence(made.sequenceId);
    expect(rec?.effect).toMatchObject({ kind: "files.createFolder", name: "folder-writes" });
    const top = await listFolder(efs, root, { lens: both });
    expect(
      top.status === "PRESENT" && top.rows.find((r) => r.name === "folder-writes"),
    ).toMatchObject({
      kind: "folder",
      author: A,
      target: { directory: folder.directory, owner: A },
    });
    const empty = await listFolder(efs, folder, { lens: both });
    expect(empty).toMatchObject({ status: "PRESENT", rows: [], coverage: { state: "COMPLETE" } });
    expect(empty.status === "PRESENT" && empty.folder.owner).toBe(A);

    const a = await run(
      w,
      planCreateFile(efs, w, { folder, name: "a.txt", content: text("alice's a\n"), lens: both }),
    );
    expect(a.review).toMatchObject({
      layout: "inline",
      mediaType: "",
      parts: 1,
      visibleInLens: true,
    });
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const b = await run(
      w,
      planCreateFile(efs, w, {
        folder,
        name: "b.svg",
        content: svg,
        mediaType: "Image/SVG+XML",
        lens: both,
      }),
    );
    expect(b.review).toMatchObject({ layout: "chunk", mediaType: "image/svg+xml" });
    const opened = await openFile(efs, b.review.file, { lens: both });
    expect(opened.status === "PRESENT" && opened.file).toMatchObject({
      mediaType: "image/svg+xml",
      layout: "chunk",
    });
    expect(opened.status === "PRESENT" && (await readBytes(efs, opened.file)).bytes).toEqual(svg);
    const page = await listFolder(efs, folder, { lens: both, withSize: true });
    expect(page.status === "PRESENT" && page.rows.map((r) => [r.name, r.kind, r.size])).toEqual([
      ["a.txt", "file", 10n],
      ["b.svg", "file", BigInt(svg.length)],
    ]);
  });

  it("refuses your own name with NAME_TAKEN_MINE, and plans nothing", async () => {
    const again = await planCreateFile(efs, w, {
      folder,
      name: "a.txt",
      content: text("x"),
      lens: both,
    });
    expect(again).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 0, code: "NAME_TAKEN_MINE", entry: { name: "a.txt" } }],
    });
    const dir = await planCreateFolder(efs, w, { folder, name: "a.txt", lens: both });
    expect(dir).toMatchObject({ status: "REFUSED", refused: [{ code: "NAME_TAKEN_MINE" }] });
    const nowhere = { kind: "folder" as const, directory: `0x${"ab".repeat(32)}` as RecordId };
    expect(
      await planCreateFile(efs, w, { folder: nowhere, name: "x", content: text("x") }),
    ).toMatchObject({
      status: "REFUSED",
      refused: [{ code: "FOLDER_ABSENT" }],
    });
    await expect(
      planCreateFile(efs, w, { folder, name: "a/b", content: text("x") }),
    ).rejects.toMatchObject({
      code: "MISUSE",
      details: { rule: "excluded-character" },
    });
  });

  it("another author at the same name: allowed, the Lens decides, and every candidate is listed", async () => {
    const bobs = await run(
      wb,
      planCreateFile(efs, wb, { folder, name: "a.txt", content: text("bob's a\n"), lens: both }),
    );
    expect(bobs.review).toMatchObject({ visibleInLens: false, shownInstead: { author: A } });
    const look = await lookupEntry(efs, { folder, name: "a.txt" }, { lens: both });
    if (look.status !== "PRESENT") throw new Error(look.status);
    expect(look.selected.author).toBe(A);
    expect(look.conflict).toBe(true);
    expect(look.candidates.map((c) => c.author)).toEqual([A, B]); // Lens order
    expect((look.candidates[0]?.firstBound ?? 0n) < (look.candidates[1]?.firstBound ?? 0n)).toBe(
      true,
    );
    // Bob can't move or remove Alice's entry: NOT_YOURS names whose it is.
    expect(
      await planRemoveEntries(efs, wb, { entries: [{ folder, name: "b.svg" }], lens: both }),
    ).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 0, code: "NOT_YOURS", author: A }],
    });
    expect(
      await planRemoveEntries(efs, wb, { entries: [{ folder, name: "none" }], lens: both }),
    ).toMatchObject({
      status: "REFUSED",
      refused: [{ code: "ENTRY_ABSENT" }],
    });
  });

  it("remove releases (the next author shows); restore puts it back; hide masks, and restores too", async () => {
    const rm = await run(
      w,
      planRemoveEntries(efs, w, { entries: [{ folder, name: "a.txt" }], lens: both }),
    );
    expect(rm.review).toMatchObject({ hide: false, entries: [{ shownAfter: { author: B } }] });
    let look = await lookupEntry(efs, { folder, name: "a.txt" }, { lens: both });
    expect(look.status === "PRESENT" && look.selected.author).toBe(B);
    // Restoring twice: the second is NOT_REMOVED.
    const back = await run(
      w,
      planRestoreEntries(efs, w, { entries: [{ folder, name: "a.txt" }], lens: both }),
    );
    expect(back.review).toMatchObject({ entries: [{ visibleInLens: true, shownInstead: null }] });
    expect(
      await planRestoreEntries(efs, w, { entries: [{ folder, name: "a.txt" }], lens: both }),
    ).toMatchObject({
      status: "REFUSED",
      refused: [{ code: "NOT_REMOVED" }],
    });
    look = await lookupEntry(efs, { folder, name: "a.txt" }, { lens: both });
    expect(look.status === "PRESENT" && look.selected.author).toBe(A);

    const hid = await run(
      w,
      planRemoveEntries(efs, w, { entries: [{ folder, name: "a.txt" }], hide: true, lens: both }),
    );
    expect(hid.review).toMatchObject({ hide: true, entries: [{ shownAfter: null }] });
    look = await lookupEntry(efs, { folder, name: "a.txt" }, { lens: both });
    expect(look).toMatchObject({ status: "MASKED", by: A });
    const masked = await listFolder(efs, folder, { lens: both });
    expect(masked.status === "PRESENT" && masked.skipped.hidden).toBe(1);
    expect(masked.status === "PRESENT" && masked.rows.map((r) => r.name)).toEqual(["b.svg"]);
    // Bob's own view (Bob first) still shows Bob's entry: a mask only affects readers who rank Alice above him.
    const bobFirst = await lookupEntry(
      efs,
      { folder, name: "a.txt" },
      { lens: { principals: [B, A] } },
    );
    expect(bobFirst.status === "PRESENT" && bobFirst.selected.author).toBe(B);
    await run(w, planRestoreEntries(efs, w, { entries: [{ folder, name: "a.txt" }], lens: both }));
    look = await lookupEntry(efs, { folder, name: "a.txt" }, { lens: both });
    expect(look.status === "PRESENT" && look.selected.author).toBe(A);
  });

  it("rename keeps the link; a path through the old name answers ABSENT_PROVEN", async () => {
    const before = await lookupEntry(efs, { folder, name: "b.svg" }, { lens: both });
    if (before.status !== "PRESENT" || before.selected.target?.kind !== "file")
      throw new Error("no b.svg");
    const file = before.selected.target;
    const mv = await run(
      w,
      planMoveEntries(efs, w, {
        moves: [{ from: { folder, name: "b.svg" }, to: { name: "c.svg" } }],
        lens: both,
      }),
    );
    expect(mv.review).toMatchObject({
      kind: "efs.moveReview",
      parts: 1,
      moves: [{ to: { name: "c.svg" }, target: file, shownAfter: null, visibleInLens: true }],
    });
    expect(
      await resolvePath(efs, { from: folder, segments: ["b.svg"] }, { lens: both }),
    ).toMatchObject({
      status: "ABSENT_PROVEN",
      segment: 0,
    });
    const now = await resolvePath(efs, { from: folder, segments: ["c.svg"] }, { lens: both });
    expect(now.status === "PRESENT" && now.target).toEqual(file);
    expect((await openFile(efs, file, { lens: both })).status).toBe("PRESENT"); // the object link still opens
  });

  it("moves a file into a subfolder and refuses moving a folder into itself; `via` is required for folders", async () => {
    const sub = await run(w, planCreateFolder(efs, w, { folder, name: "sub", lens: both }));
    const subRef: FolderRef = { kind: "folder", directory: sub.review.created.directory };
    await run(
      w,
      planMoveEntries(efs, w, {
        moves: [{ from: { folder, name: "c.svg" }, to: { folder: subRef } }],
        lens: both,
      }),
    );
    const inSub = await listFolder(efs, subRef, { lens: both });
    expect(inSub.status === "PRESENT" && inSub.rows.map((r) => r.name)).toEqual(["c.svg"]);
    const fw: FolderRef = { kind: "folder", directory: folder.directory };
    const moveFw = (to: Parameters<typeof planMoveEntries>[2]["moves"][number]["to"]) =>
      planMoveEntries(efs, w, {
        moves: [{ from: { folder: root, name: "folder-writes" }, to }],
        lens: both,
      });
    // Moving folder-writes into its own child sub: the planner resolves the path itself and refuses.
    await expect(
      moveFw({ folder: subRef, via: { from: root, segments: ["folder-writes", "sub"] } }),
    ).rejects.toMatchObject({ code: "MISUSE", details: { code: "INTO_ITSELF" } });
    // A path that starts at the moved folder itself still shows it on the way.
    await expect(
      moveFw({ folder: subRef, via: { from: fw, segments: ["sub"] } }),
    ).rejects.toMatchObject({
      code: "MISUSE",
      details: { code: "INTO_ITSELF" },
    });
    // No path at all: refused, never skipped.
    await expect(moveFw({ folder: subRef })).rejects.toThrow(/to\.via/);
    // A path that does not end at the destination (empty, or elsewhere): PATH_CHANGED, plan nothing.
    expect(await moveFw({ folder: subRef, via: { from: root, segments: [] } })).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 0, code: "PATH_CHANGED" }],
    });
    expect(
      await moveFw({ folder: subRef, via: { from: root, segments: ["folder-writes"] } }),
    ).toMatchObject({
      status: "REFUSED",
      refused: [{ code: "PATH_CHANGED" }],
    });
  });

  it("batches: several moves or removals in one review and one prompt, or none at all", async () => {
    for (const n of ["x1.txt", "x2.txt", "x3.txt"])
      await run(w, planCreateFile(efs, w, { folder, name: n, content: text(n), lens: both }));
    const moves = await run(
      w,
      planMoveEntries(efs, w, {
        moves: ["x1.txt", "x2.txt", "x3.txt"].map((n) => ({
          from: { folder, name: n },
          to: { name: `moved-${n}` },
        })),
        lens: both,
      }),
    );
    expect(moves.review).toMatchObject({ parts: 1, prompts: { sequential: 1 } });
    expect(moves.review.moves).toHaveLength(3);
    // One refusal (Bob's entry) refuses the whole batch, listing it by index.
    const mixed = await planRemoveEntries(efs, wb, {
      entries: [
        { folder, name: "a.txt" },
        { folder, name: "moved-x1.txt" },
      ],
      lens: { principals: [B, A] },
    });
    expect(mixed).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 1, code: "NOT_YOURS", author: A }],
    });
    const gone = await run(
      w,
      planRemoveEntries(efs, w, {
        entries: ["moved-x1.txt", "moved-x2.txt", "moved-x3.txt"].map((name) => ({ folder, name })),
        lens: both,
      }),
    );
    expect(gone.review).toMatchObject({ parts: 1, entries: [{}, {}, {}] });
    const left = await listFolder(efs, folder, { lens: both });
    expect(left.status === "PRESENT" && left.rows.map((r) => r.name).sort()).toEqual([
      "a.txt",
      "sub",
    ]);
  });

  it("a batch cannot close a folder cycle through its own moves, but may reorganize", async () => {
    const p = await run(w, planCreateFolder(efs, w, { folder, name: "p", lens: both }));
    const q = await run(w, planCreateFolder(efs, w, { folder, name: "q", lens: both }));
    const P: FolderRef = { kind: "folder", directory: p.review.created.directory };
    const Q: FolderRef = { kind: "folder", directory: q.review.created.directory };
    // p into q and q into p, in one batch: each move alone looks fine, together they leave both unreachable.
    await expect(
      planMoveEntries(efs, w, {
        moves: [
          {
            from: { folder, name: "p" },
            to: { folder: Q, via: { from: root, segments: ["folder-writes", "q"] } },
          },
          {
            from: { folder, name: "q" },
            to: { folder: P, via: { from: root, segments: ["folder-writes", "p"] } },
          },
        ],
        lens: both,
      }),
    ).rejects.toMatchObject({ code: "MISUSE", details: { code: "INTO_ITSELF" } });
    // p up to the root and q into p, together: no cycle, so it plans and lands.
    await run(
      w,
      planMoveEntries(efs, w, {
        moves: [
          { from: { folder, name: "p" }, to: { folder: root, via: { from: root, segments: [] } } },
          {
            from: { folder, name: "q" },
            to: { folder: P, via: { from: root, segments: ["folder-writes", "p"] } },
          },
        ],
        lens: both,
      }),
    );
    const deep = await resolvePath(efs, { from: root, segments: ["p", "q"] }, { lens: both });
    expect(deep.status === "PRESENT" && deep.target).toMatchObject({
      kind: "folder",
      directory: Q.directory,
    });
  });

  it("a move onto a name another move in the batch is leaving is refused (your own entry still holds it)", async () => {
    for (const n of ["y1.txt", "y2.txt"])
      await run(w, planCreateFile(efs, w, { folder, name: n, content: text(n), lens: both }));
    const swap = await planMoveEntries(efs, w, {
      moves: [
        { from: { folder, name: "y1.txt" }, to: { name: "y2.txt" } },
        { from: { folder, name: "y2.txt" }, to: { name: "y3.txt" } },
      ],
      lens: both,
    });
    expect(swap).toMatchObject({
      status: "REFUSED",
      refused: [{ index: 0, code: "NAME_TAKEN_MINE" }],
    });
  });

  it("restore brings back the latest target at a name that was reused", async () => {
    const first = await run(
      w,
      planCreateFile(efs, w, { folder, name: "r.txt", content: text("first"), lens: both }),
    );
    await run(w, planRemoveEntries(efs, w, { entries: [{ folder, name: "r.txt" }], lens: both }));
    // A new file at the released name rebinds it: the position's history now holds two targets.
    const second = await run(
      w,
      planCreateFile(efs, w, { folder, name: "r.txt", content: text("second"), lens: both }),
    );
    expect(second.review.file).not.toEqual(first.review.file);
    await run(
      w,
      planRemoveEntries(efs, w, { entries: [{ folder, name: "r.txt" }], hide: true, lens: both }),
    );
    const back = await run(
      w,
      planRestoreEntries(efs, w, { entries: [{ folder, name: "r.txt" }], lens: both }),
    );
    expect(back.review).toMatchObject({ entries: [{ target: second.review.file }] });
    const look = await lookupEntry(efs, { folder, name: "r.txt" }, { lens: both });
    expect(look.status === "PRESENT" && look.selected.target).toEqual(second.review.file);
  });

  it("a batch too big for one transaction splits into parts, each move's RELEASE and BIND kept together", async () => {
    const names = ["s1.txt", "s2.txt", "s3.txt", "s4.txt", "s5.txt", "s6.txt"];
    for (const n of names)
      await run(w, planCreateFile(efs, w, { folder, name: n, content: text(n), lens: both }));
    const plan = await planMoveEntries(
      efs,
      w,
      {
        moves: names.map((n) => ({ from: { folder, name: n }, to: { name: `split-${n}` } })),
        lens: both,
      },
      { txGasCap: 3_000_000n }, // a small cap forces several parts
    );
    if (plan.status !== "PLANNED") throw new Error(plan.status);
    expect(plan.parts.length).toBeGreaterThan(1);
    for (const part of plan.parts) {
      const kinds = part.actions.map((a) => a.kind);
      // Every RELEASE is followed by its BIND in the same part (names, when new, come first).
      kinds.forEach((k, i) => {
        if (k === ACTION.RELEASE) expect(kinds[i + 1]).toBe(ACTION.BIND);
      });
      expect(kinds.filter((k) => k === ACTION.RELEASE).length).toBe(
        kinds.filter((k) => k === ACTION.BIND).length,
      );
    }
    expect((await w.runSequence(plan.parts)).state).toBe("COMPLETE");
    const page = await listFolder(efs, folder, { lens: both });
    expect(
      page.status === "PRESENT" && page.rows.filter((r) => r.name.startsWith("split-")).length,
    ).toBe(6);
  });

  it("restoring a folder needs its path; restore after a move puts the same file back at the old name too", async () => {
    const holder = await run(w, planCreateFolder(efs, w, { folder, name: "holder", lens: both }));
    await run(w, planRemoveEntries(efs, w, { entries: [{ folder, name: "holder" }], lens: both }));
    await expect(
      planRestoreEntries(efs, w, { entries: [{ folder, name: "holder" }], lens: both }),
    ).rejects.toThrow(/needs `via`/);
    const back = await run(
      w,
      planRestoreEntries(efs, w, {
        entries: [{ folder, name: "holder", via: { from: root, segments: ["folder-writes"] } }],
        lens: both,
      }),
    );
    // Removed (released), so nothing else points at the folder: restoring adds no second placement.
    expect(back.review).toMatchObject({
      entries: [
        {
          target: { kind: "folder", directory: holder.review.created.directory },
          alsoReferenced: 0,
        },
      ],
    });
    // A file moved away, then restored at its old name: it is placed in both folders (one file, two entries).
    const f = await run(
      w,
      planCreateFile(efs, w, { folder, name: "both.txt", content: text("b"), lens: both }),
    );
    const H: FolderRef = { kind: "folder", directory: holder.review.created.directory };
    await run(
      w,
      planMoveEntries(efs, w, {
        moves: [{ from: { folder, name: "both.txt" }, to: { folder: H } }],
        lens: both,
      }),
    );
    const twice = await run(
      w,
      planRestoreEntries(efs, w, { entries: [{ folder, name: "both.txt" }], lens: both }),
    );
    // The review says so: one live placement (the moved entry in holder) already points at the file.
    expect(twice.review).toMatchObject({ entries: [{ target: f.review.file, alsoReferenced: 1 }] });
    for (const where of [folder, H]) {
      const look = await lookupEntry(efs, { folder: where, name: "both.txt" }, { lens: both });
      expect(look.status === "PRESENT" && look.selected.target).toEqual(f.review.file);
    }
  });

  it("restore walks back through a hide and a release to the last bound target", async () => {
    const f = await run(
      w,
      planCreateFile(efs, w, { folder, name: "deep.txt", content: text("d"), lens: both }),
    );
    await run(
      w,
      planRemoveEntries(efs, w, {
        entries: [{ folder, name: "deep.txt" }],
        hide: true,
        lens: both,
      }),
    );
    // Release the masked entry with a raw action: its history is now BOUND, MASKED, RELEASED.
    const key = bindingKey(
      A,
      positionKey(PURPOSES.folder, folder.directory, keccak256(toHex("deep.txt"))),
    );
    const raw = (await rpc("eth_call", [
      {
        to: efs.deployment.readers.ledgerReads,
        data: encodeFunctionData({
          abi: ledgerReadsAbi,
          functionName: "head",
          args: [efs.deployment.ledger, key],
        }),
      },
      "latest",
    ])) as Hex;
    const [, head] = decodeFunctionResult({
      abi: ledgerReadsAbi,
      functionName: "head",
      data: raw,
    }) as unknown as [number, { revision: bigint; state: number }];
    expect(head.state).toBe(2); // MASKED
    const released = await w.planActions({
      actions: [
        {
          kind: ACTION.RELEASE,
          typeId: ZERO_WORD,
          bodyHashOrRecordId: ZERO_WORD,
          purpose: PURPOSES.folder,
          subject: folder.directory,
          role: keccak256(toHex("deep.txt")),
          target: ZERO_WORD,
          expectedRevision: head.revision,
          salt: ZERO_WORD,
        },
      ],
      bodies: ["0x"],
      effects: [],
    });
    if (released.status !== "PLANNED") throw new Error(released.status);
    expect((await w.run(released.plan)).reconcile?.outcome).toBe("COMMITTED");
    const back = await run(
      w,
      planRestoreEntries(efs, w, { entries: [{ folder, name: "deep.txt" }], lens: both }),
    );
    expect(back.review).toMatchObject({ entries: [{ target: f.review.file }] });
  });
});
