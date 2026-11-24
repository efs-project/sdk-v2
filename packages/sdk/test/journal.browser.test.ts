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

describe("indexedDbByteStore", () => {
  it("persists verified bytes across instances, stays under its cap, and creates nothing on reads", async () => {
    const { indexedDbByteStore } = await import("../src/web/cache.ts");
    const name = `efs-test-cache-${Date.now()}`;
    const k = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
    const a = indexedDbByteStore({ name, maxBytes: 100 });
    expect(await a.get(k(1))).toBeUndefined();
    expect((await indexedDB.databases()).some((d) => d.name === name)).toBe(false);
    const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct "last used" times
    await a.put(k(1), new Uint8Array(40).fill(1));
    await tick();
    await a.put(k(2), new Uint8Array(40).fill(2));
    await tick();
    const b = indexedDbByteStore({ name, maxBytes: 100 });
    expect((await b.get(k(1)))?.[0]).toBe(1); // a fresh instance (a reload) sees it, and 1 is now the most recent
    await tick();
    await a.put(k(3), new Uint8Array(40).fill(3)); // over 100: the least recently used (2) goes
    const c = indexedDbByteStore({ name, maxBytes: 100 });
    expect(await c.get(k(2))).toBeUndefined();
    expect((await c.get(k(3)))?.[0]).toBe(3);
    await c.clear();
    expect(await c.get(k(3))).toBeUndefined();
  });
});
