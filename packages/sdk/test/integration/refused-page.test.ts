// SPDX-License-Identifier: MIT
// A topic page the reader refuses carries no counts, and the SDK reads it as a refusal with no counts (contracts
// final step, 3ca53ba: a page that is not PRESENT has rawTotal, positionsEver, scanned, repeatsSkipped and the
// frontier at 0, scanStatus 0, no continuation and no rows). The refusal is the real reader's, not a tampered reply:
// a fetch wrapper changes only the basis the SDK's own call commits to (`expected`), so the reader answers that the
// basis is not the live one. The fixture's index is complete, so a PARTIAL list (refused the same way) can't be
// produced here.
import { readFileSync } from "node:fs";
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { describe, expect, inject, it } from "vitest";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import { topicEveryoneReaderAbi, topicMineReaderAbi } from "../../src/generated/abis.ts";
import { chainStatus } from "../../src/protocol/status.ts";
import { topicItems } from "../../src/tags/index.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const NOT_LIVE = `0x${"11".repeat(32)}` as Hex;

/** Forward to anvil; rewrite the `expected` basis of calls to `reader`; keep each rewritten call's raw reply. */
function rewriting(reader: string, abi: typeof topicEveryoneReaderAbi | typeof topicMineReaderAbi) {
  const replies: Hex[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const one = async (req: { id: unknown; method: string; params?: unknown[] }) => {
      const call = req.params?.[0] as { to?: string; data?: Hex } | undefined;
      let rewritten = false;
      if (
        req.method === "eth_call" &&
        call?.to?.toLowerCase() === reader.toLowerCase() &&
        call.data
      ) {
        const d = decodeFunctionData({ abi, data: call.data });
        const args = [...((d.args ?? []) as unknown as readonly unknown[])];
        const at = d.functionName === "everyone" ? 2 : 3; // everyone(query, lens, expected, …) / mine(lens, place, below, expected, …)
        args[at] = { ...(args[at] as object), executionSet: NOT_LIVE };
        call.data = encodeFunctionData({ abi, functionName: d.functionName, args } as never);
        rewritten = true;
      }
      const res = await fetch(fixture.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      const j = (await res.json()) as { result?: Hex };
      if (rewritten && j.result) replies.push(j.result);
      return j;
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    const text = JSON.stringify(out);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  };
  return { replies, fetch: fetchImpl };
}

describe("a refused topic page carries no counts, and reads as a refusal", () => {
  for (const view of ["everyone", "mine"] as const) {
    it(`${view}: the real reader refuses a basis that is not live, with every count at 0`, async () => {
      const readers = createEfs({ rpcs: [fixture.rpcUrl], deployment }).deployment.readers;
      const reader = (view === "mine" ? readers.topicMine : readers.topicEveryone) as string;
      const abi = view === "mine" ? topicMineReaderAbi : topicEveryoneReaderAbi;
      const w = rewriting(reader, abi);
      const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: w.fetch });
      const page = await topicItems(efs, ["docs"], { view });
      // The SDK: a refusal (never PRESENT), and no counts at all.
      expect(page).toMatchObject({ status: "UNKNOWN", reason: { code: "BASIS_STALE" } });
      expect(page).not.toHaveProperty("counts");
      expect(page).not.toHaveProperty("rows");
      // The reader: not PRESENT, and every count zero.
      expect(w.replies.length).toBeGreaterThan(0);
      const [info, rows] = decodeFunctionResult({
        abi,
        functionName: view,
        data: w.replies[0] as Hex,
      } as never) as unknown as [Record<string, unknown> & { q: { status: number } }, unknown[]];
      expect(chainStatus(Number(info.q.status))).not.toBe("PRESENT");
      for (const k of [
        "scanStatus",
        "scanned",
        "frontier",
        "rawTotal",
        "positionsEver",
        "repeatsSkipped",
      ])
        expect(BigInt(info[k] as number | bigint), k).toBe(0n);
      if ("selectedSoFar" in info) expect(BigInt(info["selectedSoFar"] as bigint)).toBe(0n);
      expect(info["next"]).toBe("0x");
      expect(rows).toEqual([]);
    });
  }
});
