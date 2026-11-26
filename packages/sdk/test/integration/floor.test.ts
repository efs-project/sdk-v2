// SPDX-License-Identifier: MIT
// The kernel's index floor on a real chain. Before it sends a publication's callbacks the kernel reserves a prefix
// floor and a final reserve that its work model prices per action and per bind. A publication the gas model fits can
// still need more visible gas than the cap allows, and eth_estimateGas then refuses it before signing: on the release
// before the tag release (120,000 per bind), 64 removes or moves did exactly that. Every part a planner makes must fit
// the budget with its floor (the planning rule). One account of anvil's public development mnemonic (index 17, used by
// no other test file), funded here.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, hexToBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { gasPlanFor, kernelQuote } from "../../src/actions/split.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, PrincipalId, RecordId } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planCreateFolder,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
} from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { ingressAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 17,
});
const journal = memoryJournal();
const text = (s: string) => new TextEncoder().encode(s);
const BUDGET = Math.floor(Number(efs.deployment.chain?.txGasCap ?? 2n ** 24n) * 0.85);

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
};
const calldataGas = (data: Hex) => {
  let g = 0;
  for (const b of hexToBytes(data)) g += b === 0 ? 4 : 16;
  return g;
};

type Parts = readonly { actions: readonly unknown[]; bodies: readonly Hex[] }[];
let w: Awaited<ReturnType<typeof createWriter>>;
let lens: { principals: PrincipalId[] };

/** Plan a folder save, then send it part by part, checking each part's own estimate against the budget first. */
async function sendWithinFloor(planned: Promise<{ status: string }>): Promise<number[]> {
  const p = await planned;
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  const needs: number[] = [];
  for (const part of (p as unknown as { parts: Parts }).parts) {
    const pl = await w.planActions(part as never);
    if (pl.status !== "PLANNED") throw new Error(pl.status);
    const est = Number(
      BigInt(
        (await rpc("eth_estimateGas", [
          { from: me.address, to: pl.plan.ledger, data: pl.plan.calldata },
        ])) as Hex,
      ),
    );
    // The planning rule: the visible gas the call needs, less intrinsic and calldata, fits the budget.
    const need = est - 21_000 - calldataGas(pl.plan.calldata);
    needs.push(need);
    expect(need).toBeLessThanOrEqual(BUDGET);
    const r = await w.run(pl.plan);
    expect(r.send.status).toBe("SUBMITTED");
  }
  return needs;
}

const folderNamed = async (name: string, parent: FolderRef = root): Promise<FolderRef> => {
  const p = await planCreateFolder(efs, w, { folder: parent, name, lens });
  if (p.status !== "PLANNED") throw new Error(p.status);
  expect((await w.runSequence(p.parts)).state).toBe("COMPLETE");
  return { kind: "folder", directory: p.review.created.directory };
};

beforeAll(async () => {
  await rpc("anvil_setBalance", [me.address, "0x3635c9adc5dea00000"]); // 1000 ETH
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: me },
    journal,
  });
  lens = { principals: [w.principal] };
});

describe("the kernel floor (fixture)", () => {
  it("64-entry removes, restores, moves and renames plan only parts whose floor fits the budget", {
    timeout: 600_000,
  }, async () => {
    const folder = await folderNamed("floor-batches");
    const dest = await folderNamed("floor-batches-dest");
    const names = Array.from({ length: 64 }, (_, i) => `f${i}.txt`);
    for (const n of names) {
      const p = await planCreateFile(efs, w, { folder, name: n, content: text(n), lens });
      if (p.status !== "PLANNED") throw new Error(p.status);
      expect((await w.runSequence(p.parts)).state).toBe("COMPLETE");
    }
    const entries = names.map((name) => ({ folder, name }));
    await sendWithinFloor(planRemoveEntries(efs, w, { entries, lens })); // 64 RELEASEs
    await sendWithinFloor(planRestoreEntries(efs, w, { entries, lens }));
    await sendWithinFloor(
      planMoveEntries(efs, w, {
        moves: names.map((n) => ({ from: { folder, name: n }, to: { folder: dest } })),
        lens,
      }),
    );
    await sendWithinFloor(
      planMoveEntries(efs, w, {
        moves: names.map((n) => ({ from: { folder: dest, name: n }, to: { name: `r-${n}` } })),
        lens,
      }),
    );
    await sendWithinFloor(
      planRemoveEntries(efs, w, {
        entries: names.map((n) => ({ folder: dest, name: `r-${n}` })),
        hide: true, // 64 UNBINDs
        lens,
      }),
    );
  });

  it("the SDK's floor quote is the kernel's own: equal with every bind a first statement", async () => {
    const folder = await folderNamed("floor-quote");
    const p = await planCreateFile(efs, w, {
      folder,
      name: "q.bin",
      content: new Uint8Array(20_000).fill(7),
      mediaType: "application/octet-stream",
      lens,
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    // The gas model's floor, which the planner uses; the deployment's own work model equals it (gasPlanFor checks).
    const g = gasPlanFor(efs.deployment);
    if (!g.ok) throw new Error(g.reason.code);
    const floor = g.model.floor;
    if (!floor) throw new Error("the gas model has no floor");
    for (const part of p.parts) {
      const reply = (await rpc("eth_call", [
        {
          to: efs.deployment.ingress,
          data: encodeFunctionData({
            abi: ingressAbi,
            functionName: "indexFloor",
            args: [efs.deployment.ledger, part.actions as never],
          }),
        },
        "latest",
      ])) as Hex;
      const [prefixFloor, finalReserve, freshSlots, rewrites] = decodeFunctionResult({
        abi: ingressAbi,
        functionName: "indexFloor",
        data: reply,
      }) as unknown as [number, number, number, number];
      // The kernel's helper prices every bind as a first statement, as the SDK does when it knows nothing better.
      expect(
        kernelQuote(part.actions, floor, { noPrincipal: true, typeNames: g.typeNames }),
      ).toEqual({
        prefixFloor,
        finalReserve,
        freshSlots,
        rewrites,
      });
    }
    expect((await w.runSequence(p.parts)).state).toBe("COMPLETE");
  });
});
