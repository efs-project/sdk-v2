// SPDX-License-Identifier: MIT
// The fee-schedule check on the fixture (src/actions/schedule.ts): before the first plan or send, a client measures
// how the chain prices a fresh storage slot and refuses a deployment document whose fee schedule is not the chain's,
// naming both, never adopting the measured one. The fixture runs prague. A failed probe is UNKNOWN for that call and
// never kept; a measurement is kept 10 minutes; reads never probe. Account 31 of anvil's public development mnemonic
// (used by no other test file); nothing here is sent.
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { classifySchedule, SCHEDULE_TTL_MS } from "../../src/actions/schedule.ts";
import type { Plan } from "../../src/actions/types.ts";
import { createEfs, type Efs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/index.ts";
import { ACTION } from "../../src/generated/constants.ts";
import { planTag, topicItems } from "../../src/tags/index.ts";
import { pricing } from "./pricing.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const MNEMONIC = "test test test test test test test test test test test junk";
const ME = mnemonicToAccount(MNEMONIC, { addressIndex: 31 }).address.toLowerCase() as Hex;
const AMSTERDAM_DOC = {
  ...deployment,
  chain: { ...deployment.chain, hardfork: "amsterdam", feeSchedule: "amsterdam" },
};

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

/** A wallet that records every send and sends nothing. */
function quietWallet() {
  const sent: unknown[] = [];
  return {
    sent,
    provider: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [ME];
        if (method === "eth_sendTransaction" || method === "wallet_sendCalls") {
          sent.push(params);
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        }
        return rpc(method, params ?? []);
      },
    },
  };
}

const writerOf = (efs: Efs, wallet = quietWallet()) =>
  createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: wallet.provider, account: ME },
    journal: memoryJournal(),
  });

function chunkPart(efs: Efs, seed: number) {
  const b = encode.chunk(new Uint8Array(40).fill(seed));
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
    effects: [{ code: "test.fee-schedule", args: {} }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fee-schedule check", () => {
  it("the prague fixture passes: one probe per client, measured as prague, and the plan goes through", async () => {
    const p = pricing(fixture.rpcUrl);
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: p.fetch });
    const w = await writerOf(efs);
    const started = Date.now();
    const first = await w.planActions(chunkPart(efs, 1));
    expect(first.status).toBe("PLANNED");
    const second = await w.planActions(chunkPart(efs, 2));
    expect(second.status).toBe("PLANNED");
    expect(p.state.probes).toBe(1); // one call, once: the fixture and `pnpm dev` are not slowed
    const m = efs._internal.schedule.last;
    expect(m?.schedule).toBe("prague");
    expect(classifySchedule(m?.measured ?? 0n)).toBe("prague");
    expect(m && m.measured - 8n).toBe(22_100n); // a fresh, cold SSTORE on prague
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a document that says amsterdam on the prague fixture is refused, naming both; nothing is sent", async () => {
    const wallet = quietWallet();
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment: AMSTERDAM_DOC });
    const w = await writerOf(efs, wallet);
    const why = {
      code: "UNSUPPORTED_PROFILE",
      retry: "never",
      feeSchedule: { document: "amsterdam", chain: "prague", freshSlotGas: 22_100n },
    };
    // planPublication (planActions, and every part a save plans)
    const planned = await w.planActions(chunkPart(efs, 3));
    expect(planned).toMatchObject({ status: "REFUSED", reason: why });
    expect(planned.status !== "PLANNED" && planned.reason.detail).toMatch(
      /document: amsterdam, chain: prague/,
    );
    // a planner (a real target, so the plan gets as far as its gas setup)
    const readme = deployment.seed.files.find((f: { name: string }) => f.name === "readme.txt");
    const tag = await planTag(efs, w, {
      topic: ["fee-check"],
      targets: [{ kind: "file", subject: readme.subjectId }],
    });
    expect(tag).toMatchObject({ status: "UNKNOWN", reason: why });
    // a send, of a plan made by a client whose document is right
    const good = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const made = await (await writerOf(good)).planActions(chunkPart(good, 4));
    if (made.status !== "PLANNED") throw new Error(made.status);
    const sent = await w.send(made.plan as Plan);
    expect(sent).toMatchObject({ status: "NOT_SENT", reason: why });
    // a save
    const save = await w.runSequence([chunkPart(efs, 5)]);
    expect(save).toMatchObject({ state: "NOT_STARTED", reason: { code: "UNSUPPORTED_PROFILE" } });
    expect(wallet.sent).toEqual([]);
  });

  it("a failed probe is UNKNOWN for that call and never kept: the next call measures again", async () => {
    const p = pricing(fixture.rpcUrl);
    p.state.failNext = 1;
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: p.fetch });
    const w = await writerOf(efs);
    const failed = await w.planActions(chunkPart(efs, 6));
    expect(failed.status).toBe("UNKNOWN");
    expect(failed.status !== "PLANNED" && failed.reason.detail).toMatch(
      /could not check this chain's fee schedule/,
    );
    expect(efs._internal.schedule.last).toBeUndefined();
    const ok = await w.planActions(chunkPart(efs, 7));
    expect(ok.status).toBe("PLANNED");
    expect(p.state.probes).toBe(2);
  });

  it("a measurement is kept 10 minutes, then taken again (a chain can fork under a long-lived page)", async () => {
    const p = pricing(fixture.rpcUrl);
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: p.fetch });
    const w = await writerOf(efs);
    expect((await w.planActions(chunkPart(efs, 8))).status).toBe("PLANNED");
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + SCHEDULE_TTL_MS - 1000);
    expect((await w.planActions(chunkPart(efs, 9))).status).toBe("PLANNED");
    expect(p.state.probes).toBe(1);
    // After the window, the chain now prices storage by EIP-8037: the same client refuses its prague document.
    vi.spyOn(Date, "now").mockReturnValue(real + SCHEDULE_TTL_MS + 1000);
    p.state.as = "amsterdam";
    const after = await w.planActions(chunkPart(efs, 10));
    expect(after).toMatchObject({
      status: "REFUSED",
      reason: { feeSchedule: { document: "prague", chain: "amsterdam" } },
    });
    expect(p.state.probes).toBe(2);
  });

  it("reads never probe", async () => {
    const p = pricing(fixture.rpcUrl);
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: p.fetch });
    expect((await efs.at()).status).toBe("VERIFIED");
    const readme = deployment.seed.files.find((f: { name: string }) => f.name === "readme.txt");
    expect((await openFile(efs, { kind: "file", subject: readme.subjectId })).status).toBe(
      "PRESENT",
    );
    await topicItems(efs, ["docs"]);
    expect(p.state.probes).toBe(0);
  });
});
