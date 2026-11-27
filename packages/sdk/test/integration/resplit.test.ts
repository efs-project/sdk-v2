// SPDX-License-Identifier: MIT
// A save re-splits a part that turns out too large for one transaction (runSequence, src/actions/sequence.ts). The
// planner can't see list lengths, so a part planned full can need more execution gas than planned; then the estimate
// is over 2^24 and the send is NOT_SENT OVER_TX_GAS_CAP before anything is sent. Here a deep topic's registration and
// 30 first statements, planned in several parts, are merged into one part (units kept) that the chain prices over
// the cap. The save cuts it between its units and finishes, one wallet prompt per
// piece and none for the refused part. A part without units, a single unit, and a part whose attempt reached the
// wallet are never re-split. Account 32 of anvil's public development mnemonic (used by no other test file),
// impersonated.
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { Journal } from "../../src/actions/journal.ts";
import type { SequencePartInput } from "../../src/actions/sequence.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex } from "../../src/core/hex.ts";
import { planTag, topicItems } from "../../src/tags/index.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const ME = mnemonicToAccount(MNEMONIC, { addressIndex: 32 }).address.toLowerCase() as Hex;
const CAP = 16_777_216;

const rpc = async (method: string, params: unknown[] = []) => {
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
 * The impersonated account as an EIP-1193 wallet: anvil signs and mines; every send is counted as a prompt. `atomic`:
 * it speaks EIP-5792 and runs a batch's calls in order, one prompt per request (`batches` holds each request's size).
 */
function wallet(k: { atomic?: boolean } = {}) {
  const prompts: unknown[] = [];
  const batches: number[] = [];
  return {
    prompts,
    batches,
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
        if (method === "eth_sendTransaction") prompts.push(params);
        if (method === "wallet_getCapabilities") {
          if (!k.atomic) throw Object.assign(new Error("method not found"), { code: -32601 });
          const id = (params as [string, string[]])[1][0] as string;
          return { [id]: { atomic: { status: "supported" } } };
        }
        if (method === "wallet_sendCalls") {
          const req = (params as [{ from: string; calls: { to: string; data: string }[] }])[0];
          prompts.push(params);
          batches.push(req.calls.length);
          for (const c of req.calls) {
            const hash = await rpc("eth_sendTransaction", [
              { from: req.from, to: c.to, data: c.data },
            ]);
            for (let t = 0; t < 200 && !(await rpc("eth_getTransactionReceipt", [hash])); t++)
              await new Promise((ok) => setTimeout(ok, 20));
          }
          return { id: `batch-${batches.length}` };
        }
        if (method === "wallet_getCallsStatus") return { status: 200 };
        return rpc(method, params ?? []);
      },
    },
  };
}

let tagRun = 0;
/**
 * A fresh deep topic (12 words) and 30 fresh addresses, planned as the planner does (several parts, each under the
 * cap), then merged into ONE part with every unit kept: a part the chain prices over 2^24, as a part planned blind to
 * long lists would be.
 */
async function packedTag(journal: Journal = memoryJournal(), k: { atomic?: boolean } = {}) {
  tagRun++;
  const w = wallet(k);
  const writer = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: w.provider, account: ME },
    journal,
  });
  const words = Array.from({ length: 12 }, (_, i) => `resplit${tagRun}x${i}`);
  const targets = Array.from({ length: 30 }, (_, i) => ({
    kind: "address" as const,
    address: `0x${(tagRun * 1000 + i + 1).toString(16).padStart(40, "a")}` as Hex,
  }));
  const plan = await planTag(efs, writer, { topic: words, targets });
  if (plan.status !== "PLANNED") throw new Error(JSON.stringify(plan));
  expect(plan.parts.length).toBeGreaterThan(1);
  const merged: SequencePartInput = {
    actions: plan.parts.flatMap((p) => p.actions),
    bodies: plan.parts.flatMap((p) => p.bodies),
    effects: plan.parts.flatMap((p) => p.effects),
    units: plan.parts.flatMap((p) => p.units ?? []),
  };
  return { w, writer, words, part: merged, journal };
}

