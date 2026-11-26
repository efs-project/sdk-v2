// SPDX-License-Identifier: MIT
// The floor prices the SDK plans with are the fee schedules' own storage prices (contracts
// test/vectors/gas-schedules.json, from tools/deploy-plan.mjs GAS_SCHEDULES): floorFreshGas = a fresh slot's
// execution gas, floorRewriteGas = a cold rewrite's, on every schedule the vendored model has. On amsterdam both are
// 12,100 (EIP-8037); on prague 22,100 and 5,000.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GAS_SCHEDULES } from "../src/generated/gas.ts";

const vectors = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../protocol-inputs/contracts/test/vectors/gas-schedules.json"),
    "utf8",
  ),
) as {
  schedules: Record<
    string,
    { freshSlot: { executionGas: number }; rewriteColdSlot: { executionGas: number } }
  >;
};

describe("the floor prices are the fee schedules' storage prices", () => {
  const schedules = GAS_SCHEDULES as unknown as Record<
    string,
    { floor?: { limits: { floorFreshGas: number; floorRewriteGas: number } } }
  >;
  for (const [name, s] of Object.entries(schedules))
    it(name, () => {
      const v = vectors.schedules[name];
      if (!v) throw new Error(`gas-schedules.json has no ${name}`);
      expect(s.floor?.limits).toMatchObject({
        floorFreshGas: v.freshSlot.executionGas,
        floorRewriteGas: v.rewriteColdSlot.executionGas,
      });
    });

  it("amsterdam's rewrite price is 12,100 (it was 5,000 before contracts 3ca53ba)", () => {
    expect(schedules["amsterdam"]?.floor?.limits.floorRewriteGas).toBe(12_100);
    expect(schedules["prague"]?.floor?.limits.floorRewriteGas).toBe(5_000);
  });
});
