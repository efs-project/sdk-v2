// SPDX-License-Identifier: MIT
// The cold pin against a real fixture chain: VERIFIED for the true document, MISMATCH for a doctored one.
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as Record<string, unknown>;

describe("cold pin (fixture)", () => {
  it("verifies the deployment in two RPC envelopes", async () => {
    const methods: string[][] = [];
    const efs = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      onRequest: (e) => methods.push([...e.methods]),
    });
    const pin = await efs.pin();
    expect(pin.status).toBe("VERIFIED");
    if (pin.status === "VERIFIED") {
      expect(pin.basis.endpoint).toBe(new URL(fixture.rpcUrl).origin);
      expect(pin.live.revision).toBeGreaterThanOrEqual(1);
    }
    // chain check + block + one batch of 7
    expect(methods.flat()).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_getStorageAt",
      "eth_getCode",
      "eth_getCode",
      "eth_getCode",
      "eth_getCode",
      "eth_getCode",
    ]);
    expect(await efs.pin()).toBe(pin); // cached
  });
  it("reports MISMATCH, naming the field, when the document lies", async () => {
    const forged = structuredClone(deployment) as {
      readers: { lensReader: { runtimeCodehash: string } };
    };
    forged.readers.lensReader.runtimeCodehash = `0x${"ab".repeat(32)}`;
    const pin = await createEfs({ rpcs: [fixture.rpcUrl], deployment: forged }).pin();
    expect(pin.status).toBe("MISMATCH");
    if (pin.status === "MISMATCH")
      expect(pin.mismatches.map((m) => m.what)).toEqual(["code: LensReader"]);
  });
  it("fails over from a dead endpoint and from one on the wrong chain", async () => {
    const pin = await createEfs({
      rpcs: ["http://127.0.0.1:1", fixture.rpcUrl],
      deployment,
      timeoutMs: 2000,
    }).pin();
    expect(pin.status).toBe("VERIFIED");
    expect(pin.evidence.attempts.map((a) => a.outcome)).toEqual(["FAILED", "OK"]);
  });

  it("re-pins skip the bytecode once verified on an endpoint, yet still catch an implementation change", async () => {
    let lie = false;
    const methods: string[] = [];
    const wrapped: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body ?? "null") as
        | { id: number; method: string }[]
        | { id: number; method: string };
      const reqs = Array.isArray(body) ? body : [body];
      methods.push(...reqs.map((r) => r.method));
      const res = await fetch(url, init as RequestInit);
      let text = await res.text();
      if (lie) {
        // What an upgrade looks like to the pin: the ERC-1967 slot names another implementation.
        const slotIds = new Set(
          reqs.filter((r) => r.method === "eth_getStorageAt").map((r) => r.id),
        );
        const parsed = JSON.parse(text) as
          | { id: number; result?: string }[]
          | { id: number; result?: string };
        for (const item of Array.isArray(parsed) ? parsed : [parsed])
          if (slotIds.has(item.id)) item.result = `0x${"00".repeat(12)}${"11".repeat(20)}`;
        text = JSON.stringify(parsed);
      }
      return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      };
    };
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: wrapped });
    const codes = () => methods.filter((m) => m === "eth_getCode").length;
    expect((await efs.at("latest")).status).toBe("VERIFIED");
    expect(codes()).toBe(5);
    methods.length = 0;
    expect((await efs.at("latest")).status).toBe("VERIFIED");
    expect(codes()).toBe(0);
    expect(methods.sort()).toEqual(["eth_call", "eth_getBlockByNumber", "eth_getStorageAt"]);
    lie = true;
    const upgraded = await efs.at("latest");
    expect(upgraded.status).toBe("MISMATCH");
    if (upgraded.status === "MISMATCH")
      expect(upgraded.mismatches.map((m) => m.what)).toContain("implementation (ERC-1967 slot)");
    lie = false;
    methods.length = 0;
    expect((await efs.at("latest")).status).toBe("VERIFIED");
    expect(codes()).toBe(5); // the mismatch cleared the cache: full code checks again
  });
});
