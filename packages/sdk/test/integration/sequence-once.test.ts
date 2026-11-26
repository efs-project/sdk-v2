// SPDX-License-Identifier: MIT
// A save is planned and sent once (the client's WebKit case, 2026-11-26): a single-part tag save whose receipt only
// arrives after settleMs is IN_FLIGHT, and neither reconcileSequence nor resume plans or sends it again; once it lands
// it is COMPLETE. A second save of the same parts never reaches the wallet: while the first is open (on its way, or
// committed and not yet final) the journal names it (ALREADY_ATTEMPTED with the earlier attempt, nothing sent), and
// once it is final the ledger refuses the plan in simulation (E_CAS, STALE). A PUBLISH-only part, which the ledger
// repeats without a revert, is held back the same way. The wallet signs locally and holds the transaction, so the test decides when it lands. Two accounts
// of anvil's public development mnemonic (indexes 27 and 28, used by no other test file).
import { readFileSync } from "node:fs";
import { getAbiItem, keccak256, type TransactionSerializable, toFunctionSelector } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex } from "../../src/core/hex.ts";
import { ingressAbi } from "../../src/generated/abis.ts";
import { planTag, textRecordAction, topicTypesOf } from "../../src/tags/index.ts";
import { recordingFetch } from "../../src/testing/index.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk";
/** planPublication's one ingress read (acceptanceProfileOf): one per plan. */
const PLAN_CALL = toFunctionSelector(
  getAbiItem({ abi: ingressAbi, name: "acceptanceProfileOf" }) as never,
);

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

/**
 * A wallet that signs each eth_sendTransaction with the account's key and holds it: the hash comes back at once, and
 * the transaction reaches the chain only when the test calls `land()`.
 */
function holdingWallet(index: number) {
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: index });
  const held: Hex[] = [];
  const sends: unknown[] = [];
  let nonce: number | undefined;
  return {
    account,
    sends,
    /** Broadcast what is held, and mine it. */
    async land() {
      for (const raw of held.splice(0)) await rpc("eth_sendRawTransaction", [raw]);
      await rpc("evm_mine", []);
    },
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
        if (method === "eth_chainId") return rpc(method, []);
        if (method !== "eth_sendTransaction") return rpc(method, params ?? []);
        sends.push(params?.[0]);
        const tx = params?.[0] as { to: Hex; data: Hex; gas?: Hex };
        nonce ??= Number(await rpc("eth_getTransactionCount", [account.address, "pending"]));
        const fee = BigInt((await rpc("eth_gasPrice", [])) as string);
        const signed = await account.signTransaction({
          type: "eip1559",
          chainId: 31337,
          nonce: nonce++,
          to: tx.to,
          data: tx.data,
          gas: tx.gas ? BigInt(tx.gas) : 3_000_000n,
          maxFeePerGas: fee * 4n + 10_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        } satisfies TransactionSerializable);
        held.push(signed);
        return keccak256(signed);
      },
    },
  };
}

const plansIn = (calls: readonly { request: unknown }[]) =>
  calls
    .flatMap((c) => (Array.isArray(c.request) ? c.request : [c.request]))
    .filter(
      (r: { method?: string; params?: [{ data?: string }] }) =>
        r.method === "eth_call" && String(r.params?.[0]?.data ?? "").startsWith(PLAN_CALL),
    ).length;

beforeAll(async () => {
  for (const i of [27, 28])
    await rpc("anvil_setBalance", [
      mnemonicToAccount(MNEMONIC, { addressIndex: i }).address,
      "0x56bc75e2d63100000",
    ]);
});

