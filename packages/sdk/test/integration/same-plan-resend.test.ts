// SPDX-License-Identifier: MIT
// Sending the same plan again after a funds refusal (src/actions/send.ts fundsResendable, resendWindow; resume in
// src/actions/sequence.ts), on the fixture. A save refused for insufficient funds stops IN_FLIGHT; once the account is
// topped up, resume (the person's click) sends the SAME plan (same ledger nonce and digest) through the lock, twin guard
// and estimate, and it commits exactly once. A lost response is never sent again, nor a plan too close to its deadline.
// If the wallet had queued the original and it landed, the resend's estimate fails, nothing is sent, and the attempt
// ends COMMITTED. Account 35 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { createWriter, lockKey, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ACTION } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const local = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 35,
});
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
const broke = () => rpc("anvil_setBalance", [ME, "0x1"]); // 1 wei: no gas limit is covered
const topUp = () => rpc("anvil_setBalance", [ME, "0x56bc75e2d63100000"]);
const nonce = async () =>
  Number(BigInt((await rpc("eth_getTransactionCount", [ME, "latest"])) as Hex));
/** Wait until a transaction is mined and succeeded (the fixture mines on its own clock). */
async function mined(hash: unknown): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string } | null;
    if (r) {
      expect(r.status).toBe("0x1");
      return;
    }
    await new Promise((ok) => setTimeout(ok, 50));
  }
  throw new Error("the transaction was not mined");
}
/** Broadcast the transaction a wallet queued, and wait until it is mined. */
async function landQueued(q: unknown): Promise<void> {
  const { from, to, data } = q as { from: string; to: string; data: string };
  await mined(await rpc("eth_sendTransaction", [{ from, to, data }]));
}

/**
 * A wallet over the fixture node that rethrows the node's own error. `queue`: on a refusal it keeps the transaction,
 * as a wallet that queues a signed transaction until funds arrive would; the test broadcasts it later.
 */
function wallet(o: { loseResponse?: boolean; atomic?: boolean } = {}) {
  const w = {
    prompts: 0,
    batches: 0,
    queued: [] as unknown[],
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
        if (method === "eth_sendTransaction") {
          w.prompts++;
          if (o.loseResponse) throw new Error("the wallet's connection dropped"); // nothing was sent
          try {
            return await rpc(method, params ?? []);
          } catch (e) {
            w.queued.push((params as unknown[])[0]);
            throw e;
          }
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
const writerFor = async (w: ReturnType<typeof wallet>, journal = memoryJournal()) => ({
  journal,
  writer: await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: w.provider, account: ME },
    journal,
  }),
});

let seed = 0;
function chunkPart(deadlineSeconds?: number) {
  const b = encode.chunk(new Uint8Array(40).fill(++seed));
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
    bodies: [`0x${Buffer.from(b).toString("hex")}` as Hex],
    effects: [{ code: "test.same-plan-resend", args: {} }],
    ...(deadlineSeconds !== undefined ? { deadlineSeconds } : {}),
  };
}

beforeEach(async () => {
  await rpc("anvil_impersonateAccount", [ME]);
  await broke();
});

