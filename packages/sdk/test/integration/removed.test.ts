// SPDX-License-Identifier: MIT
// "Show removed" on a real chain: one author's released and hidden entries in a folder, each with its last target,
// from their own scope list (no Lens), paged, COMPLETE only for a whole scan, and restorable straight from the list.
// Uses anvil's public development mnemonic, index 15 (no other test file uses it).
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, PrincipalId, RecordId } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planCreateFolder,
  planRemoveEntries,
  planRestoreEntries,
  planUnhideEntries,
} from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { publish } from "../../src/files/plan.ts";
import { listRemoved, type RemovedRow } from "../../src/files/removed.ts";
import { ledgerViewsAbi } from "../../src/generated/abis.ts";
import { planLoneHide } from "../../src/testing/index.ts";
import { hideEntry, releaseEntry } from "./recipes.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
  seed: { files: { name: string; headRecordId: RecordId }[] };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const dana = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 15,
});
const text = (s: string) => new TextEncoder().encode(s);
let w: Awaited<ReturnType<typeof createWriter>>;
let me: PrincipalId;
let folder: FolderRef;
const files: Record<string, { kind: "file"; subject: string }> = {};

/** The fixture behind a fetch whose historyAt replies are rewritten by `f` (History code, head). */
const historyEdited = (f: (found: number, head: Record<string, unknown>) => [number, unknown]) => {
  const edit: Edit = (result) => {
    const [found, head] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "historyAt",
      data: result,
    }) as unknown as [number, Record<string, unknown>];
    return encodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "historyAt",
      result: f(found, head) as never,
    }) as Hex;
  };
  return createEfs({
    rpcs: [fixture.rpcUrl],
    deployment,
    fetch: tampered({ [sel(ledgerViewsAbi, "historyAt")]: edit }),
  });
};

const run = async (planned: Promise<{ status: string } & Record<string, unknown>>) => {
  const p = (await planned) as {
    status: string;
    parts?: unknown[];
    review?: Record<string, unknown>;
  };
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  expect((await w.runSequence(p.parts as never)).state).toBe("COMPLETE");
  return p.review as Record<string, unknown>;
};

beforeAll(async () => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [dana.address, "0x56bc75e2d63100000"],
    }),
  });
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: dana },
    journal: memoryJournal(),
  });
  me = w.principal;
  const made = await run(planCreateFolder(efs, w, { folder: root, name: "removed-test" }) as never);
  folder = made["created"] as FolderRef;
  for (const n of ["kept.txt", "gone.txt", "hidden.txt", "p1.txt", "p2.txt", "p3.txt"]) {
    const r = await run(planCreateFile(efs, w, { folder, name: n, content: text(n) }) as never);
    files[n] = r["file"] as { kind: "file"; subject: string };
  }
  await run(
    planRemoveEntries(efs, w, {
      entries: [
        { folder, name: "gone.txt" },
        { folder, name: "p1.txt" },
        { folder, name: "p2.txt" },
        { folder, name: "p3.txt" },
      ],
    }) as never,
  );
  await run(
    planRemoveEntries(efs, w, { entries: [{ folder, name: "hidden.txt" }], hide: true }) as never,
  );
});

