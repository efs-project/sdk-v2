// SPDX-License-Identifier: MIT
// The IndexedDB journal in a real browser: real IndexedDB, real Web Locks.
import { describe, expect, it } from "vitest";
import { indexedDbJournal } from "../src/web/journal.ts";
import { journalContract, SAMPLE } from "./journal-contract.ts";

let n = 0;
let current = "";
journalContract(
  "indexedDB",
  () => {
    current = `efs-test-${Date.now()}-${n++}`;
    return indexedDbJournal({ name: current });
  },
  { reopen: () => indexedDbJournal({ name: current }) },
);

describe("indexedDB journal specifics", () => {
  it("uses Web Locks, so the lock spans every tab and worker of the origin", async () => {
    const a = indexedDbJournal({ name: `efs-test-locks-${Date.now()}` });
    const b = indexedDbJournal({ name: `efs-test-locks-other-${Date.now()}` });
    expect(a.crossContext).toBe(true);
    // Two journals (even over different databases) share the origin's lock space, as two tabs would.
    let release = (): void => {};
    const held = a.withLock(
      "efs:test:shared",
      false,
      () => new Promise<void>((r) => (release = r)),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(await b.withLock("efs:test:shared", false, async () => "b")).toBe("BUSY");
    release();
    await held;
    expect(await b.withLock("efs:test:shared", false, async () => "b")).toBe("b");
  });
});

describe("indexedDB journal on a fresh origin", () => {
  const listed = async (name: string) => (await indexedDB.databases()).some((d) => d.name === name);
  it("reads and locks create no database; the first put does", async () => {
    const name = `efs-test-guest-${Date.now()}`;
    const j = indexedDbJournal({ name });
    expect(await j.unresolved("efs:1:0x0:0x0:0x0")).toEqual([]);
    expect(await j.get(SAMPLE.planId)).toBeUndefined();
    expect(await j.withLock("efs:test:guest", false, async () => "locked")).toBe("locked");
    expect(await listed(name)).toBe(false);
    await j.put(SAMPLE);
    expect(await listed(name)).toBe(true);
    expect((await j.get(SAMPLE.planId))?.stage).toBe(SAMPLE.stage);
  });
  it("a reader that found nothing still sees a database another context creates later", async () => {
    const name = `efs-test-late-${Date.now()}`;
    const reader = indexedDbJournal({ name });
    expect(await reader.get(SAMPLE.planId)).toBeUndefined();
    await indexedDbJournal({ name }).put(SAMPLE); // "another tab"
    expect((await reader.get(SAMPLE.planId))?.planId).toBe(SAMPLE.planId);
  });
});
