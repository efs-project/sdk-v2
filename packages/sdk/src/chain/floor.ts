// SPDX-License-Identifier: MIT
// The read floor (docs/design/read-floor.md): per Efs instance and per basis policy, the highest block a VERIFIED pin
// has served. A pin never serves a block below it: an endpoint that is behind fails over, then the pin polls for a
// short while, then the read is UNKNOWN with reason BEHIND, never a quiet older read. Only a pin raises a floor (a
// call pinned to a block hash never does). Seeds from the journal (the block a save was seen committed at) wait here
// until a pin would read below one: then the chain's identity (its genesis block hash, read once per instance)
// decides whether the seed is this chain's, and a seed from another chain (a reset dev chain) is ignored.
import type { Hex } from "../core/hex.js";
import type { BasisPolicy } from "./pool.js";

/** A block a floor holds: its number and hash. */
export interface FloorBlock {
  blockNumber: bigint;
  blockHash: Hex;
}
/** The floors of one instance, per policy (efs.readFloor()). */
export interface ReadFloors {
  latest?: FloorBlock;
  safe?: FloorBlock;
  finalized?: FloorBlock;
}
/**
 * What onCaughtUp tells a listener: the policy whose BEHIND episode closed, and the block that was served then
 * (informational: re-read, never compare it). Null when nothing was served: a reset, or no floor known yet.
 */
export interface CaughtUp {
  policy: BasisPolicy;
  at: FloorBlock | null;
}

/** A floor read back from the journal, with the identity of the chain it was recorded on. */
export interface FloorSeed extends FloorBlock {
  /** Unique per record (the sequence id): a seed ignored once stays ignored on this instance. */
  key: string;
  genesisHash: Hex;
}

/** The floors a pin under each policy must be at or above: `latest` at least every floor, `safe` safe and finalized. */
const COVERS: Readonly<Record<BasisPolicy, readonly BasisPolicy[]>> = {
  latest: ["latest", "safe", "finalized"],
  safe: ["safe", "finalized"],
  finalized: ["finalized"],
};
const MAX_HASHES = 256;

/** The higher of two floor blocks (undefined counts as no floor). */
export function higher(
  a: FloorBlock | undefined,
  b: FloorBlock | undefined,
): FloorBlock | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.blockNumber > a.blockNumber ? b : a;
}

export class ReadFloor {
  /** How long a pin polls when every endpoint is behind, before the read is UNKNOWN BEHIND. */
  readonly behindWaitMs: number;
  /** This chain's genesis block hash, once a pin or a save has read it. */
  genesis: Hex | undefined;
  private floors: { [K in BasisPolicy]?: FloorBlock } = {};
  private readonly seeds = new Map<string, FloorSeed>();
  private readonly ignored = new Set<string>();
  /** Block hashes at a height, by (endpoint, served head, height): the `atLeast.blockHash` check, once per head. */
  private readonly hashes = new Map<string, Hex>();
  /** Policies with a BEHIND episode open: a pin under them ended UNKNOWN BEHIND and none has served since. */
  private readonly behind = new Set<BasisPolicy>();
  /** The listeners each open episode will call once, in the order they subscribed. */
  private readonly waiting = new Map<BasisPolicy, Set<(e: CaughtUp) => void>>();

  constructor(behindWaitMs = 4000) {
    if (!Number.isFinite(behindWaitMs) || behindWaitMs < 0)
      throw new TypeError("behindWaitMs must be a finite number of milliseconds, 0 or more");
    this.behindWaitMs = behindWaitMs;
  }

  /** The lowest block a pin under `policy` may serve, from this instance's own floors. */
  need(policy: BasisPolicy): FloorBlock | undefined {
    return COVERS[policy].reduce<FloorBlock | undefined>(
      (m, p) => higher(m, this.floors[p]),
      undefined,
    );
  }

  /**
   * A served block raises `policy`'s floor: a higher block, or another block at the same height (a reorg there: the
   * served block is canonical where it was read). Never lowers it. Under `latest` it also settles every journal seed
   * at or below it.
   */
  raise(policy: BasisPolicy, b: FloorBlock): void {
    const cur = this.floors[policy];
    const block = { blockNumber: b.blockNumber, blockHash: b.blockHash.toLowerCase() as Hex };
    if (
      !cur ||
      block.blockNumber > cur.blockNumber ||
      (block.blockNumber === cur.blockNumber && block.blockHash !== cur.blockHash)
    )
      this.floors[policy] = block;
    if (policy === "latest")
      for (const [k, s] of this.seeds) if (s.blockNumber <= block.blockNumber) this.seeds.delete(k);
  }

