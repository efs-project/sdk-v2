// SPDX-License-Identifier: MIT
// A hostile ERC-5219 contract, played by a fake RPC endpoint: it can never turn one read into an unbounded number
// of eth_calls, nor make the SDK buffer more than the client's cap, whatever the file claims about itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain/rpc.ts";
import { createEfs } from "../src/client.ts";
import type { Hex, RecordId, SubjectId } from "../src/core/hex.ts";
import { type OpenedFile, readBytes } from "../src/files/bytes.ts";
import { unverifiedChunks } from "../src/files/unverified.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as { chainId: number };
const abi = parseAbi([
  "function resolveMode() view returns (bytes32)",
  "function request(string[] resource, (string key, string value)[] params) view returns (uint16 statusCode, bytes body, (string key, string value)[] headers)",
]);
const HOSTILE = "0x00000000000000000000000000000000000000aa";

/** A JSON-RPC endpoint whose only contract answers every request with `chunk` bytes and a next-chunk header. */
function hostile(chunkBytes: number) {
  let calls = 0;
  const answer = (req: { id: number; method: string; params: unknown[] }) => {
    if (req.method === "eth_chainId") return `0x${deployment.chainId.toString(16)}`;
    if (req.method === "eth_getBlockByNumber")
      return {
        number: "0x10",
        hash: `0x${"bb".repeat(32)}`,
        timestamp: "0x1",
        parentHash: `0x${"aa".repeat(32)}`,
      };
    if (req.method === "eth_call") {
      calls++;
      const { data } = req.params[0] as { data: Hex };
      const f = decodeFunctionData({ abi, data });
      if (f.functionName === "resolveMode")
        return encodeFunctionResult({
          abi,
          functionName: "resolveMode",
          result: `0x35323139${"0".repeat(56)}`,
        });
      const offset = Number(
        (f.args[1] as { key: string; value: string }[]).find((p) => p.key === "offset")?.value ?? 0,
      );
      return encodeFunctionResult({
        abi,
        functionName: "request",
        result: [
          200,
          `0x${"ab".repeat(chunkBytes)}`,
          [{ key: "web3-next-chunk", value: `/f?offset=${offset + chunkBytes}` }],
        ],
      });
    }
    return null;
  };
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body ?? "null");
    const reqs = Array.isArray(body) ? body : [body];
    const out = reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) }));
    const text = JSON.stringify(Array.isArray(body) ? out : out[0]);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch, calls: () => calls };
}

const file = (size: bigint): OpenedFile => ({
  file: `0x${"01".repeat(32)}` as SubjectId,
  revision: `0x${"02".repeat(32)}` as RecordId,
  author: null,
  size,
  sha256: `0x${"cc".repeat(32)}` as Hex,
  layout: "external",
  locations: [{ scheme: "web3", uri: `web3://${HOSTILE}:${deployment.chainId}/f` }],
});

describe("web3:// reads against a hostile contract", () => {
  it("tiny chunks are refused at once, not followed (no eth_call amplification)", async () => {
    const h = hostile(1);
    const r = await readBytes(
      createEfs({ rpcs: ["https://rpc.example/"], deployment, fetch: h.fetch }),
      file(10n ** 12n),
      {
        maxBytes: 10n ** 13n,
      },
    );
    expect(r.grade).toBe("UNAVAILABLE");
    expect(r.attempts[0]?.detail).toMatch(/carried 1 bytes/);
    expect(h.calls()).toBeLessThanOrEqual(2); // resolveMode + the first request
  });

  it("big chunks forever stop at the client's byte cap, never at the size the file claims", async () => {
    const h = hostile(4096);
    const efs = createEfs({ rpcs: ["https://rpc.example/"], deployment, fetch: h.fetch });
    const r = await readBytes(efs, file(10n ** 9n), { maxBytes: 64n * 1024n });
    // A file claiming more than the cap is refused before a single call.
    expect(r.grade).toBe("UNAVAILABLE");
    expect(r.reason?.code).toBe("TOO_LARGE");
    expect(h.calls()).toBe(0);
    const within = await readBytes(efs, file(60n * 1024n), { maxBytes: 64n * 1024n });
    expect(within.attempts[0]).toMatchObject({
      outcome: "MISMATCH",
      detail: expect.stringMatching(/longer than/),
    });
    expect(h.calls()).toBeLessThanOrEqual(18);
  });

  it("the unverified stream is bounded by the client's cap too, not by the declared size", async () => {
    const h = hostile(4096);
    const efs = createEfs({
      rpcs: ["https://rpc.example/"],
      deployment,
      fetch: h.fetch,
      gateways: { maxBytes: 64n * 1024n },
    });
    const it = unverifiedChunks(efs, file(10n ** 12n));
    await expect(it.next()).rejects.toThrow(/STREAM_FAILED|stream stopped/);
    expect((await it.result).attempts[0]).toMatchObject({ outcome: "TOO_LARGE" });
    expect(h.calls()).toBe(0);
  });
});
