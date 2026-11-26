// SPDX-License-Identifier: MIT
// An account that can't cover a save's gas limit, on the fixture (src/actions/send.ts insufficientFunds): the node's own
// refusal reaches the app as INSUFFICIENT_FUNDS, AMBIGUOUS with retry after-reconcile (never "checking whether the save
// went out", never NOT_SENT: the refusal comes after signing). A single send names the gas limit it asked for; a batch
// names none (the wallet sets each call's gas) and keeps its batch size. Every refusal here is anvil's own answer to a
// real transaction from an account holding 1 wei. Account 33 of anvil's public development mnemonic (used by no other
// test file); nothing here lands.
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs, type Efs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ACTION } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const local = mnemonicToAccount(MNEMONIC, { addressIndex: 33 });
const ME = local.address.toLowerCase() as Hex;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}

/** A wallet over the fixture node: it passes each transaction on and rethrows the node's error, as a wallet does. */
function wallet(o: { atomic?: boolean } = {}) {
  const w = {
    sent: [] as { gas?: string }[],
    batches: 0,
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
        if (method === "eth_sendTransaction") {
          w.sent.push((params as [{ gas?: string }])[0]);
          return rpc(method, params ?? []);
        }
        if (method === "wallet_getCapabilities") {
          if (!o.atomic) throw Object.assign(new Error("method not found"), { code: -32601 });
          const id = (params as [string, string[]])[1][0] as string;
          return { [id]: { atomic: { status: "supported" } } };
        }
        if (method === "wallet_sendCalls") {
          w.batches++;
          const req = (params as [{ from: string; calls: { to: string; data: string }[] }])[0];
          for (const c of req.calls)
            await rpc("eth_sendTransaction", [{ from: req.from, to: c.to, data: c.data }]);
          return { id: `batch-${w.batches}` };
        }
        return rpc(method, params ?? []);
      },
    },
  };
  return w;
}

let seed = 0;
function chunkPart(e: Efs) {
  const b = encode.chunk(new Uint8Array(40).fill(++seed));
  return {
    actions: [
      {
        kind: ACTION.PUBLISH,
        typeId: (e.deployment.typeIds as Record<string, Hex>)["files-bytes/1"] as Hex,
        bodyHashOrRecordId: keccak256(b),
        purpose: ZERO_WORD,
        subject: ZERO_WORD,
        role: ZERO_WORD,
        target: ZERO_WORD,
        expectedRevision: 0n,
        saltOrStrength: ZERO_WORD,
      },
    ],
    bodies: [`0x${Buffer.from(b).toString("hex")}` as Hex],
    effects: [{ code: "test.insufficient-funds", args: {} }],
  };
}

beforeAll(async () => {
  await rpc("anvil_setBalance", [ME, "0x1"]); // 1 wei: no gas limit is covered
  await rpc("anvil_impersonateAccount", [ME]);
});

describe("an account that can't cover the gas limit", () => {
  it("a wallet send: AMBIGUOUS INSUFFICIENT_FUNDS naming the gas limit asked for; the attempt stays in flight", async () => {
    const w = wallet();
    const journal = memoryJournal();
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: w.provider, account: ME },
      journal,
    });
    const planned = await writer.planActions(chunkPart(efs));
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const sent = await writer.send(planned.plan);
    const asked = BigInt(w.sent[0]?.gas ?? "0x0");
    expect(asked).toBeGreaterThan(0n);
    expect(sent).toEqual({
      kind: "efs.send",
      status: "AMBIGUOUS",
      planId: planned.plan.id,
      reason: {
        code: "INSUFFICIENT_FUNDS",
        retry: "after-reconcile",
        detail: `the wallet needs enough to cover the gas limit of ${asked}; a save is charged only the gas it uses`,
        funds: { gasLimit: asked },
      },
    });
    expect((await journal.get(planned.plan.id))?.stage).toBe("SUBMISSION_POSSIBLE");
    expect(await rpc("eth_getTransactionCount", [ME, "latest"])).toBe("0x0"); // nothing landed
  });

  it("a local account: the node's refusal of the signed transaction is the same reason, with its gas limit", async () => {
    const journal = memoryJournal();
    const writer = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: local },
      journal,
    });
    const planned = await writer.planActions(chunkPart(efs));
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const sent = await writer.send(planned.plan);
    expect(sent).toMatchObject({
      status: "AMBIGUOUS",
      reason: { code: "INSUFFICIENT_FUNDS", retry: "after-reconcile" },
    });
    const limit = sent.status === "AMBIGUOUS" ? sent.reason.funds?.gasLimit : undefined;
    expect(limit).toBeGreaterThan(0n);
    expect(sent.status === "AMBIGUOUS" && sent.reason.detail).toContain(`gas limit of ${limit}`);
    expect((await journal.get(planned.plan.id))?.stage).toBe("SUBMISSION_POSSIBLE");
  });

  it("a save stops on it after one prompt; an atomic batch names no limit and keeps its batch size", async () => {
    const single = wallet();
    const one = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: single.provider, account: ME },
      journal: memoryJournal(),
    });
    const stopped = await one.runSequence([chunkPart(efs)], { settleMs: 500 });
    expect(stopped.state).toBe("IN_FLIGHT"); // in flight until reconcile proves it never went out
    expect(stopped.reason).toMatchObject({ code: "INSUFFICIENT_FUNDS", retry: "after-reconcile" });
    expect(single.sent).toHaveLength(1); // never sent again on its own

    const batching = wallet({ atomic: true });
    const journal = memoryJournal();
    const many = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: batching.provider, account: ME },
      journal,
    });
    const save = await many.runSequence([chunkPart(efs), chunkPart(efs)], { settleMs: 500 });
    expect(batching.batches).toBe(1);
    expect(save.reason).toEqual({
      code: "INSUFFICIENT_FUNDS",
      retry: "after-reconcile",
      detail:
        "the wallet needs enough to cover this transaction's gas limit; a save is charged only the gas it uses",
    });
    // A lost response halves the batch; a funds refusal is not about size, so the batch size is kept.
    expect((await journal.getSequence(save.sequenceId))?.batchMax).toBeUndefined();
  });
});