describe("listRemoved (fixture)", () => {
  it("lists your released and hidden entries with their last targets, and nothing live; one page is COMPLETE", async () => {
    const page = await listRemoved(efs, { folder, author: me });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.coverage).toEqual({ state: "COMPLETE" });
    const byName = Object.fromEntries(page.rows.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual([
      "gone.txt",
      "hidden.txt",
      "p1.txt",
      "p2.txt",
      "p3.txt",
    ]);
    expect(byName["gone.txt"]).toMatchObject({
      state: "RELEASED",
      last: "KNOWN",
      target: files["gone.txt"],
    });
    expect(byName["hidden.txt"]).toMatchObject({
      state: "MASKED",
      last: "KNOWN",
      target: files["hidden.txt"],
    });
    expect((byName["gone.txt"] as RemovedRow).revision).toBeGreaterThan(0n);
  });

  it("pages: PARTIAL with a cursor until the end, the same rows in all, never COMPLETE from a cursor", async () => {
    const names: string[] = [];
    let page = await listRemoved(efs, { folder, author: me }, { limit: 2 });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.coverage).toEqual({ state: "PARTIAL", why: "MORE_PAGES" });
    names.push(...page.rows.map((r) => r.name));
    let guard = 0;
    while (page.status === "PRESENT" && page.next && guard++ < 10) {
      page = await listRemoved(efs, { folder, author: me }, { limit: 2, cursor: page.next });
      if (page.status !== "PRESENT") throw new Error(page.status);
      expect(page.coverage.state).toBe("PARTIAL");
      names.push(...page.rows.map((r) => r.name));
    }
    expect(page.status === "PRESENT" && page.coverage).toEqual({
      state: "PARTIAL",
      why: "RESUMED",
    });
    expect(names.sort()).toEqual(["gone.txt", "hidden.txt", "p1.txt", "p2.txt", "p3.txt"]);
  });

  it("an author with nothing removed here: an empty COMPLETE page, the only empty page there is", async () => {
    const stranger = `0x${"0".repeat(24)}${"34".repeat(20)}` as PrincipalId;
    expect(await listRemoved(efs, { folder, author: stranger })).toMatchObject({
      status: "PRESENT",
      rows: [],
      coverage: { state: "COMPLETE" },
    });
  });

  it("not a folder: ABSENT_PROVEN for no record, INVALID for a record of another Type", async () => {
    const missing: FolderRef = { kind: "folder", directory: `0x${"5a".repeat(32)}` as RecordId };
    expect((await listRemoved(efs, { folder: missing, author: me })).status).toBe("ABSENT_PROVEN");
    const revision: FolderRef = {
      kind: "folder",
      directory: deployment.seed.files[0]?.headRecordId as RecordId,
    };
    expect((await listRemoved(efs, { folder: revision, author: me })).status).toBe("INVALID");
  });

  // A removed entry's target is never guessed. On an honest endpoint it is always known (the ledger only hides or
  // releases a bound entry), so a history that can't name it is the endpoint's fault: the read is UNKNOWN, never a row.
  it("history that can't be read back: the page and the restore are UNKNOWN, never a guessed target", async () => {
    const lost = historyEdited((_found, head) => [2, head]); // History.NONE
    expect(await listRemoved(lost, { folder, author: me })).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "NOT_YET_DECIDABLE", retry: "transient" },
    });
    expect(
      await planRestoreEntries(lost, w, { entries: [{ folder, name: "p1.txt" }] }),
    ).toMatchObject({ status: "UNKNOWN", reason: { code: "NOT_YET_DECIDABLE" } });
    // The same entry on an honest endpoint restores to its real target.
    const honest = await planRestoreEntries(efs, w, { entries: [{ folder, name: "p1.txt" }] });
    if (honest.status !== "PLANNED") throw new Error(honest.status);
    expect(honest.review.entries[0]?.target).toEqual(files["p1.txt"]);
  });

  const lies: { what: string; lie: Record<string, unknown>; name?: string }[] = [
    { what: "a released version before a released one", lie: { state: 3 } },
    { what: "a hidden version before a hidden one", lie: { state: 2 }, name: "hidden.txt" },
    { what: "a version at another admission than asked", lie: { state: 1, admission: 1n } },
    {
      what: "a bound version with a target kind no FOLDER bind carries",
      lie: { state: 1, targetKind: 7 },
    },
    { what: "a removed version with no earlier one", lie: { state: 2, prevAdmission: 0n } },
  ];
  it.each(lies)(
    "history that breaks the ledger's rules ($what): UNKNOWN",
    async ({ lie, name = "p1.txt" }) => {
      const lying = historyEdited((found, head) => [found, { ...head, ...lie }]);
      expect(await listRemoved(lying, { folder, author: me })).toMatchObject({
        status: "UNKNOWN",
        reason: { code: "RPC_ERROR", retry: "transient" },
      });
      expect(await planRestoreEntries(lying, w, { entries: [{ folder, name }] })).toMatchObject({
        status: "UNKNOWN",
        reason: { code: "RPC_ERROR" },
      });
    },
  );

  it("restores straight from the list", async () => {
    await run(planRestoreEntries(efs, w, { entries: [{ folder, name: "gone.txt" }] }) as never);
    const page = await listRemoved(efs, { folder, author: me });
    expect(page.status === "PRESENT" && page.rows.map((r) => r.name).sort()).toEqual([
      "hidden.txt",
      "p1.txt",
      "p2.txt",
      "p3.txt",
    ]);
  });
  it("a hidden entry later released: two versions back, still its real target, and restorable", async () => {
    // The SDK's remove only takes a bound entry, so the RELEASE of a hidden one is a raw action.
    const before = await listRemoved(efs, { folder, author: me });
    if (before.status !== "PRESENT") throw new Error(before.status);
    const hidden = before.rows.find((r) => r.name === "hidden.txt") as RemovedRow;
    expect(hidden.state).toBe("MASKED");
    const planned = await w.planActions(
      releaseEntry(folder.directory, "hidden.txt", hidden.revision),
    );
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    expect((await w.run(planned.plan)).reconcile?.outcome).toBe("COMMITTED");
    const after = await listRemoved(efs, { folder, author: me });
    if (after.status !== "PRESENT") throw new Error(after.status);
    expect(after.rows.find((r) => r.name === "hidden.txt")).toMatchObject({
      state: "RELEASED",
      target: files["hidden.txt"],
      revision: hidden.revision + 1n,
    });
    const restore = await planRestoreEntries(efs, w, {
      entries: [{ folder, name: "hidden.txt" }],
    });
    if (restore.status !== "PLANNED") throw new Error(restore.status);
    expect(restore.review.entries[0]?.target).toEqual(files["hidden.txt"]);
  });
});

