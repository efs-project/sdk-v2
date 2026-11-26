// SPDX-License-Identifier: MIT
// A fetch in front of the fixture's anvil for the fee-schedule check (src/actions/schedule.ts): it forwards every
// request, and answers the check's probe (a deployless eth_call whose data is SCHEDULE_PROBE) as a chain on another
// schedule would (`as`), or fails it (`failNext`). It counts the probes it saw, so a test can tell how often the
// check measured. Everything else, the probe on the real schedule included, is the fixture's own answer.
import { pad, toHex } from "viem";
import { SCHEDULE_PROBE } from "../../src/actions/schedule.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { FRESH_SLOT_GAS } from "../../src/generated/gas.ts";

export function pricing(rpcUrl: string) {
  const state = { as: undefined as string | undefined, failNext: 0, probes: 0 };
  const isProbe = (req: { method?: string; params?: unknown[] }) => {
    const call = req.params?.[0] as { to?: string; data?: string } | undefined;
    return req.method === "eth_call" && !call?.to && call?.data?.toLowerCase() === SCHEDULE_PROBE;
  };
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const one = async (req: { id: unknown; method: string; params?: unknown[] }) => {
      if (isProbe(req)) {
        state.probes++;
        if (state.failNext > 0) {
          state.failNext--;
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32000, message: "probe refused (test)" },
          };
        }
        if (state.as) {
          const price = (FRESH_SLOT_GAS as Readonly<Record<string, number>>)[state.as];
          if (price === undefined) throw new Error(`no schedule ${state.as}`);
          return { jsonrpc: "2.0", id: req.id, result: pad(toHex(price + 8), { size: 32 }) };
        }
      }
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      return res.json();
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
  return { state, fetch: fetchImpl };
}
