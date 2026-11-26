// SPDX-License-Identifier: MIT
// The fee-schedule check's classification (src/actions/schedule.ts): a fresh slot's measured price belongs to a known
// schedule only inside its band, the bands never overlap, and anything outside every band is no schedule, never a
// guess. The probe's bytes are its opcodes. The check against a chain is tested on the fixture
// (test/integration/fee-schedule.test.ts).
import { describe, expect, it } from "vitest";
import { classifySchedule, SCHEDULE_PROBE, scheduleBands } from "../src/actions/schedule.ts";
import { FRESH_SLOT_GAS } from "../src/generated/gas.ts";

describe("classifying a measured fresh-slot price", () => {
  it("prague's 22,100 and amsterdam's 110,020 (each plus the probe's 8) are their schedules", () => {
    expect(FRESH_SLOT_GAS).toEqual({ prague: 22_100, amsterdam: 110_020 });
    expect(classifySchedule(22_108n)).toBe("prague");
    expect(classifySchedule(110_028n)).toBe("amsterdam");
    // The contracts dev's measurement on Sepolia through a probe loop (110,068) is still amsterdam.
    expect(classifySchedule(110_068n)).toBe("amsterdam");
  });

  it("outside every band is no schedule (UNKNOWN), never the nearest", () => {
    for (const m of [0n, 2_108n, 12_108n, 60_000n, 200_000n])
      expect(classifySchedule(m)).toBeNull();
  });

  it("the bands never overlap", () => {
    const b = [...scheduleBands()].sort((x, y) => (x.low < y.low ? -1 : 1));
    for (let i = 1; i < b.length; i++)
      expect((b[i] as { low: bigint }).low > (b[i - 1] as { high: bigint }).high).toBe(true);
  });

  it("the probe is GAS, a fresh SSTORE, GAS, the difference returned as one word", () => {
    expect(SCHEDULE_PROBE).toBe("0x5a60016000555a900360005260206000f3");
  });
});
