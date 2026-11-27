// SPDX-License-Identifier: MIT
// The read floor on the fixture (docs/design/read-floor.md): a read is never served from a block older than one this
// client has read, nor than the read's `atLeast`. A lagging endpoint is a fetch wrapper in front of anvil that answers
// `latest` with an older block. A second fixture chain (chain B: the same chain id and the same deterministic ledger,
// a new genesis) shows that a journal's floor binds only on the chain it was recorded on, and is rewound with
// evm_revert for the reset and same-height cases. One account of anvil's public development mnemonic (index 30, used
// by no other test file), impersonated on both chains.
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
// @ts-expect-error tools/fixture.mjs is plain JS without declarations
import { down, up } from "../../../../tools/fixture.mjs";
import { createWriter, memoryJournal, openJournal } from "../../src/actions/index.ts";
import type { Journal } from "../../src/actions/journal.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs, type Efs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { EfsFault } from "../../src/core/errors.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ACTION } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deploymentA = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk";
const ME = mnemonicToAccount(MNEMONIC, { addressIndex: 30 }).address.toLowerCase() as Hex;
const B_NAME = `sdk-it-floor-b-${process.pid}`;
let chainB: { rpcUrl: string; deployment: Record<string, unknown> };

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const headOf = async (url: string) => BigInt((await rpc(url, "eth_blockNumber")) as Hex);

/**
 * Two endpoints in front of one chain: "fresh" forwards everything; "lag" answers `latest` with the block `lag.by`
 * below the head (everything else is forwarded, so calls at a block hash still work).
 */
function endpoints(chainUrl: string) {
  const lag = { by: 0 };
  const forward = async (req: { id: unknown; method: string; params?: unknown[] }) => {
    const res = await fetch(chainUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    return res.json();
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const lagging = String(url).includes("lag.test");
    const body = JSON.parse(init.body as string);
    const one = async (req: { id: unknown; method: string; params?: unknown[] }) => {
      if (
        lagging &&
        lag.by > 0 &&
        req.method === "eth_getBlockByNumber" &&
        req.params?.[0] === "latest"
      ) {
        const n = (await headOf(chainUrl)) - BigInt(lag.by);
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: await rpc(chainUrl, "eth_getBlockByNumber", [`0x${n.toString(16)}`, false]),
        };
      }
      return forward(req);
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    const text = JSON.stringify(out);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  };
  const LAG = { url: "http://lag.test/", label: "lag" };
  const FRESH = { url: "http://fresh.test/", label: "fresh" };
  return { lag, fetch: fetchImpl, LAG, FRESH };
}

const client = (
  deployment: unknown,
  e: ReturnType<typeof endpoints>,
  rpcs: { url: string; label: string }[],
  behindWaitMs = 300,
) => createEfs({ rpcs, deployment, fetch: e.fetch, reads: { behindWaitMs } });

/** One small save (a fresh chunk), through an impersonated account: anvil signs and mines it. */
async function save(efs: Efs, journal: Journal, chainUrl: string, seed: number) {
  const w = await createWriter(efs, {
    authorizer: {
      kind: "eip1193",
      profile: "direct",
      account: ME,
      provider: {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
          return rpc(chainUrl, method, (params as unknown[]) ?? []);
        },
      },
    },
    journal,
  });
  const chunk = encode.chunk(new Uint8Array(48).fill(seed));
  return w.runSequence([
    {
      actions: [
        {
          kind: ACTION.PUBLISH,
          typeId: (efs.deployment.typeIds as Record<string, Hex>)["files-bytes/1"] as Hex,
          bodyHashOrRecordId: keccak256(chunk),
          purpose: ZERO_WORD,
          subject: ZERO_WORD,
          role: ZERO_WORD,
          target: ZERO_WORD,
          expectedRevision: 0n,
          saltOrStrength: ZERO_WORD,
        },
      ],
      bodies: [`0x${Buffer.from(chunk).toString("hex")}` as Hex],
      effects: [{ code: "test.read-floor", args: {} }],
    },
  ]);
}

