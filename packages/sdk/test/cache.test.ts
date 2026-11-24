// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { memoryByteStore, memoryResultStore } from "../src/cache/stores.ts";

const k = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

describe("memory caches", () => {
  it("byte store: least recently used out by size, copies in and out, oversized entries skipped", async () => {
    const s = memoryByteStore({ maxBytes: 100 });
    await s.put(k(1), new Uint8Array(40).fill(1));
    await s.put(k(2), new Uint8Array(40).fill(2));
    expect((await s.get(k(1)))?.[0]).toBe(1); // 1 is now the most recent
    await s.put(k(3), new Uint8Array(40).fill(3)); // over 100: 2 (least recent) goes
    expect(await s.get(k(2))).toBeUndefined();
    expect((await s.get(k(1)))?.[0]).toBe(1);
    expect((await s.get(k(3)))?.[0]).toBe(3);
    const out = (await s.get(k(3))) as Uint8Array;
    out[0] = 99;
    expect((await s.get(k(3)))?.[0]).toBe(3); // a returned copy never changes the store
    await s.put(k(4), new Uint8Array(101));
    expect(await s.get(k(4))).toBeUndefined();
    expect(await s.get(k(1).toUpperCase().replace("0X", "0x") as `0x${string}`)).toBeDefined();
  });

  it("result store: bounded entries, structured copies", async () => {
    const s = memoryResultStore({ maxEntries: 2 });
    await s.put("a", { n: 1n });
    await s.put("b", { n: 2n });
    await s.get("a");
    await s.put("c", { n: 3n });
    expect(await s.get("b")).toBeUndefined();
    expect(await s.get("a")).toEqual({ n: 1n });
    const v = (await s.get("c")) as { n: bigint };
    v.n = 0n;
    expect(await s.get("c")).toEqual({ n: 3n });
  });
});
