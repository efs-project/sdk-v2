// SPDX-License-Identifier: MIT
// The IndexedDB journal in a real browser: real IndexedDB, real Web Locks.
import { describe, expect, it } from "vitest";
import { indexedDbJournal } from "../src/web/journal.ts";
import { journalContract } from "./journal-contract.ts";

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