beforeAll(async () => {
  const ready = up(B_NAME, { ttlSeconds: 600 }) as { rpcUrl: string; deployment: string };
  chainB = { rpcUrl: ready.rpcUrl, deployment: JSON.parse(readFileSync(ready.deployment, "utf8")) };
  for (const url of [fixture.rpcUrl, chainB.rpcUrl]) {
    await rpc(url, "anvil_setBalance", [ME, "0x56bc75e2d63100000"]);
    await rpc(url, "anvil_impersonateAccount", [ME]);
  }
}, 180_000);
afterAll(() => {
  down(B_NAME);
});

describe("a read is never older than one this client has read", () => {
  it("an endpoint behind fails over: the read is served by the other, at or above the floor", async () => {
    const e = endpoints(fixture.rpcUrl);
    const efs = client(deploymentA, e, [e.LAG, e.FRESH]);
    const first = await efs.at();
    if (first.status !== "VERIFIED") throw new Error(first.status);
    expect(first.basis.endpoint).toBe("lag"); // no floor yet: the first endpoint serves
    e.lag.by = 2;
    const second = await efs.at();
    if (second.status !== "VERIFIED") throw new Error(second.status);
    expect(second.basis.endpoint).toBe("fresh");
    expect(second.basis.blockNumber).toBeGreaterThanOrEqual(first.basis.blockNumber);
    expect(second.evidence.attempts[0]).toMatchObject({
      endpoint: "lag",
      outcome: "FAILED",
      reason: { code: "BEHIND" },
    });
    // Only a pin raises the floor, to the block it served.
    expect(efs.readFloor().latest).toEqual({
      blockNumber: second.basis.blockNumber,
      blockHash: second.basis.blockHash,
    });
  });

  it("every endpoint behind: a few polls, then UNKNOWN BEHIND with the floor and the heads; never an older read", async () => {
    const e = endpoints(fixture.rpcUrl);
    const efs = client(deploymentA, e, [e.LAG]);
    const first = await efs.at();
    if (first.status !== "VERIFIED") throw new Error(first.status);
    e.lag.by = 2;
    const started = Date.now();
    const r = await efs.at();
    expect(r.status).toBe("UNKNOWN");
    if (r.status !== "UNKNOWN") return;
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(r.reason).toMatchObject({
      code: "BEHIND",
      retry: "transient",
      floor: { blockNumber: first.basis.blockNumber, blockHash: first.basis.blockHash },
      served: [{ endpoint: "lag", blockNumber: first.basis.blockNumber - 2n }],
    });
    expect(r.evidence.attempts).toHaveLength(5); // the first try and four polls
    // An endpoint that catches up within the wait is served.
    setTimeout(() => {
      e.lag.by = 0;
    }, 100);
    const late = await efs.at();
    expect(late).toMatchObject({ status: "VERIFIED" });
  });

  it("a save's own block holds every later read; its record carries the block and the chain", async () => {
    const e = endpoints(fixture.rpcUrl);
    const efs = client(deploymentA, e, [e.LAG]);
    const journal = memoryJournal();
    // Chain A well above chain B's height, so chain B's reads would be held by A's floor (the identity test).
    const gap = (await headOf(chainB.rpcUrl)) + 40n - (await headOf(fixture.rpcUrl));
    if (gap > 0n) await rpc(fixture.rpcUrl, "anvil_mine", [`0x${gap.toString(16)}`]);
    const done = await save(efs, journal, fixture.rpcUrl, 31);
    expect(done).toMatchObject({ state: "COMPLETE" });
    const visible = done.visibleAt;
    if (!visible) throw new Error("no visibleAt");
    expect((efs.readFloor().latest?.blockNumber ?? 0n) >= visible.blockNumber).toBe(true);
    const rec = await journal.getSequence(done.sequenceId);
    expect(rec?.parts[0]?.committedAt).toEqual(visible);
    const genesis = (await rpc(fixture.rpcUrl, "eth_getBlockByNumber", ["0x0", false])) as {
      hash: Hex;
    };
    expect(rec?.genesisHash).toBe(genesis.hash.toLowerCase());
    e.lag.by = 1;
    const after = await efs.at();
    expect(after.status).toBe("UNKNOWN");
    expect(after.status === "UNKNOWN" && after.reason.code).toBe("BEHIND");
    shared.journal = journal;
    shared.visible = visible;
  });

  it("another client on the same chain, reading the same journal, holds the save's block too", async () => {
    const { journal, visible } = shared;
    if (!journal || !visible) throw new Error("needs the save above");
    const e = endpoints(fixture.rpcUrl);
    const other = client(deploymentA, e, [e.LAG]);
    const listed = await openJournal(other, { journal }).pendingSequences();
    expect(listed.some((p) => p.visibleAt?.blockNumber === visible.blockNumber)).toBe(true);
    e.lag.by = Number((await headOf(fixture.rpcUrl)) - visible.blockNumber) + 1;
    const behind = await other.at();
    expect(behind.status).toBe("UNKNOWN");
    if (behind.status !== "UNKNOWN") return;
    expect(behind.reason).toMatchObject({
      code: "BEHIND",
      floor: { blockNumber: visible.blockNumber },
    });
    e.lag.by = 0;
    const read = await other.at();
    if (read.status !== "VERIFIED") throw new Error(read.status);
    expect(read.basis.blockNumber >= visible.blockNumber).toBe(true);
  });

  it("a journal's floor from chain A is ignored on chain B (same chain id and ledger, another genesis)", async () => {
    const { journal, visible } = shared;
    if (!journal || !visible) throw new Error("needs the save above");
    expect(chainB.deployment["chainId"]).toBe(deploymentA.chainId);
    expect(String(chainB.deployment["ledger"]).toLowerCase()).toBe(
      String(deploymentA.ledger).toLowerCase(),
    );
    const e = endpoints(chainB.rpcUrl);
    const onB = client(chainB.deployment, e, [e.FRESH]);
    const listed = await openJournal(onB, { journal }).pendingSequences();
    expect(listed.length).toBeGreaterThan(0); // the journal offers A's save here too
    const read = await onB.at();
    if (read.status !== "VERIFIED") throw new Error(`${read.status}`);
    // Chain B is below A's save: had the seed bound, this read would be BEHIND.
    expect(read.basis.blockNumber < visible.blockNumber).toBe(true);
    expect(onB.readFloor().latest?.blockNumber).toBe(read.basis.blockNumber);
  });
});

