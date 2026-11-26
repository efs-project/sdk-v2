// SPDX-License-Identifier: MIT
// The gas limit a send asks for, end to end on the fixture: a plan carries the planner's figures (plannedGas, not
// part of its id), and the send sets the limit by the deployment's fee profile. On the fixture's own schedule
// (prague) it is 25% over the node's estimate, at most 2^24, whatever the plan carries. The same deployment named
// amsterdam (EIP-8037's reservoir; no chain runs it yet, so only the document changes) gets a limit over 2^24 whose
// reservoir holds the plan's state gas. Nothing is sent: the wallet records the limit it was asked for and refuses
// (4001), and a local account records it while signing and stops there. One account of anvil's public development
// mnemonic (index 29, used by no other test file).
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { reservoirProfile } from "../../src/actions/gaslimit.ts";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { LocalAccountLike } from "../../src/actions/send.ts";
import type { Plan } from "../../src/actions/types.ts";
import { createEfs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ACTION } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk";
const account = mnemonicToAccount(MNEMONIC, { addressIndex: 29 });
const CAP = 16_777_216n;

const prague = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const amsterdam = createEfs({
  rpcs: [fixture.rpcUrl],
  deployment: {
    ...deployment,
    chain: { ...deployment.chain, hardfork: "amsterdam", feeSchedule: "amsterdam" },
  },
});

const rpc = async (method: string, params: unknown[]) => {
  const res = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

/** A wallet that records the gas limit it is asked for and refuses (4001): nothing is signed or sent. */
function refusingWallet() {
  const asked: (bigint | undefined)[] = [];
  return {
    asked,
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts") return [account.address];
        if (method === "eth_sendTransaction") {
          const gas = (params?.[0] as { gas?: Hex } | undefined)?.gas;
          asked.push(gas === undefined ? undefined : BigInt(gas));
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        }
        return rpc(method, params ?? []);
      },
    },
  };
}

/** One small publication (a fresh 64-byte chunk), with the planner's figures or without them. */
function part(efs: typeof prague, seed: number, figures?: { gas: number; total?: number }) {
  const b = encode.chunk(new Uint8Array(64).fill(seed));
  const body = `0x${Buffer.from(b).toString("hex")}` as Hex;
  return {
    actions: [
      {
        kind: ACTION.PUBLISH,
        typeId: (efs.deployment.typeIds as Record<string, Hex>)["files-bytes/1"] as Hex,
        bodyHashOrRecordId: keccak256(b),
        purpose: ZERO_WORD,
        subject: ZERO_WORD,
        role: ZERO_WORD,
        target: ZERO_WORD,
        expectedRevision: 0n,
        saltOrStrength: ZERO_WORD,
      },
    ],
    bodies: [body],
    effects: [{ code: "test.gas-limit", args: {} }],
    ...(figures ?? {}),
  };
}

async function planOne(efs: typeof prague, input: ReturnType<typeof part>): Promise<Plan> {
  const w = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: refusingWallet().provider },
    journal: memoryJournal(),
  });
  const r = await w.planSequence([input]);
  if (r.status !== "PLANNED") throw new Error(r.status);
  return r.plans[0] as Plan;
}

/** Send through a refusing wallet: the limit the wallet was asked for. */
async function askedLimit(efs: typeof prague, plan: Plan): Promise<bigint | undefined> {
  const wallet = refusingWallet();
  const w = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: wallet.provider },
    journal: memoryJournal(),
  });
  const r = await w.send(plan);
  expect(r).toMatchObject({ status: "NOT_SENT" });
  expect(wallet.asked).toHaveLength(1);
  return wallet.asked[0];
}

// A small publication given a large-state save's figures (6M execution + 11M state: its whole over 2^24, and 2^24 +
// 1.15 × state under the fixture's 30M block), on a call cheap to estimate. HUGE_STATE's 20M can't ride above 2^24
// inside a 30M block: its limit is the block's.
const LARGE_STATE = { gas: 6_000_000, total: 17_000_000 };
const HUGE_STATE = { gas: 400_000, total: 20_400_000 };
const BLOCK = 30_000_000n;

