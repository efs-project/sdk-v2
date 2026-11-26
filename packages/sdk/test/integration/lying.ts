// SPDX-License-Identifier: MIT
// A client on the fixture's own endpoint whose replies to one contract function are decoded, edited and encoded
// again: an endpoint that lies about exactly one thing. The read-validation tests use it to show each guard is what
// stops a forged reply (each guard removed, its test fails).
import { decodeFunctionResult, encodeFunctionResult, toFunctionSelector } from "viem";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs, type Efs } from "../../src/client.ts";
import type { Hex } from "../../src/core/hex.ts";

export function lyingEfs(
  rpcUrl: string,
  deployment: unknown,
  abi: readonly unknown[],
  functionName: string,
  edit: (outputs: unknown[]) => unknown[],
  /** Forge only the calls whose calldata this accepts (default: every call to the function). */
  when: (calldata: string) => boolean = () => true,
): Efs {
  const item = (abi as { type: string; name?: string }[]).find(
    (x) => x.type === "function" && x.name === functionName,
  );
  if (!item) throw new Error(`no ${functionName} in the ABI`);
  const selector = toFunctionSelector(item as never);
  const lying: FetchLike = async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    const body = JSON.parse(init.body ?? "null");
    const json = await res.json();
    const reqs = (Array.isArray(body) ? body : [body]) as {
      id: number;
      method: string;
      params: [{ data?: string }];
    }[];
    const ids = new Set(
      reqs
        .filter(
          (r) =>
            r.method === "eth_call" &&
            r.params[0]?.data?.startsWith(selector) &&
            when(r.params[0].data),
        )
        .map((r) => r.id),
    );
    for (const o of (Array.isArray(json) ? json : [json]) as { id: number; result?: Hex }[])
      if (ids.has(o.id) && typeof o.result === "string") {
        const got = decodeFunctionResult({
          abi: abi as never,
          functionName,
          data: o.result,
        } as never);
        const out = Array.isArray(got) ? [...got] : [got];
        const edited = edit(out);
        o.result = encodeFunctionResult({
          abi: abi as never,
          functionName,
          result: (out.length === 1 ? edited[0] : edited) as never,
        } as never);
      }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as never;
  };
  return createEfs({ rpcs: [rpcUrl], deployment, fetch: lying });
}
