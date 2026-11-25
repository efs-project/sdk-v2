// SPDX-License-Identifier: MIT
// Resumable split saves on a real chain: COMPLETE is the only success, PARTIAL resumes after a reload, settling
// never needs the wallet, and an atomic EIP-5792 wallet takes every part under one approval.
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { Eip1193Like } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex } from "../../src/core/hex.ts";
import { putInline } from "./recipes.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex } };
};
const docs = deployment.seed.folder.directoryRecordId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const dave = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
); // anvil #3 (no other test file uses it)
const ERIN = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Hex; // anvil #4 (unlocked on the fixture)
const FRANK = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Hex; // anvil #5 (unlocked)

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

/** A wallet over anvil's unlocked account. Knobs: refuse the n-th send, lose a response, speak EIP-5792. */
function wallet(
  account: Hex,
  k: {
    refuseSend?: number;
    loseFirst?: boolean;
    atomic5792?: boolean;
    refuseBatch?: boolean;
    dead?: boolean;
  } = {},
) {
  const w = {
    sends: 0,
    batches: 0,
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      if (k.dead) throw new Error("wallet must not be used");
      if (method === "eth_accounts") return [account];
      if (method === "eth_sendTransaction") {
        w.sends++;
        if (k.refuseSend === w.sends)
          throw Object.assign(new Error("User rejected"), { code: 4001 });
        const hash = await rpc(method, params as unknown[]);
        if (k.loseFirst && w.sends === 1) throw new Error("connection lost");
        return hash;
      }
      if (method === "wallet_getCapabilities") {
        if (!k.atomic5792) throw Object.assign(new Error("method not found"), { code: -32601 });
        const id = (params as [string, string[]])[1][0] as string;
        return { [id]: { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") {
        w.batches++;
        if (k.refuseBatch) throw Object.assign(new Error("User rejected"), { code: 4001 });
        const req = (params as [{ from: string; calls: { to: string; data: string }[] }])[0];
        // A real wallet sequences its own transaction nonces; on anvil, wait for each call to be mined before the
        // next, or back-to-back sends share one pending nonce and only one of them is ever mined.
        for (const c of req.calls) {
          const hash = await rpc("eth_sendTransaction", [
            { from: req.from, to: c.to, data: c.data },
          ]);
          for (let t = 0; t < 100 && !(await rpc("eth_getTransactionReceipt", [hash])); t++)
            await new Promise((r) => setTimeout(r, 20));
        }
        return { id: `batch-${w.batches}` };
      }
      if (method === "wallet_getCallsStatus") return { status: 200 };
      return rpc(method, (params as unknown[]) ?? []);
    },
  };
  return w as Eip1193Like & { sends: number; batches: number };
}

const parts = (principal: Hex, tag: string, n = 3) =>
  Array.from({ length: n }, (_, i) =>
    putInline(
      efs,
      principal,
      docs,
      `${tag}-${i}.txt`,
      new TextEncoder().encode(`${tag} ${i}`),
      keccak256(toHex(`${tag}-${i}`)),
    ),
  );

describe("runSequence (fixture)", () => {
  it("a local account carries a 3-part save to COMPLETE, part by part", async () => {
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: dave },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-local"));
    expect(r).toMatchObject({ state: "COMPLETE", total: 3, committed: 3, mode: "sequential" });
    expect(r.current).toBeUndefined();
    // COMPLETE but not yet final: still listed ("Saved · confirming") until a finalized block confirms it. Other test
    // files mine blocks on this shared chain, so the save may already be final, and then it is no longer listed.
    expect((await w.pendingSequences()).map((x) => [x.state, x.final])).toEqual(
      r.final ? [] : [["COMPLETE", false]],
    );
  });

  it("a refusal at part 2 is PARTIAL (1 of 3); a reload resumes it to COMPLETE with fresh nonces", async () => {
    const journal = memoryJournal();
    const refusing = wallet(ERIN, { refuseSend: 2 });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: refusing },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-partial"));
    expect(r).toMatchObject({
      state: "PARTIAL",
      total: 3,
      committed: 1,
      reason: { code: "USER_REJECTED" },
    });
    expect(r.current).toMatchObject({ index: 1, stage: "NOT_PLANNED" }); // the refused part is planned again later
    // "Reload": a new writer over the same journal sees "1 of 3 saved — Continue".
    const good = wallet(ERIN);
    const again = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: good },
      journal,
    });
    const [open] = await again.pendingSequences();
    expect(open).toMatchObject({
      sequenceId: r.sequenceId,
      state: "PARTIAL",
      committed: 1,
      total: 3,
    });
    const done = await again.resume(r.sequenceId);
    expect(done).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(good.sends).toBe(2);
    expect((await again.pendingSequences()).map((x) => [x.state, x.final])).toEqual(
      done.final ? [] : [["COMPLETE", false]],
    );
  });

  it("a lost response is settled from the ledger and never sent twice", async () => {
    const lossy = wallet(FRANK, { loseFirst: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: lossy },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-lossy"), { pollMs: 50 });
    expect(r).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(lossy.sends).toBe(3);
  });

  it("settling and listing never touch the wallet", async () => {
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(ERIN, { refuseSend: 1 }) },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-quiet", 2));
    expect(r.state).toBe("NOT_STARTED");
    const dead = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(ERIN, { dead: true }),
        account: ERIN,
      },
      journal,
    });
    expect((await dead.reconcileSequence(r.sequenceId)).state).toBe("NOT_STARTED");
    expect((await dead.pendingSequences()).length).toBe(1);
    const gone = await dead.abandon(r.sequenceId);
    expect(gone.state).toBe("ABANDONED");
    expect(await dead.pendingSequences()).toEqual([]);
    expect((await dead.resume(r.sequenceId)).state).toBe("ABANDONED");
  });

  it("an atomic EIP-5792 wallet takes every part under one approval", async () => {
    const batching = wallet(ERIN, { atomic5792: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: batching },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-batch"), { pollMs: 50 });
    expect(r).toMatchObject({ state: "COMPLETE", committed: 3, mode: "batch" });
    expect([batching.batches, batching.sends]).toEqual([1, 0]); // one approval, no per-part prompts
  });

  it("a refused batch sends nothing; the same save can then go part by part", async () => {
    const journal = memoryJournal();
    const refusing = wallet(FRANK, { atomic5792: true, refuseBatch: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: refusing },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-batch-no"));
    expect(r).toMatchObject({
      state: "NOT_STARTED",
      committed: 0,
      mode: "batch",
      reason: { code: "USER_REJECTED" },
    });
    const plain = wallet(FRANK);
    const w2 = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: plain },
      journal,
    });
    expect(await w2.resume(r.sequenceId, { batch: "never" })).toMatchObject({
      state: "COMPLETE",
      mode: "sequential",
    });
  });
});
