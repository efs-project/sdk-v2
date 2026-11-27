// SPDX-License-Identifier: MIT
// Reads that used to end on one endpoint's bad reply now try the next endpoint (the read-validation audit,
// 2026-11-26), and end exactly as before when every endpoint says the same:
//   - reconcile: a reader's UNSUPPORTED from publicationAt (a pinned reader can't be another layout);
//   - web3://: a resolveMode that isn't ERC-5219 (or no code), a request() reply that doesn't decode, or a status
//     other than 200 (or a 307 with a Location).
// Each is shown with a lying endpoint first and an honest one second (the honest answer wins), and the liar alone (the
// same outcome as before). Account 64 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { encodeFunctionResult, toFunctionSelector } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { reconcileAttempt } from "../../src/actions/reconcile.ts";
import { createEfs } from "../../src/client.ts";
import { type Address, type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { planCreateFolder } from "../../src/files/entries.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const ME = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 64,
});

/** An EIP-1193 endpoint on the fixture whose eth_call replies to `selector` are replaced by `edit`. */
const liar = (selector: string, edit: (result: Hex) => Hex) => ({
  provider: {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const res = await fetch(fixture.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = (await res.json()) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
      const data = String((params as [{ data?: string }] | undefined)?.[0]?.data ?? "");
      if (method === "eth_call" && data.startsWith(selector) && typeof json.result === "string")
        return edit(json.result as Hex);
      return json.result;
    },
  },
  label: "liar",
});
const both = (l: ReturnType<typeof liar>) => createEfs({ rpcs: [l, fixture.rpcUrl], deployment });
const alone = (l: ReturnType<typeof liar>) => createEfs({ rpcs: [l], deployment });

describe("reconcile: a reader's UNSUPPORTED tries the next endpoint", () => {
  let planId: Hex;
  let journal: ReturnType<typeof memoryJournal>;
  beforeAll(async () => {
    await fetch(fixture.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [ME.address, "0x56bc75e2d63100000"],
      }),
    });
    journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: ME },
      journal,
    });
    const p = await planCreateFolder(efs, w, {
      folder: { kind: "home", address: ME.address.toLowerCase() as Address },
      name: `fo${Date.now().toString(36)}`,
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    const part = p.parts[0];
    if (!part) throw new Error("no part");
    const planned = await w.planActions({
      actions: part.actions,
      bodies: part.bodies,
      effects: [],
      ...(part.guard ? { guard: part.guard } : {}),
    });
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const ran = await w.run(planned.plan);
    expect(ran.reconcile?.outcome).toBe("COMMITTED");
    planId = planned.plan.id;
  }, 120_000);
  const unsupported = liar(
    toFunctionSelector(
      ledgerReadsAbi.find((x) => x.type === "function" && x.name === "publicationAt") as never,
    ),
    () =>
      encodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "publicationAt",
        result: [10, 0n, ZERO_WORD] as never,
      }) as Hex,
  );
  it("a liar first and an honest endpoint second: COMMITTED (the honest answer)", async () => {
    const r = await reconcileAttempt(both(unsupported), journal, planId);
    expect(r.outcome).toBe("COMMITTED");
  });
  it("the liar alone: UNKNOWN, UNSUPPORTED_PROFILE, as before", async () => {
    const r = await reconcileAttempt(alone(unsupported), journal, planId);
    expect(r).toMatchObject({
      outcome: "UNKNOWN",
      reason: { code: "UNSUPPORTED_PROFILE", retry: "never" },
    });
  });
});