/** A files-name/2 record for `name`, alone. */
const publishName = (name: string) => {
  const step = publish(efs.deployment.typeIds["files-name/2"] as Hex, text(name), "files-name/2");
  return {
    actions: [step.action],
    bodies: [step.body],
    effects: [{ code: "files.name", args: { name } }],
  };
};
/** Send one raw action set and expect it admitted. */
const admit = async (input: Parameters<typeof w.planActions>[0]) => {
  const p = await w.planActions(input);
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  expect((await w.run(p.plan)).reconcile?.outcome).toBe("COMMITTED");
};
/** My row for `name` in the removed list. */
const rowOf = async (name: string) => {
  const page = await listRemoved(efs, { folder, author: me });
  if (page.status !== "PRESENT") throw new Error(page.status);
  return page.rows.find((r) => r.name === name);
};
/** Hide and release my entry at `name` in turn, `n` statements, starting from its revision `from`. */
const alternate = async (name: string, from: bigint, n: number, startMasked: boolean) => {
  let rev = from;
  let masked = startMasked;
  for (let i = 0; i < n; i++) {
    await admit(
      masked ? releaseEntry(folder.directory, name, rev) : hideEntry(folder.directory, name, rev),
    );
    masked = !masked;
    rev++;
  }
  return rev;
};

describe("removed entries under the tag release's rules (fixture)", () => {
  it("a lone hide (a mask at a name you never placed anything at) is NEVER_BOUND: no target, Unhide not Restore", async () => {
    // A first statement at a FOLDER position needs the name record (validator code 1): publish it, then hide.
    await admit(publishName("ghost.txt"));
    await admit(hideEntry(folder.directory, "ghost.txt", 0n));
    const ghost = await rowOf("ghost.txt");
    expect(ghost).toMatchObject({ state: "MASKED", last: "NEVER_BOUND", revision: 1n });
    expect(ghost).not.toHaveProperty("target");
    // Restore has nothing to put back: a named refusal, never ENTRY_ABSENT.
    expect(
      await planRestoreEntries(efs, w, { entries: [{ folder, name: "ghost.txt" }] }),
    ).toMatchObject({ status: "REFUSED", refused: [{ index: 0, code: "NEVER_BOUND" }] });
    // Unhide releases the mask; a released name you never placed anything at is no longer listed.
    await run(planUnhideEntries(efs, w, { entries: [{ folder, name: "ghost.txt" }] }) as never);
    expect(await rowOf("ghost.txt")).toBeUndefined();
    // Unhide takes only your own hidden entries.
    expect(
      await planUnhideEntries(efs, w, { entries: [{ folder, name: "kept.txt" }] }),
    ).toMatchObject({ status: "REFUSED", refused: [{ index: 0, code: "NOT_HIDDEN" }] });
  });

  it("an alternating history deeper than the old bound of 8 still names the last target", async () => {
    const r = await run(
      planCreateFile(efs, w, { folder, name: "deep.txt", content: text("deep") }) as never,
    );
    const file = r["file"];
    // Bound at revision 1: hide, release, hide, … 12 statements (revision 13 is a release).
    await alternate("deep.txt", 1n, 12, false);
    expect(await rowOf("deep.txt")).toMatchObject({
      state: "RELEASED",
      last: "KNOWN",
      target: file,
      revision: 13n,
    });
    const restore = await planRestoreEntries(efs, w, { entries: [{ folder, name: "deep.txt" }] });
    if (restore.status !== "PLANNED") throw new Error(restore.status);
    expect(restore.review.entries[0]?.target).toEqual(file);
  });

  it("a history deeper than the walk's bound is UNKNOWN for that row only; the rest of the page stands", async () => {
    await run(
      planCreateFile(efs, w, { folder, name: "deeper.txt", content: text("deeper") }) as never,
    );
    await alternate("deeper.txt", 1n, 34, false);
    const page = await listRemoved(efs, { folder, author: me });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.rows.find((x) => x.name === "deeper.txt")).toMatchObject({
      last: "UNKNOWN",
      reason: { code: "LIMIT_EXCEEDED" },
    });
    expect(page.rows.find((x) => x.name === "p2.txt")).toMatchObject({ last: "KNOWN" });
    expect(
      await planRestoreEntries(efs, w, { entries: [{ folder, name: "deeper.txt" }] }),
    ).toMatchObject({ status: "REFUSED", refused: [{ index: 0, code: "HISTORY_UNKNOWN" }] });
  });
});