describe("the plan carries the planner's figures", () => {
  it("both figures make plannedGas; one alone makes nothing; neither changes the plan's id", async () => {
    const both = await planOne(prague, part(prague, 1, HUGE_STATE));
    const gasOnly = await planOne(prague, part(prague, 1, { gas: HUGE_STATE.gas }));
    const none = await planOne(prague, part(prague, 1));
    expect(both.plannedGas).toEqual({ execution: 400_000, total: 20_400_000 });
    expect(gasOnly.plannedGas).toBeUndefined();
    expect(none.plannedGas).toBeUndefined();
    // Planned at the same basis: the same publication, the same id, with or without figures.
    if (both.basis.blockHash === none.basis.blockHash) expect(both.id).toBe(none.id);
  });
});

describe("the limit by fee profile, through the real send path", () => {
  it("the fixture (prague): 25% over the node's estimate, whatever the plan carries", async () => {
    const plan = await planOne(prague, part(prague, 2, LARGE_STATE));
    const estimate = BigInt(
      (await rpc("eth_estimateGas", [
        { from: plan.account, to: plan.ledger, data: plan.calldata },
      ])) as Hex,
    );
    expect(estimate).toBeLessThan(CAP);
    expect(await askedLimit(prague, plan)).toBe((estimate * 5n) / 4n);
  });

  it("named amsterdam: over 2^24, the reservoir holding the plan's state gas with its margin", async () => {
    expect(reservoirProfile(amsterdam.deployment)).toBe(true);
    expect(reservoirProfile(prague.deployment)).toBe(false);
    expect(BigInt(amsterdam.deployment.chain?.blockGasLimit ?? 0n)).toBe(BLOCK);
    const plan = await planOne(amsterdam, part(amsterdam, 3, LARGE_STATE));
    expect(plan.plannedGas).toEqual({ execution: 6_000_000, total: 17_000_000 });
    const gas = await askedLimit(amsterdam, plan);
    if (gas === undefined) throw new Error("no limit asked");
    expect(gas).toBeGreaterThan(CAP);
    expect(gas - CAP).toBeGreaterThanOrEqual((11_000_000n * 115n) / 100n);
    expect(gas).toBeLessThanOrEqual(BLOCK);
  });

  it("named amsterdam, a state gas the reservoir can't hold inside the block: the block's gas limit", async () => {
    const plan = await planOne(amsterdam, part(amsterdam, 6, HUGE_STATE));
    expect(await askedLimit(amsterdam, plan)).toBe(BLOCK);
  });

  it("named amsterdam with no figures: the estimate's 25%, as on prague (no state gas to hold)", async () => {
    const plan = await planOne(amsterdam, part(amsterdam, 4));
    const estimate = BigInt(
      (await rpc("eth_estimateGas", [
        { from: plan.account, to: plan.ledger, data: plan.calldata },
      ])) as Hex,
    );
    expect(await askedLimit(amsterdam, plan)).toBe((estimate * 5n) / 4n);
  });

  it("a local account signs with the same limit", async () => {
    const plan = await planOne(amsterdam, part(amsterdam, 5, LARGE_STATE));
    const signed: bigint[] = [];
    const local: LocalAccountLike = {
      address: account.address,
      async signTransaction(tx) {
        signed.push(tx.gas);
        throw new Error("recorded, not signed");
      },
    };
    const w = await createWriter(amsterdam, {
      authorizer: { kind: "local", profile: "direct", account: local },
      journal: memoryJournal(),
    });
    await expect(w.send(plan)).rejects.toThrow("recorded, not signed");
    expect(signed).toHaveLength(1);
    expect((signed[0] as bigint) - CAP).toBeGreaterThanOrEqual((11_000_000n * 115n) / 100n);
  });
});