describe("atLeast: a block this client can't know about", () => {
  it("held to another client's block; a hash that is no longer canonical is reported, never refused", async () => {
    const e = endpoints(fixture.rpcUrl);
    const a = client(deploymentA, e, [e.FRESH]);
    const seen = await a.at();
    if (seen.status !== "VERIFIED") throw new Error(seen.status);
    const at = { blockNumber: seen.basis.blockNumber, blockHash: seen.basis.blockHash };
    e.lag.by = 2;
    const lagging = client(deploymentA, e, [e.LAG], 0);
    const held = await lagging.at("latest", { atLeast: { blockNumber: at.blockNumber } });
    expect(held).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "BEHIND", floor: { blockNumber: at.blockNumber } },
    });
    expect(held.evidence.attempts).toHaveLength(1); // a zero wait: no polls
    const b = client(deploymentA, e, [e.FRESH]);
    const ok = await b.at("latest", { atLeast: at });
    if (ok.status !== "VERIFIED") throw new Error(ok.status);
    expect(ok.basis.blockNumber >= at.blockNumber).toBe(true);
    expect(ok.basis.reorgedSince).toBeUndefined();
    const other = `0x${"ee".repeat(32)}` as Hex;
    const moved = await b.at("latest", {
      atLeast: { blockNumber: at.blockNumber, blockHash: other },
    });
    if (moved.status !== "VERIFIED") throw new Error(moved.status);
    expect(moved.basis.reorgedSince).toEqual({ blockNumber: at.blockNumber, blockHash: other });
    await expect(b.at("latest", { atLeast: { blockNumber: -1n } })).rejects.toBeInstanceOf(
      EfsFault,
    );
    await expect(
      b.at("latest", { atLeast: { blockNumber: 1n, blockHash: "0x12" as Hex } }),
    ).rejects.toMatchObject({ code: "MISUSE" });
  });
});