describe("planLoneHide (@efs/sdk/testing, fixture)", () => {
  it("hides a name you never placed anything at, publishing its name record only when missing", async () => {
    const made = await run(planCreateFolder(efs, w, { folder: root, name: "lone-test" }) as never);
    const here = made["created"] as FolderRef;
    const kinds = (parts: { actions: { kind: number; expectedRevision: bigint }[] }[]) =>
      parts.flatMap((p) => p.actions.map((a) => [a.kind, a.expectedRevision]));
    const rowAt = async (name: string) => {
      const page = await listRemoved(efs, { folder: here, author: me });
      if (page.status !== "PRESENT") throw new Error(page.status);
      return page.rows.find((r) => r.name === name);
    };
    // A fresh name: the name record (validator code 1), then the UNBIND at revision 0.
    const first = await planLoneHide(efs, w, { folder: here, name: "lone.txt" });
    if (first.status !== "PLANNED") throw new Error(first.status);
    expect(first.review).toMatchObject({
      kind: "efs.loneHideReview",
      records: 1,
      entry: { folder: { kind: "folder", directory: here.directory }, name: "lone.txt" },
    });
    expect(kinds(first.parts as never)).toEqual([
      [ACTION.PUBLISH, 0n],
      [ACTION.UNBIND, 0n],
    ]);
    expect((await w.runSequence(first.parts)).state).toBe("COMPLETE");
    expect(await rowAt("lone.txt")).toMatchObject({
      state: "MASKED",
      last: "NEVER_BOUND",
      revision: 1n,
    });
    // Already hidden, or your own entry: not a lone hide to make.
    await expect(planLoneHide(efs, w, { folder: here, name: "lone.txt" })).rejects.toMatchObject({
      code: "MISUSE",
    });
    await run(
      planCreateFile(efs, w, { folder: here, name: "mine.txt", content: text("m") }) as never,
    );
    await expect(planLoneHide(efs, w, { folder: here, name: "mine.txt" })).rejects.toMatchObject({
      code: "MISUSE",
    });
    // After Unhide the name can be hidden again (a retried test), now without the name record.
    await run(
      planUnhideEntries(efs, w, { entries: [{ folder: here, name: "lone.txt" }] }) as never,
    );
    const again = await planLoneHide(efs, w, { folder: here, name: "lone.txt" });
    if (again.status !== "PLANNED") throw new Error(again.status);
    expect(again.review.records).toBe(0);
    expect(kinds(again.parts as never)).toEqual([[ACTION.UNBIND, 2n]]);
    expect((await w.runSequence(again.parts)).state).toBe("COMPLETE");
    expect(await rowAt("lone.txt")).toMatchObject({
      state: "MASKED",
      last: "NEVER_BOUND",
      revision: 3n,
    });
    // A name you once placed something at is not lone: its hide would be KNOWN.
    await run(
      planRemoveEntries(efs, w, { entries: [{ folder: here, name: "mine.txt" }] }) as never,
    );
    await expect(planLoneHide(efs, w, { folder: here, name: "mine.txt" })).rejects.toMatchObject({
      code: "MISUSE",
    });
  });
});