describe("a save is planned and sent once (fixture)", () => {
  it("a receipt after settleMs: IN_FLIGHT, and neither reconcileSequence nor resume plans or sends again", async () => {
    const rec = recordingFetch(fetch as never);
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: rec.fetch });
    const w = holdingWallet(27);
    const writer = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: w.provider,
        account: w.account.address,
      },
      journal: memoryJournal(),
    });
    const p = await planTag(efs, writer, {
      topic: ["once-a", "todo"],
      targets: [{ kind: "address", address: "0x00000000000000000000000000000000000000c1" }],
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(p.parts.length).toBe(1);
    const fast = { settleMs: 300, pollMs: 50 };
    const first = await writer.runSequence(p.parts, fast);
    expect(first.state).toBe("IN_FLIGHT");
    expect([plansIn(rec.calls), w.sends.length]).toEqual([1, 1]);
    // Still in flight: settling reads the ledger only, and resume never sends an in-flight part again.
    expect((await writer.reconcileSequence(first.sequenceId, fast)).state).toBe("IN_FLIGHT");
    expect((await writer.resume(first.sequenceId, fast)).state).toBe("IN_FLIGHT");
    expect([plansIn(rec.calls), w.sends.length]).toEqual([1, 1]);
    // It lands: settled from the ledger, and resume has nothing left to send.
    await w.land();
    expect((await writer.reconcileSequence(first.sequenceId, fast)).state).toBe("COMPLETE");
    expect((await writer.resume(first.sequenceId, fast)).state).toBe("COMPLETE");
    expect([plansIn(rec.calls), w.sends.length]).toEqual([1, 1]);
  });

  it("a second save of the same parts never reaches the wallet: held back while the first is open, then refused by the ledger", async () => {
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const w = holdingWallet(28);
    const writer = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: w.provider,
        account: w.account.address,
      },
      journal: memoryJournal(),
    });
    const p = await planTag(efs, writer, {
      topic: ["once-b", "todo"],
      targets: [{ kind: "address", address: "0x00000000000000000000000000000000000000c2" }],
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    const fast = { settleMs: 300, pollMs: 50 };
    const first = await writer.runSequence(p.parts, fast);
    expect(first.state).toBe("IN_FLIGHT");
    // The same parts again while the first is in flight (a double submit), a block later: a new plan (its deadline
    // moved with the block), and still nothing goes to the wallet. The earlier attempt comes back structured.
    await rpc("evm_increaseTime", [5]); // a later block timestamp, so the new plan's deadline (and id) moves
    await rpc("evm_mine", []);
    const twice = await writer.runSequence(p.parts, fast);
    expect(w.sends.length).toBe(1);
    expect(twice.state).toBe("NOT_STARTED");
    expect(twice.reason).toMatchObject({
      code: "ALREADY_ATTEMPTED",
      retry: "after-reconcile",
      twin: { stage: "SUBMITTED", sequenceId: first.sequenceId },
    });
    expect(twice.reason?.twin?.planId).toMatch(/^0x[0-9a-f]{64}$/);
    // The first lands: COMMITTED, not yet final. A repeat is still held back (the journal still has it open).
    await w.land();
    const landed = await writer.reconcileSequence(first.sequenceId, fast);
    expect([landed.state, landed.final]).toEqual(["COMPLETE", false]);
    const again = await writer.runSequence(p.parts, fast);
    expect(w.sends.length).toBe(1);
    expect(again.reason).toMatchObject({
      code: "ALREADY_ATTEMPTED",
      twin: { stage: "COMMITTED", sequenceId: first.sequenceId },
    });
    // Final (a finalized block covers it): the journal lets go, and the ledger refuses the repeat in simulation.
    await rpc("anvil_mine", ["0x80"]);
    expect((await writer.reconcileSequence(first.sequenceId, fast)).final).toBe(true);
    const after = await writer.runSequence(p.parts, fast);
    expect(w.sends.length).toBe(1);
    expect(after.state).toBe("NOT_STARTED");
    expect(after.reason).toMatchObject({ code: "STALE", revert: { error: "E_CAS" } });
  });

  it("a PUBLISH-only part (the ledger repeats it without a revert) is held back while its first attempt is not final", async () => {
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const w = holdingWallet(28);
    const writer = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: w.provider,
        account: w.account.address,
      },
      journal: memoryJournal(),
    });
    const { action, body } = textRecordAction(
      topicTypesOf(efs.deployment),
      "sent once, for the record",
    );
    const part = { actions: [action], bodies: [body], effects: [] };
    const fast = { settleMs: 300, pollMs: 50 };
    const first = await writer.runSequence([part], fast);
    expect(first.state).toBe("IN_FLIGHT");
    await w.land();
    const landed = await writer.reconcileSequence(first.sequenceId, fast);
    expect([landed.state, landed.final]).toEqual(["COMPLETE", false]);
    await rpc("evm_increaseTime", [5]); // a later block timestamp, so the new plan's deadline (and id) moves
    await rpc("evm_mine", []);
    const repeat = await writer.runSequence([part], fast);
    expect(w.sends.length).toBe(1);
    expect(repeat.reason).toMatchObject({
      code: "ALREADY_ATTEMPTED",
      twin: { stage: "COMMITTED", sequenceId: first.sequenceId },
    });
  });

  it("another save goes out while one is in flight: only the same publication is held back", async () => {
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const w = holdingWallet(27);
    const writer = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: w.provider,
        account: w.account.address,
      },
      journal: memoryJournal(),
    });
    const fast = { settleMs: 300, pollMs: 50 };
    const plan = async (word: string) => {
      const p = await planTag(efs, writer, {
        topic: [word],
        targets: [{ kind: "address", address: "0x00000000000000000000000000000000000000c3" }],
      });
      if (p.status !== "PLANNED") throw new Error(p.status);
      return p.parts;
    };
    const one = await writer.runSequence(await plan("once-c"), fast);
    expect(one.state).toBe("IN_FLIGHT");
    const other = await writer.runSequence(await plan("once-d"), fast);
    expect(other.state).toBe("IN_FLIGHT");
    expect(w.sends.length).toBe(2);
  });
});
