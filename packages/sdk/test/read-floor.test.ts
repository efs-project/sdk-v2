// SPDX-License-Identifier: MIT
// The read floor's rules (docs/design/read-floor.md), without a chain: which floors each policy is held to, how a
// served block raises a floor (higher, or a sibling at the same height), and how journal seeds wait, bind, settle on
// the chain's genesis and stay ignored after a reset. The pin's use of it is tested on the fixture
// (test/integration/read-floor.test.ts).
import { describe, expect, it } from "vitest";
import { ReadFloor } from "../src/chain/floor.ts";
import type { Hex } from "../src/core/hex.ts";

const h = (n: number, tag = "a") => `0x${tag.repeat(2)}${n.toString(16).padStart(62, "0")}` as Hex;
const b = (n: number, tag = "a") => ({ blockNumber: BigInt(n), blockHash: h(n, tag) });
const GENESIS_A = `0x${"1".repeat(64)}` as Hex;
const GENESIS_B = `0x${"2".repeat(64)}` as Hex;

describe("ReadFloor", () => {
  it("latest is held to every floor, safe to safe and finalized, finalized to its own", () => {
    const f = new ReadFloor();
    f.raise("finalized", b(10));
    f.raise("safe", b(20));
    f.raise("latest", b(15));
    expect(f.need("latest")?.blockNumber).toBe(20n);
    expect(f.need("safe")?.blockNumber).toBe(20n);
    expect(f.need("finalized")?.blockNumber).toBe(10n);
    // A finalized read after a latest one is not held to the latest block: it asked for an older one.
    const g = new ReadFloor();
    g.raise("latest", b(100));
    expect(g.need("finalized")).toBeUndefined();
  });

  it("a served block raises the floor, never lowers it; a sibling at the same height replaces it", () => {
    const f = new ReadFloor();
    f.raise("latest", b(10));
    f.raise("latest", b(8));
    expect(f.snapshot().latest).toEqual(b(10));
    f.raise("latest", b(10, "b")); // a reorg at that height: the served block is canonical where it was read
    expect(f.snapshot().latest).toEqual(b(10, "b"));
    f.raise("latest", b(11));
    expect(f.snapshot().latest).toEqual(b(11));
  });

  it("a journal seed waits until a read would go below it, then the genesis decides", () => {
    const f = new ReadFloor();
    f.seed({ key: "s1", ...b(50), genesisHash: GENESIS_A });
    expect(f.need("latest")).toBeUndefined(); // nothing is read for a seed until it binds
    expect(f.bindingSeed(60n)).toBeUndefined(); // a head above it: it binds nothing
    const s = f.bindingSeed(40n);
    expect(s?.blockNumber).toBe(50n);
    f.settleSeed(s as never, GENESIS_A); // the same chain: it becomes the floor
    expect(f.need("latest")?.blockNumber).toBe(50n);
    expect(f.bindingSeed(40n)).toBeUndefined();
  });

  it("a seed from another chain (same id and ledger, another genesis) is ignored, and stays ignored", () => {
    const f = new ReadFloor();
    f.seed({ key: "s1", ...b(50), genesisHash: GENESIS_A });
    f.settleSeed(f.bindingSeed(5n) as never, GENESIS_B);
    expect(f.need("latest")).toBeUndefined();
    f.seed({ key: "s1", ...b(50), genesisHash: GENESIS_A }); // offered again by the journal
    expect(f.bindingSeed(5n)).toBeUndefined();
  });

  it("a served block at or above a seed settles it without a genesis read", () => {
    const f = new ReadFloor();
    f.seed({ key: "s1", ...b(50), genesisHash: GENESIS_A });
    f.raise("latest", b(55));
    expect(f.bindingSeed(0n)).toBeUndefined();
    // A safe or finalized pin settles nothing: a save's block is a latest-ness.
    const g = new ReadFloor();
    g.seed({ key: "s1", ...b(50), genesisHash: GENESIS_A });
    g.raise("finalized", b(55));
    expect(g.bindingSeed(0n)?.blockNumber).toBe(50n);
  });

  it("reset forgets the floors and ignores the seeds offered so far; a new seed still counts", () => {
    const f = new ReadFloor();
    f.raise("latest", b(10));
    f.seed({ key: "old", ...b(50), genesisHash: GENESIS_A });
    f.reset();
    expect(f.snapshot()).toEqual({});
    f.seed({ key: "old", ...b(50), genesisHash: GENESIS_A });
    expect(f.bindingSeed(0n)).toBeUndefined();
    f.seed({ key: "new", ...b(60), genesisHash: GENESIS_A });
    expect(f.bindingSeed(0n)?.key).toBe("new");
  });

  it("snapshot is a copy, and the wait must be a finite number of milliseconds", () => {
    const f = new ReadFloor();
    f.raise("latest", b(10));
    const s = f.snapshot();
    (s.latest as { blockNumber: bigint }).blockNumber = 99n;
    expect(f.need("latest")?.blockNumber).toBe(10n);
    expect(() => new ReadFloor(-1)).toThrow(TypeError);
    expect(() => new ReadFloor(Number.NaN)).toThrow(TypeError);
    expect(new ReadFloor(0).behindWaitMs).toBe(0);
  });
});