  /** Remember a floor from the journal. Nothing is read; it is checked when a pin would read below it. */
  seed(s: FloorSeed): void {
    if (this.ignored.has(s.key)) return;
    const cur = this.seeds.get(s.key);
    if (!cur || s.blockNumber > cur.blockNumber) this.seeds.set(s.key, { ...s });
  }

  /** The highest journal seed above `served`, if any: the one a pin must decide before it can serve `served`. */
  bindingSeed(served: bigint): FloorSeed | undefined {
    let best: FloorSeed | undefined;
    for (const s of this.seeds.values())
      if (s.blockNumber > served && (!best || s.blockNumber > best.blockNumber)) best = s;
    return best;
  }

  /** Decide a seed against this chain's genesis: the same chain raises the `latest` floor, another is ignored. */
  settleSeed(s: FloorSeed, genesis: Hex): void {
    this.seeds.delete(s.key);
    if (s.genesisHash.toLowerCase() === genesis.toLowerCase()) this.raise("latest", s);
    else this.ignored.add(s.key);
  }

  hashAt(key: string): Hex | undefined {
    return this.hashes.get(key);
  }
  rememberHash(key: string, hash: Hex): void {
    this.hashes.set(key, hash);
    while (this.hashes.size > MAX_HASHES)
      this.hashes.delete(this.hashes.keys().next().value as string);
  }

  /** A pin under `policy` ended UNKNOWN BEHIND: its episode is open until a pin under the same policy serves. */
  markBehind(policy: BasisPolicy): void {
    this.behind.add(policy);
  }

  /**
   * A VERIFIED pin under `policy` served `at` (at or above the floor, as every served block is): the policy's BEHIND
   * episode, if one is open, closes, and each of its listeners is called once.
   */
  served(policy: BasisPolicy, at: FloorBlock): void {
    if (!this.behind.delete(policy)) return;
    this.fire(policy, {
      blockNumber: at.blockNumber,
      blockHash: at.blockHash.toLowerCase() as Hex,
    });
  }

  /**
   * Call `listener` once when this client is caught up under `policy` (default "latest"): when the open BEHIND episode
   * closes (the next pin under that policy that serves), or, with none open, on the next microtask. Never more than
   * once; returns an unsubscribe. Not awaited; anything it throws is ignored. Nothing is read for it.
   */
  onCaughtUp(listener: (e: CaughtUp) => void, o: { policy?: BasisPolicy } = {}): () => void {
    const policy = o.policy ?? "latest";
    let live = true;
    const once = (e: CaughtUp) => {
      if (!live) return;
      live = false;
      try {
        listener(e);
      } catch {
        // a listener's own fault changes nothing here
      }
    };
    if (!this.behind.has(policy)) {
      void Promise.resolve().then(() => once({ policy, at: this.need(policy) ?? null }));
      return () => {
        live = false;
      };
    }
    const set = this.waiting.get(policy) ?? new Set<(e: CaughtUp) => void>();
    this.waiting.set(policy, set);
    set.add(once);
    return () => {
      live = false;
      this.waiting.get(policy)?.delete(once);
    };
  }

  private fire(policy: BasisPolicy, at: FloorBlock | null): void {
    const set = this.waiting.get(policy);
    this.waiting.delete(policy);
    for (const l of set ?? []) l({ policy, at });
  }

  snapshot(): ReadFloors {
    const out: ReadFloors = {};
    for (const p of ["latest", "safe", "finalized"] as const) {
      const f = this.floors[p];
      if (f) out[p] = { blockNumber: f.blockNumber, blockHash: f.blockHash };
    }
    return out;
  }

  /** Forget every floor (a reset or rewound dev chain), and ignore the journal seeds known so far on this instance. */
  reset(): void {
    // Nothing is BEHIND after a reset: every open episode closes and its listeners are called (with no block).
    const open = [...this.waiting.keys()];
    this.behind.clear();
    for (const p of open) this.fire(p, null);
    this.floors = {};
    for (const k of this.seeds.keys()) this.ignored.add(k);
    this.seeds.clear();
    this.hashes.clear();
  }
}
