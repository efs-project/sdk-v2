// SPDX-License-Identifier: MIT
// A fetch to the real fixture chain that rewrites chosen eth_call replies, for tests of how reads and plans treat
// tampered or failing endpoints. Test-only.
import { getAbiItem, toFunctionSelector } from "viem";
import type { FetchLike } from "../../src/chain/rpc.ts";
import type { Hex } from "../../src/core/hex.ts";

/** Rewrite one eth_call result, or turn it into a JSON-RPC error. */
export type Edit = (result: Hex) => Hex | { error: { code: number; message: string } };

/** The 4-byte selector of `name` in `abi`. */
export const sel = (abi: readonly unknown[], name: string): Hex =>
  toFunctionSelector(getAbiItem({ abi: abi as never, name } as never) as never) as Hex;

/** A fetch whose eth_call replies for the given selectors pass through `edit`. */
export function tampered(edits: Record<Hex, Edit>): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    const sent = JSON.parse(init.body ?? "null");
    const reqs = Array.isArray(sent) ? sent : [sent];
    const got = JSON.parse(await res.text());
    const outs = Array.isArray(got) ? got : [got];
    for (const r of reqs) {
      if (r?.method !== "eth_call") continue;
      const edit = edits[String(r.params?.[0]?.data ?? "").slice(0, 10) as Hex];
      const item = outs.find((o: { id: number }) => o.id === r.id);
      if (!edit || !item || typeof item.result !== "string") continue;
      const e = edit(item.result as Hex);
      if (typeof e === "string") item.result = e;
      else {
        delete item.result;
        item.error = e.error;
      }
    }
    const body = JSON.stringify(Array.isArray(got) ? outs : outs[0]);
    return {
      ok: true,
      status: 200,
      headers: res.headers,
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}