describe("onCaughtUp: a BEHIND episode per policy, closed once by the next pin that serves at the floor", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  it("opens on BEHIND and closes on that policy's next served block: each listener once, with that block", async () => {
    const f = new ReadFloor();
    f.raise("latest", b(10));
    f.markBehind("latest");
    const got: unknown[] = [];
    f.onCaughtUp((e) => got.push(e));
    f.onCaughtUp((e) => got.push(["second", e.at?.blockNumber]));
    await tick();
    expect(got).toEqual([]); // still behind: nothing yet
    f.served("latest", b(12));
    expect(got).toEqual([{ policy: "latest", at: b(12) }, ["second", 12n]]);
    f.markBehind("latest");
    f.served("latest", b(13));
    expect(got).toHaveLength(2); // one-shot: a listener never fires twice
  });

  it("a served block under another policy does not close the episode", async () => {
    const f = new ReadFloor();
    f.markBehind("finalized");
    const got: unknown[] = [];
    f.onCaughtUp((e) => got.push(e.policy), { policy: "finalized" });
    f.served("latest", b(20));
    await tick();
    expect(got).toEqual([]);
    f.served("finalized", b(18));
    expect(got).toEqual(["finalized"]);
  });

  it("subscribing with nothing open fires on the next microtask; unsubscribe stops it", async () => {
    const f = new ReadFloor();
    f.raise("latest", b(7));
    const got: unknown[] = [];
    f.onCaughtUp((e) => got.push(e));
    const stop = f.onCaughtUp(() => got.push("stopped"));
    stop();
    expect(got).toEqual([]); // never synchronously
    await tick();
    expect(got).toEqual([{ policy: "latest", at: b(7) }]);
    // Unsubscribed while an episode is open: never called.
    f.markBehind("latest");
    const off = f.onCaughtUp(() => got.push("off"));
    off();
    f.served("latest", b(9));
    expect(got).toHaveLength(1);
  });

  it("reset closes every open episode and calls its listeners; a throwing listener stops nothing", () => {
    const f = new ReadFloor();
    f.markBehind("latest");
    f.markBehind("safe");
    const got: unknown[] = [];
    f.onCaughtUp(() => {
      throw new Error("a listener's own fault");
    });
    f.onCaughtUp((e) => got.push(e), { policy: "safe" });
    f.onCaughtUp((e) => got.push(e));
    f.reset();
    expect(got).toEqual([
      { policy: "latest", at: null },
      { policy: "safe", at: null },
    ]);
  });
});