describe("the same plan, sent again after a funds refusal (fixture)", () => {
  it("a save refused for funds, then topped up: resume sends the same plan, and it commits exactly once", async () => {
    const w = wallet();
    const { writer, journal } = await writerFor(w);
    const before = await nonce();
    const stopped = await writer.runSequence([chunkPart()], { settleMs: 500 });
    expect(stopped).toMatchObject({ state: "IN_FLIGHT", reason: { code: "INSUFFICIENT_FUNDS" } });
    const planId = (await journal.getSequence(stopped.sequenceId))?.parts[0]?.planId as Hex;
    expect(w.prompts).toBe(1);
    await topUp();
    const done = await writer.resume(stopped.sequenceId, { settleMs: 10_000 });
    expect(done.state).toBe("COMPLETE");
    expect(w.prompts).toBe(2); // the refused send and the one resend
    expect(await nonce()).toBe(before + 1); // one transaction landed
    const rec = await journal.getSequence(stopped.sequenceId);
    expect(rec?.parts[0]?.planId).toBe(planId); // the same plan, not a new one
    expect((await journal.get(planId))?.stage).toBe("COMMITTED");
    const open = await journal.unresolved(lockKey((await journal.get(planId))?.plan as never));
    expect(open.filter((r) => r.stage === "SUBMISSION_POSSIBLE")).toEqual([]);
  }, 120_000);

  it("an atomic batch refused for funds: resume sends each part's same plan, part by part, and every part commits", async () => {
    const w = wallet({ atomic: true });
    const { writer, journal } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart(), chunkPart()], { settleMs: 500 });
    expect(stopped).toMatchObject({ state: "IN_FLIGHT", reason: { code: "INSUFFICIENT_FUNDS" } });
    expect([w.batches, w.prompts]).toEqual([1, 0]);
    const planIds = (await journal.getSequence(stopped.sequenceId))?.parts.map((p) => p.planId);
    await topUp();
    const done = await writer.resume(stopped.sequenceId, { settleMs: 10_000 });
    expect(done.state).toBe("COMPLETE");
    expect([w.batches, w.prompts]).toEqual([1, 2]); // no second batch: each part once, as the same plan
    expect((await journal.getSequence(stopped.sequenceId))?.parts.map((p) => p.planId)).toEqual(
      planIds,
    );
  }, 120_000);

  it("a lost response is never sent again: resume waits for reconcile and asks nothing", async () => {
    await topUp();
    const w = wallet({ loseResponse: true });
    const { writer } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart()], { settleMs: 500 });
    expect(stopped).toMatchObject({ state: "IN_FLIGHT", reason: { code: "RESPONSE_LOST" } });
    const again = await writer.resume(stopped.sequenceId, { settleMs: 500 });
    expect(again.state).toBe("IN_FLIGHT");
    expect(w.prompts).toBe(1);
  }, 120_000);

  it("a plan too close to its deadline is not sent again (under a minute left)", async () => {
    const w = wallet();
    const { writer } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart(30)], { settleMs: 500 });
    expect(stopped).toMatchObject({ state: "IN_FLIGHT", reason: { code: "INSUFFICIENT_FUNDS" } });
    await topUp();
    const again = await writer.resume(stopped.sequenceId, { settleMs: 500 });
    expect(again).toMatchObject({ state: "IN_FLIGHT", reason: { code: "ALREADY_ATTEMPTED" } });
    expect(again.reason?.detail).toMatch(/under 60 s left before its deadline/);
    expect(w.prompts).toBe(1);
  }, 120_000);

  it("near the deadline, Send again returns at once: nothing was sent, so there is no settle window to wait", async () => {
    const w = wallet();
    const { writer } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart(30)], { settleMs: 500 });
    expect(stopped.reason?.code).toBe("INSUFFICIENT_FUNDS");
    await topUp();
    const started = Date.now();
    const again = await writer.resume(stopped.sequenceId); // the default settle window, 60 s
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(again).toMatchObject({ state: "IN_FLIGHT", reason: { code: "ALREADY_ATTEMPTED" } });
    expect(w.prompts).toBe(1); // the wallet was never asked again
  }, 120_000);

  it("the wallet queued the original and it landed: the resend's estimate refuses, nothing is sent, COMMITTED", async () => {
    const w = wallet();
    const { writer, journal } = await writerFor(w);
    const planned = await writer.planActions(chunkPart());
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    expect(await writer.send(planned.plan)).toMatchObject({
      status: "AMBIGUOUS",
      reason: { code: "INSUFFICIENT_FUNDS" },
    });
    await topUp();
    // The queued original goes out and lands: the same plan, the same ledger nonce.
    await landQueued(w.queued[0]);
    const resent = await writer.send(planned.plan);
    expect(resent).toMatchObject({ status: "STALE", revert: { error: "AlreadyAdmitted" } }); // the nonce is used
    expect(w.prompts).toBe(1); // the wallet was never asked again
    expect((await writer.reconcile(planned.plan.id)).outcome).toBe("COMMITTED");
    expect((await journal.get(planned.plan.id))?.stage).toBe("COMMITTED");
  }, 120_000);

  it("a local account: the node refused the signed transaction for funds; the same plan, signed again, commits once", async () => {
    const journal = memoryJournal();
    const writer = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: local },
      journal,
    });
    const before = await nonce();
    const planned = await writer.planActions(chunkPart());
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const refused = await writer.send(planned.plan);
    expect(refused).toMatchObject({ status: "AMBIGUOUS", reason: { code: "INSUFFICIENT_FUNDS" } });
    const firstHash = (await journal.get(planned.plan.id))?.txHash;
    await topUp();
    const resent = await writer.send(planned.plan);
    expect(resent.status).toBe("SUBMITTED");
    // Signed again: the same transaction when the account nonce and fees haven't moved (the refused one never landed)
    expect(resent.status === "SUBMITTED" && typeof resent.txHash).toBe("string");
    void firstHash;
    if (resent.status === "SUBMITTED") await mined(resent.txHash);
    expect((await writer.reconcile(planned.plan.id)).outcome).toBe("COMMITTED");
    expect(await nonce()).toBe(before + 1);
  }, 120_000);

  it("a local account whose raw send failed over (a transport error at A, then funds at B): never resent", async () => {
    // A may have broadcast the signed transaction before its response was lost, so B's funds answer proves nothing.
    const A = "http://endpoint-a.test/";
    let aRaw = 0;
    const failingA = async (url: string, init: { body?: unknown }) => {
      const body = JSON.parse(String(init.body));
      const reqs = Array.isArray(body) ? body : [body];
      if (
        url === A &&
        reqs.some((r: { method: string }) => r.method === "eth_sendRawTransaction")
      ) {
        aRaw++;
        throw new TypeError("fetch failed (the connection dropped)");
      }
      return fetch(url === A ? fixture.rpcUrl : url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: String(init.body),
      });
    };
    const twoEndpoints = createEfs({
      rpcs: [A, fixture.rpcUrl],
      deployment,
      fetch: failingA as never,
    });
    const journal = memoryJournal();
    const writer = await createWriter(twoEndpoints, {
      authorizer: { kind: "local", profile: "direct", account: local },
      journal,
    });
    const planned = await writer.planActions(chunkPart());
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const sent = await writer.send(planned.plan);
    expect(aRaw).toBe(1); // A was tried first, and failed in transport
    expect(sent).toMatchObject({ status: "AMBIGUOUS", reason: { code: "RESPONSE_LOST" } });
    const rec = await journal.get(planned.plan.id);
    expect(rec?.history.some((h) => h.refusal)).toBe(false);
    await topUp();
    expect(await writer.send(planned.plan)).toMatchObject({
      status: "AMBIGUOUS",
      reason: { code: "ALREADY_ATTEMPTED" },
    }); // waits for reconcile: never sent again
  }, 120_000);

  it("the same after a save: resume finds the queued original committed and sends nothing", async () => {
    const w = wallet();
    const { writer } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart()], { settleMs: 500 });
    expect(stopped.reason?.code).toBe("INSUFFICIENT_FUNDS");
    await topUp();
    await landQueued(w.queued[0]);
    const done = await writer.resume(stopped.sequenceId, { settleMs: 10_000 });
    expect(done.state).toBe("COMPLETE");
    expect(w.prompts).toBe(1);
  }, 120_000);
});
