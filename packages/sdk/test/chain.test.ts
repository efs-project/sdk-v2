// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { createPool, onEndpoint } from "../src/chain/pool.ts";
import { endpointOrigin, type FetchLike, httpPort, type RpcPort } from "../src/chain/rpc.ts";

/** A fake port: `chain` is its chain id; `fail` makes every non-chainId call a transport failure. */
function fakePort(label: string, chain: number, fail = false): RpcPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    label,
    calls,
    async send(requests) {
      return requests.map((r) => {
        calls.push(r.method);
        if (r.method === "eth_chainId") return { ok: true, result: `0x${chain.toString(16)}` };
        if (fail)
          return {
            ok: false,
            kind: "transport",
            reason: { code: "RPC_UNAVAILABLE", retry: "transient" },
          };
        return { ok: true, result: "0x01" };
      });
    },
  };
}

describe("endpoint pool", () => {
  it("fails over in order and records every attempt", async () => {
    const a = fakePort("a", 1, true);
    const b = fakePort("b", 1);
    const pool = createPool(1, [a, b]);
    const r = await onEndpoint(pool, async (s) => {
      const out = await s.request("eth_blockNumber", []);
      return out.ok
        ? { ok: true, value: out.result }
        : { ok: false, retryElsewhere: true, reason: out.reason };
    });
    expect(r.ok && r.value).toBe("0x01");
    expect(r.ok && r.endpoint).toBe("b");
    expect(r.attempts.map((x) => [x.endpoint, x.outcome])).toEqual([
      ["a", "FAILED"],
      ["b", "OK"],
    ]);
  });
  it("never reads from an endpoint on another chain", async () => {
    const wrong = fakePort("wrong", 5);
    const right = fakePort("right", 1);
    const pool = createPool(1, [wrong, right]);
    const r = await onEndpoint(pool, async () => ({ ok: true, value: 1 }));
    expect(r.ok && r.endpoint).toBe("right");
    expect(r.attempts[0]?.reason?.code).toBe("CHAIN_MISMATCH");
    expect(wrong.calls).toEqual(["eth_chainId"]);
  });
  it("stops on a non-retryable failure", async () => {
    const pool = createPool(1, [fakePort("a", 1), fakePort("b", 1)]);
    const r = await onEndpoint(pool, async () => ({
      ok: false,
      retryElsewhere: false,
      reason: { code: "X", retry: "never" },
    }));
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(1);
  });
});

describe("http port", () => {
  it("labels endpoints by origin only, dropping credentials, paths and queries", () => {
    expect(endpointOrigin("https://user:secret@Eth.Example.org/v2/KEY123?apikey=x")).toBe(
      "https://eth.example.org",
    );
    expect(endpointOrigin("http://127.0.0.1:8545")).toBe("http://127.0.0.1:8545");
  });
  it("batches requests into one envelope and maps results by id", async () => {
    const bodies: unknown[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const reqs = JSON.parse(init.body ?? "[]") as { id: number; method: string }[];
      bodies.push(reqs);
      const out = reqs
        .reverse()
        .map((r) =>
          r.method === "bad"
            ? { id: r.id, error: { code: -32601, message: "nope" } }
            : { id: r.id, result: r.method },
        );
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(out),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const events: string[][] = [];
    const port = httpPort("https://node.example/key", {
      fetch,
      onRequest: (e) => events.push([...e.methods]),
    });
    const [x, y] = await port.send(
      [
        { method: "m1", params: [] },
        { method: "bad", params: [] },
      ],
      { timeoutMs: 1000 },
    );
    expect(x).toEqual({ ok: true, result: "m1" });
    expect(y?.ok === false && y.kind).toBe("rpc");
    expect(bodies).toHaveLength(1);
    expect(events).toEqual([["m1", "bad"]]);
    expect(port.label).toBe("https://node.example");
  });
  it("splits a read larger than the endpoint's batch into consecutive batches, results in the order asked", async () => {
    const sizes: number[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const sent = JSON.parse(init.body ?? "[]");
      const list = Array.isArray(sent) ? sent : [sent];
      sizes.push(list.length);
      const out = list.map((r: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: r.method,
      }));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(Array.isArray(sent) ? out : out[0]),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const requests = Array.from({ length: 95 }, (_, i) => ({ method: `m${i}`, params: [] }));
    const byDefault = await httpPort("https://node.example", { fetch }).send(requests, {
      timeoutMs: 1000,
    });
    expect(sizes).toEqual([40, 40, 15]); // DEFAULT_MAX_BATCH
    expect(byDefault.map((r) => r.ok && r.result)).toEqual(requests.map((r) => r.method));
    sizes.length = 0;
    await httpPort("https://node.example", { fetch, maxBatch: 50 }).send(requests, {
      timeoutMs: 1000,
    });
    expect(sizes).toEqual([50, 45]);
    expect(() => httpPort("https://node.example", { fetch, maxBatch: 0 })).toThrow(/maxBatch/);
  });
  it("turns a timeout into a transport failure", async () => {
    const fetch: FetchLike = () => new Promise(() => {});
    const port = httpPort("https://slow.example", { fetch });
    const [r] = await port.send([{ method: "m", params: [] }], { timeoutMs: 20 });
    expect(r?.ok === false && r.kind).toBe("transport");
  });
});