/** One small, ordinary part (a fresh one-word topic and one address), with the planner's own gas figures. */
async function smallTag(writer: { principal: Hex }) {
  tagRun++;
  const plan = await planTag(efs, writer as never, {
    topic: [`resplitsmall${tagRun}`],
    targets: [
      { kind: "address", address: `0x${(tagRun * 7919).toString(16).padStart(40, "b")}` as Hex },
    ],
  });
  if (plan.status !== "PLANNED" || plan.parts.length !== 1) throw new Error(JSON.stringify(plan));
  return plan.parts[0] as SequencePartInput;
}

beforeAll(async () => {
  await rpc("anvil_setBalance", [ME, "0x56bc75e2d63100000"]);
  await rpc("anvil_impersonateAccount", [ME]);
});

describe("a part over the cap is re-split, never lost", () => {
  it("cut between its units: one prompt per piece, none for the refused part, and every statement lands", async () => {
    const { w, writer, words, part, journal } = await packedTag();
    const units = part.units ?? [];
    expect(units[0]?.effect.args["stage"]).toBe("register");
    expect(units.filter((u) => u.effect.args["stage"] === "finish")).toHaveLength(30);
    // More approvals than the review said: the save stops before any of them, saying how many (resplit "ask").
    const stopped = await writer.runSequence([part]);
    expect(stopped).toMatchObject({
      state: "NOT_STARTED",
      committed: 0,
      reason: { code: "RESPLIT", retry: "after-review", prompts: { before: 1 } },
    });
    expect(stopped.total).toBeGreaterThan(1); // `total` grew mid-save
    expect(stopped.reason?.prompts?.now).toBe(stopped.total);
    expect(w.prompts).toEqual([]); // nothing was asked: not the refused part, not a piece
    // Continue: resume sends the pieces.
    const done = await writer.resume(stopped.sequenceId);
    expect(done).toMatchObject({ state: "COMPLETE", total: stopped.total });
    expect(w.prompts).toHaveLength(done.total); // one per piece; the refused part never reached the wallet
    const rec = await journal.getSequence(done.sequenceId);
    expect(
      rec?.history.some((h) =>
        /was too large for one transaction: split into \d+/.test(h.detail ?? ""),
      ),
    ).toBe(true);
    // The pieces' effects are numbered as the save now stands, and none was held as a twin (each committed).
    rec?.parts.forEach((p, i) => {
      expect(p.committed).toBe(true);
      for (const e of p.effects)
        expect([e.args["part"], e.args["parts"]]).toEqual([
          String(i + 1),
          String(rec.parts.length),
        ]);
    });
    for (const p of rec?.parts ?? [])
      expect((await journal.get(p.planId as Hex))?.stage).toBe("COMMITTED");
    const items = await topicItems(efs, words, { view: "mine", lens: efs.lens.from([ME]) });
    expect(items.status).toBe("PRESENT");
    if (items.status === "PRESENT") expect(items.rows).toHaveLength(30);
  }, 240_000);

  it('resplit "continue": an app that told the person up front goes on in the same call', async () => {
    const { w, writer, part } = await packedTag();
    const done = await writer.runSequence([part], { resplit: "continue" });
    expect(done).toMatchObject({ state: "COMPLETE" });
    expect(done.total).toBeGreaterThan(1);
    expect(w.prompts).toHaveLength(done.total);
  }, 240_000);

  it("an atomic wallet that packs a piece with the next part needs no more approvals: no stop", async () => {
    const { w, writer, part } = await packedTag(memoryJournal(), { atomic: true });
    const next = await smallTag(writer);
    // Reviewed: the big part alone, the small one alone (2 approvals). Cut: piece 1 alone, the last piece and the
    // small part in one request (2 approvals): the same count, so the save goes on.
    const done = await writer.runSequence([part, next]);
    expect(done).toMatchObject({ state: "COMPLETE" });
    expect(done.total).toBeGreaterThan(2);
    expect(done.reason).toBeUndefined();
    expect(w.batches.some((n) => n > 1)).toBe(true);
    expect(w.prompts.length).toBeLessThan(done.total);
  }, 240_000);

  it("Cancel after an earlier part committed: the save stays PARTIAL, k of N saved, never nothing saved", async () => {
    const { w, writer, part, journal } = await packedTag();
    const first = await smallTag(writer);
    const stopped = await writer.runSequence([first, part], { batch: "never" });
    expect(stopped).toMatchObject({
      state: "PARTIAL",
      committed: 1,
      reason: { code: "RESPLIT", prompts: { before: 2 } },
    });
    expect(stopped.total).toBeGreaterThan(2);
    expect(stopped.current?.index).toBe(1);
    expect(w.prompts).toHaveLength(1); // the first part only
    // The person cancels (nothing is called): what a reload shows is the same save, 1 of N saved, resumable.
    const later = await writer.reconcileSequence(stopped.sequenceId);
    expect(later).toMatchObject({ state: "PARTIAL", committed: 1, total: stopped.total });
    expect((await writer.pendingSequences()).map((p) => p.sequenceId)).toContain(
      stopped.sequenceId,
    );
    expect((await journal.getSequence(stopped.sequenceId))?.parts[0]?.committed).toBe(true);
  }, 240_000);

  it("a part without units is never re-split: it stops, nothing sent, saying how many parts it needs", async () => {
    const { w, writer, part } = await packedTag();
    const { units: _u, ...bare } = part;
    const stopped = await writer.runSequence([bare]);
    expect(stopped).toMatchObject({
      state: "NOT_STARTED",
      reason: { code: "OVER_TX_GAS_CAP", retry: "after-replan" },
    });
    expect(stopped.reason?.gas?.suggestedParts).toBeGreaterThanOrEqual(2);
    expect(stopped.reason?.gas && stopped.reason.gas.estimate > BigInt(CAP)).toBe(true);
    expect(w.prompts).toEqual([]);
  });

  it("a single unit over the cap ends as retry never", async () => {
    const { w, writer, part } = await packedTag();
    const one = {
      ...part,
      units: [{ actions: part.actions.length, effect: part.effects[0] as never }],
    };
    const stopped = await writer.runSequence([one]);
    expect(stopped).toMatchObject({
      state: "NOT_STARTED",
      reason: { code: "OVER_TX_GAS_CAP", retry: "never" },
    });
    expect(stopped.reason?.detail).toMatch(/it can't be split further/);
    expect(w.prompts).toEqual([]);
  });

  it("a part whose attempt reached a wallet is never re-split", async () => {
    // A journal that answers the re-split's own check (the second read of a plan id: after sendPlan's) with an
    // attempt at SUBMISSION_POSSIBLE (it may have gone out): the save must refuse to cut that part. Every other read
    // is the real journal's.
    const inner = memoryJournal();
    const reads = new Map<string, number>();
    const journal: Journal = {
      ...inner,
      async get(planId) {
        const real = await inner.get(planId);
        if (real) return real;
        const n = (reads.get(planId) ?? 0) + 1;
        reads.set(planId, n);
        return n === 2
          ? ({
              schema: "efs-sdk-attempt/1",
              planId,
              stage: "SUBMISSION_POSSIBLE",
              history: [],
            } as never)
          : undefined;
      },
    };
    const { w, writer, part } = await packedTag(journal);
    const stopped = await writer.runSequence([part]);
    expect(stopped.state).not.toBe("COMPLETE");
    expect(stopped.total).toBe(1); // not cut
    expect(stopped.reason?.code).toBe("OVER_TX_GAS_CAP");
    expect(w.prompts).toEqual([]);
  });
});
