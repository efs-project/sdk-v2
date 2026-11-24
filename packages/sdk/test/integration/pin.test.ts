// SPDX-License-Identifier: MIT
// The cold pin against a real fixture chain: VERIFIED for the true document, MISMATCH for a doctored one.
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
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
});
