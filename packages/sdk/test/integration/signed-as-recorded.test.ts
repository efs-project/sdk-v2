// SPDX-License-Identifier: MIT
// A plan or a save read back from the journal is signed only as it was recorded (the write-path audit, 2026-11-26).
// sendPlan re-derives a plan's calldata and digest from its own fields before any wallet is asked; a sequence records
// a hash of its parts, and resume refuses parts that don't hash to it; a part resent after a funds refusal goes only
// as its own publication. Each alteration is INVARIANT, and the wallet is never asked.
// Account 48 of anvil's public development mnemonic (used by no other test file), impersonated.
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { sendPlansAsBatch } from "../../src/actions/batch.ts";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { Plan } from "../../src/actions/types.ts";
import { createEfs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ACTION } from "../../src/generated/constants.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const ME = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 48,
}).address.toLowerCase() as Hex;

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
const broke = () => rpc("anvil_setBalance", [ME, "0x1"]);
const topUp = () => rpc("anvil_setBalance", [ME, "0x56bc75e2d63100000"]);

/** The impersonated account as a wallet that counts its prompts; `refuse` rejects the n-th send. */
function wallet(refuse?: number) {
  const w = {
    prompts: 0,
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
        if (method === "eth_sendTransaction") {
          w.prompts++;
          if (refuse === w.prompts) throw Object.assign(new Error("User rejected"), { code: 4001 });
          return rpc(method, params ?? []);
        }
        if (method === "wallet_getCapabilities")
          throw Object.assign(new Error("no"), { code: -32601 });
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
/** One chunk record: a publication any account may make. */
function chunkPart() {
  const b = encode.chunk(new Uint8Array(48).fill(++seed));
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
    effects: [{ code: "test.signed-as-recorded", args: { seed: String(seed) } }],
  };
}

beforeAll(async () => {
  await rpc("anvil_impersonateAccount", [ME]);
  await topUp();
});

describe("a plan is signed only as the publication it names (sendPlan)", () => {
  it("altered calldata, actions, id or an unbound expectation is INVARIANT, and no wallet is asked", async () => {
    const w = wallet();
    const { writer } = await writerFor(w);
    const planned = await writer.planActions(chunkPart());
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const plan = planned.plan;
    const flip = (h: Hex): Hex => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}` as Hex;
    const other = chunkPart().actions;
    const altered: Record<string, Plan> = {
      calldata: { ...plan, calldata: flip(plan.calldata) },
      actions: { ...plan, actions: other },
      id: { ...plan, id: flip(plan.id) },
      profile: { ...plan, acceptanceProfile: ZERO_WORD },
      nonce: { ...plan, nonce: plan.nonce + 1n },
    };
    for (const [what, p] of Object.entries(altered))
      await expect(writer.send(p), what).rejects.toMatchObject({ code: "INVARIANT" });
    expect(w.prompts).toBe(0);
    // The plan as made goes.
    const sent = await writer.send(plan);
    if (sent.status !== "SUBMITTED") throw new Error(sent.status);
    expect(w.prompts).toBe(1);
    // Mined before the next save plans its nonce.
    for (let i = 0; i < 200 && !(await rpc("eth_getTransactionReceipt", [sent.txHash])); i++)
      await new Promise((ok) => setTimeout(ok, 25));
  });
});

describe("a batch is signed only as the publications it names (sendPlansAsBatch)", () => {
  it("one altered plan in a batch is INVARIANT before the wallet is asked", async () => {
    const w = wallet();
    const { writer, journal } = await writerFor(w);
    const planned = await writer.planSequence([chunkPart(), chunkPart()]);
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const [a, b] = planned.plans as [Plan, Plan];
    await expect(
      sendPlansAsBatch(efs, journal, w.provider, [a, { ...b, actions: chunkPart().actions }]),
    ).rejects.toMatchObject({ code: "INVARIANT" });
    expect(w.prompts).toBe(0);
  });
});

describe("a save sends only the parts it recorded (resume)", () => {
  it("parts altered in the journal are INVARIANT on resume, and no wallet is asked", async () => {
    const w = wallet(2);
    const { writer, journal } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart(), chunkPart()], { batch: "never" });
    expect(stopped).toMatchObject({ state: "PARTIAL", committed: 1 });
    const rec = await journal.getSequence(stopped.sequenceId);
    if (!rec?.partsHash) throw new Error("no parts hash recorded");
    const swapped = chunkPart();
    await journal.putSequence({
      ...rec,
      parts: rec.parts.map((p, i) =>
        i === 1 ? { ...p, actions: swapped.actions, bodies: swapped.bodies } : p,
      ),
    });
    const prompts = w.prompts;
    await expect(writer.resume(stopped.sequenceId)).rejects.toMatchObject({ code: "INVARIANT" });
    expect(w.prompts).toBe(prompts);
    // Put back as recorded, it resumes and completes.
    await journal.putSequence(rec);
    expect(await writer.resume(stopped.sequenceId)).toMatchObject({ state: "COMPLETE" });
  });

  it("a save recorded before parts hashes existed resumes as before", async () => {
    const w = wallet(2);
    const { writer, journal } = await writerFor(w);
    const stopped = await writer.runSequence([chunkPart(), chunkPart()], { batch: "never" });
    expect(stopped).toMatchObject({ state: "PARTIAL" });
    const { partsHash: _h, ...old } = (await journal.getSequence(
      stopped.sequenceId,
    )) as NonNullable<Awaited<ReturnType<typeof journal.getSequence>>>;
    await journal.putSequence(old);
    expect(await writer.resume(stopped.sequenceId)).toMatchObject({ state: "COMPLETE" });
  });

  it("a part resent after a funds refusal goes only as its own publication", async () => {
    await broke();
    try {
      const w = wallet();
      const { writer, journal } = await writerFor(w);
      const stopped = await writer.runSequence([chunkPart()], { settleMs: 500 });
      expect(stopped).toMatchObject({ state: "IN_FLIGHT", reason: { code: "INSUFFICIENT_FUNDS" } });
      const planId = (await journal.getSequence(stopped.sequenceId))?.parts[0]?.planId as Hex;
      const attempt = await journal.get(planId);
      if (!attempt) throw new Error("no attempt");
      // Another publication's plan, consistent in itself (its calldata and digest are its own), stored for the part.
      await topUp();
      const otherPlan = await writer.planActions(chunkPart());
      if (otherPlan.status !== "PLANNED") throw new Error(otherPlan.status);
      await journal.put({ ...attempt, plan: otherPlan.plan });
      const prompts = w.prompts;
      await expect(writer.resume(stopped.sequenceId, { settleMs: 500 })).rejects.toMatchObject({
        code: "INVARIANT",
      });
      expect(w.prompts).toBe(prompts);
    } finally {
      await topUp();
    }
  });
});
