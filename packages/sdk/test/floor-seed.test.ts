// SPDX-License-Identifier: MIT
// A save read back from the journal seeds the read floor only when its record is well formed (security review of
// 640eeb6): a genesis hash and a committed block that are 32-byte hex words and a bigint block number, on this
// deployment's chain id and ledger. Anything else (a damaged or hand-edited record) is not a floor. No chain: every
// part of these records is committed, so building their progress reads nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memoryJournal, openJournal } from "../src/actions/index.ts";
import type { SequenceRecord } from "../src/actions/journal.ts";
import { createEfs } from "../src/client.ts";
import type { Hex } from "../src/core/hex.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as { chainId: number; realmId: Hex; ledger: Hex };
const word = (c: string) => `0x${c.repeat(64)}` as Hex;
const GOOD = { blockNumber: 500n, blockHash: word("b") };

function record(
  id: string,
  over: { genesisHash?: unknown; committedAt?: unknown; chainId?: number; ledger?: Hex } = {},
): SequenceRecord {
  const ledger = over.ledger ?? deployment.ledger;
  return {
    schema: "efs-sdk-sequence/1",
    sequenceId: word(id),
    lock: `efs:${deployment.chainId}:${deployment.realmId}:${ledger}:0x${"1".repeat(40)}`.toLowerCase(),
    chainId: over.chainId ?? deployment.chainId,
    realmId: deployment.realmId,
    ledger,
    account: `0x${"1".repeat(40)}` as Hex,
    ...("genesisHash" in over
      ? { genesisHash: over.genesisHash as Hex }
      : { genesisHash: word("9") }),
    parts: [
      {
        actions: [],
        bodies: [],
        effects: [],
        committed: true,
        final: false,
        ...("committedAt" in over
          ? { committedAt: over.committedAt as never }
          : { committedAt: GOOD }),
      },
    ],
    state: "COMPLETE",
    final: false,
    history: [],
  } as SequenceRecord;
}

async function seedsFrom(r: SequenceRecord) {
  const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });
  const journal = memoryJournal();
  await journal.putSequence(r);
  await openJournal(efs, { journal }).pendingSequences();
  return efs._internal.pool.floor.bindingSeed(0n);
}

describe("a journal record seeds the floor only when it is well formed", () => {
  it("a well-formed record on this chain seeds its committed block", async () => {
    expect(await seedsFrom(record("a"))).toMatchObject({
      blockNumber: 500n,
      blockHash: GOOD.blockHash,
    });
  });

  it("a malformed genesis hash, committed block or block number seeds nothing", async () => {
    for (const bad of [
      record("b", { genesisHash: "0x12" }),
      record("c", { genesisHash: 42 }),
      record("d", { committedAt: { blockNumber: 500n, blockHash: "0x12" } }),
      record("e", { committedAt: { blockNumber: "500", blockHash: GOOD.blockHash } }),
      record("f", { committedAt: { blockNumber: -1n, blockHash: GOOD.blockHash } }),
    ])
      expect(await seedsFrom(bad), JSON.stringify(bad.sequenceId)).toBeUndefined();
  });

  it("an implausible block number (above 2^53 - 1) seeds nothing", async () => {
    const huge = record("h", {
      committedAt: { blockNumber: 2n ** 53n, blockHash: GOOD.blockHash },
    });
    expect(await seedsFrom(huge)).toBeUndefined();
  });

  it("one damaged part never hides the others: the highest well-formed part seeds", async () => {
    const r = record("i");
    const parts = [
      { ...(r.parts[0] as object), committedAt: { blockNumber: 900n, blockHash: "0x12" } },
      r.parts[0],
    ];
    expect(await seedsFrom({ ...r, parts } as SequenceRecord)).toMatchObject({ blockNumber: 500n });
  });

  it("another chain id or ledger seeds nothing", async () => {
    expect(await seedsFrom(record("g", { chainId: deployment.chainId + 1 }))).toBeUndefined();
  });
});