describe("a rewound dev chain (chain B, this file's own)", () => {
  it("a sibling at the floor's height is served and becomes the floor; a shorter chain is BEHIND until resetReadFloor", async () => {
    const url = chainB.rpcUrl;
    const e = endpoints(url);
    const efs = client(chainB.deployment, e, [e.FRESH], 0);
    const snap = await rpc(url, "evm_snapshot");
    await rpc(url, "anvil_mine", ["0x3"]);
    const top = await efs.at();
    if (top.status !== "VERIFIED") throw new Error(top.status);
    // Rewind and mine back to the same height with a later timestamp: a different block there. (anvil consumes a
    // snapshot on revert, so take another at the rewound head for the second rewind.)
    await rpc(url, "evm_revert", [snap]);
    const again = await rpc(url, "evm_snapshot");
    await rpc(url, "anvil_mine", ["0x2"]);
    const ts = (await rpc(url, "eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex };
    await rpc(url, "evm_setNextBlockTimestamp", [
      `0x${(BigInt(ts.timestamp) + 1000n).toString(16)}`,
    ]);
    await rpc(url, "anvil_mine", ["0x1"]);
    const sibling = await efs.at();
    if (sibling.status !== "VERIFIED") throw new Error(sibling.status);
    expect(sibling.basis.blockNumber).toBe(top.basis.blockNumber);
    expect(sibling.basis.blockHash).not.toBe(top.basis.blockHash);
    expect(efs.readFloor().latest?.blockHash).toBe(sibling.basis.blockHash);
    // Rewound below the floor: every read is BEHIND (lag and a reset look the same), until the app resets.
    await rpc(url, "evm_revert", [again]);
    const stuck = await efs.at();
    expect(stuck).toMatchObject({ status: "UNKNOWN", reason: { code: "BEHIND" } });
    efs.resetReadFloor();
    expect(efs.readFloor()).toEqual({});
    const fresh = await efs.at();
    if (fresh.status !== "VERIFIED") throw new Error(fresh.status);
    expect(fresh.basis.blockNumber < top.basis.blockNumber).toBe(true);
  });
});

describe("onCaughtUp (chain B): a BEHIND view hears once when a read catches up, and nothing is read for it", () => {
  it("BEHIND, subscribe, the endpoint catches up: the next read fires the listener once; no request of its own", async () => {
    const url = chainB.rpcUrl;
    const e = endpoints(url);
    let requests = 0;
    const counted: FetchLike = (u, init) => {
      requests++;
      return e.fetch(u, init);
    };
    const efs = createEfs({
      rpcs: [e.LAG],
      deployment: chainB.deployment,
      fetch: counted,
      reads: { behindWaitMs: 300 },
    });
    await rpc(url, "anvil_mine", ["0x2"]);
    const first = await efs.at();
    if (first.status !== "VERIFIED") throw new Error(first.status);
    // The only endpoint falls behind the floor: the read is UNKNOWN BEHIND.
    e.lag.by = 3;
    await rpc(url, "anvil_mine", ["0x1"]);
    expect(await efs.at()).toMatchObject({ status: "UNKNOWN", reason: { code: "BEHIND" } });
    const heard: unknown[] = [];
    efs.onCaughtUp((x) => heard.push(x));
    const before = requests;
    await new Promise((r) => setTimeout(r, 400));
    expect(heard).toEqual([]); // still behind, and the SDK read nothing for the listener
    expect(requests).toBe(before);
    // It catches up; the next read anywhere in this client serves at the floor and closes the episode.
    e.lag.by = 0;
    const caught = await efs.at();
    if (caught.status !== "VERIFIED") throw new Error(caught.status);
    expect(heard).toEqual([
      {
        policy: "latest",
        at: { blockNumber: caught.basis.blockNumber, blockHash: caught.basis.blockHash },
      },
    ]);
    // One-shot: a later read fires nothing more.
    await efs.at();
    expect(heard).toHaveLength(1);
  });
});

const shared: { journal?: Journal; visible?: { blockNumber: bigint; blockHash: Hex } } = {};
