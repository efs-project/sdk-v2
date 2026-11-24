// SPDX-License-Identifier: MIT
// Caches against the fixture: a second read needs no record calls, a tampered cache is only a miss, and a pin at a
// block the endpoint already verified costs one call.
import { readFileSync } from "node:fs";
import { decodeFunctionData } from "viem";
import { describe, expect, inject, it } from "vitest";
import type { ByteStore } from "../../src/cache/stores.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { SubjectId } from "../../src/core/hex.ts";
import { openFile, readBytes } from "../../src/files/bytes.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { files: { name: string; subjectId: string }[] };
};
const subject = (n: string) =>
  deployment.seed.files.find((f) => f.name === n)?.subjectId as SubjectId;

type Req = { id: number; method: string; params: [{ to?: string; data?: string }, unknown] };
/** A fetch that counts record() reads and can freeze "latest" at the first block it saw. */
function counting(o: { freezeLatest?: boolean } = {}) {
  const stats = { records: 0, methods: [] as string[] };
  let frozen: string | undefined;
  const wrapped: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "null") as Req | Req[];
    const reqs = Array.isArray(body) ? body : [body];
    for (const r of reqs) {
      stats.methods.push(r.method);
      if (r.method === "eth_call" && r.params[0]?.data) {
        try {
          const f = decodeFunctionData({
            abi: ledgerReadsAbi,
            data: r.params[0].data as `0x${string}`,
          });
          if (f.functionName === "record") stats.records++;
        } catch {
          // another contract or function
        }
      }
    }
    const res = await globalThis.fetch(url, init as RequestInit);
    let text = await res.text();
    if (
      o.freezeLatest &&
      reqs.some(
        (r) => r.method === "eth_getBlockByNumber" && (r.params as unknown[])[0] === "latest",
      )
    ) {
      if (frozen === undefined) frozen = text;
      else text = frozen.replace(/"id":\s*\d+/, `"id":${(reqs[0] as Req).id}`);
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { fetch: wrapped, stats };
}

describe("caches (fixture)", () => {
  it("a second read of a span file makes no record calls: every chunk and node comes from the verified cache", async () => {
    const c = counting();
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: c.fetch });
    const o = await openFile(efs, { kind: "file", subject: subject("big.bin") });
    if (o.status !== "PRESENT") throw new Error(o.status);
    const first = await readBytes(efs, o.file);
    expect(first.grade).toBe("VERIFIED");
    const before = c.stats.records;
    expect(before).toBeGreaterThan(0);
    const second = await readBytes(efs, o.file);
    expect(second.bytes).toEqual(first.bytes);
    expect(c.stats.records).toBe(before);
  });

  it("a cache that lies is only a miss: reads stay VERIFIED and fetch the records again", async () => {
    const liar: ByteStore = {
      get: async () => new Uint8Array(64).fill(7),
      put: async () => {},
    };
    const c = counting();
    const efs = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: c.fetch,
      cache: { bytes: liar },
    });
    const o = await openFile(efs, { kind: "file", subject: subject("big.bin") });
    if (o.status !== "PRESENT") throw new Error(o.status);
    const r = await readBytes(efs, o.file);
    expect(r.grade).toBe("VERIFIED");
    expect(c.stats.records).toBeGreaterThan(0);
    const broken: ByteStore = {
      get: async () => {
        throw new Error("disk full");
      },
      put: async () => {
        throw new Error("disk full");
      },
    };
    const e2 = createEfs({ rpcs: [fixture.rpcUrl], deployment, cache: { bytes: broken } });
    const o2 = await openFile(e2, { kind: "file", subject: subject("big.bin") });
    if (o2.status !== "PRESENT") throw new Error(o2.status);
    expect((await readBytes(e2, o2.file)).grade).toBe("VERIFIED"); // a broken cache never fails a read
  });

  it("a pin at a block this endpoint already verified costs one call; a new client verifies in full", async () => {
    const c = counting({ freezeLatest: true });
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: c.fetch });
    expect((await efs.at("latest")).status).toBe("VERIFIED");
    c.stats.methods.length = 0;
    const again = await efs.at("latest");
    expect(again.status).toBe("VERIFIED");
    expect(c.stats.methods).toEqual(["eth_getBlockByNumber"]);
    const fresh = counting({ freezeLatest: true });
    const other = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: fresh.fetch });
    expect((await other.at("latest")).status).toBe("VERIFIED");
    expect(fresh.stats.methods.filter((m) => m === "eth_call").length).toBe(2); // describe() + the code probe
  });
});
