// SPDX-License-Identifier: MIT
// The planning headroom must cover what the gas model leaves out: the 21,000 intrinsic cost, calldata (EIP-2028 /
// EIP-7623) and the model's own error (gas/model.json planning.headroomCovers). A part is planned with
// E ≤ ⌊txGasCap × (100 − headroomPercent) / 100⌋. Per the EIP texts (contracts dev, 2026-11-26: EIP-8037 Last Call,
// EIP-7825 and EIP-7623 Final), intrinsic gas and calldata count against the 2^24 cap on every schedule (the
// execution budget is TX_MAX_GAS_LIMIT − intrinsic), and EIP-7623's floor is a separate condition. So, for the largest
// calldata a part can carry (maxActions actions and maxBodyBytesPerPublication of bodies, encoded as `execute`, every
// byte nonzero: 39,236 bytes today):
//   intrinsic = 21000 + 16 × bytes (4 per zero byte, 16 per nonzero byte)
//   intrinsic + E × (1 + maxAbsErrorPercent / 100) ≤ 0.999 × cap      the execution budget, with 0.1% to spare
//   max(intrinsic, 21000 + 10 × tokens) ≤ cap                          the floor, tokens = 4 × bytes
// on every schedule of the vendored model. When the re-fit raises an error figure, this fails at once and names
// the headroom that schedule needs.
import { encodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { ledgerAbi } from "../src/generated/abis.ts";
import { GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";

const INTRINSIC = 21_000;
const STANDARD_PER_TOKEN = 4; // EIP-7623 STANDARD_TOKEN_COST: 16 per nonzero byte
const FLOOR_PER_TOKEN = 10; // EIP-7623 TOTAL_COST_FLOOR_PER_TOKEN
const TOKENS_PER_BYTE = 4; // a nonzero byte (the worst case)
const LIMIT = 0.999; // of the cap

/** The largest calldata a planned part can carry: every action and body field at its widest, every byte nonzero. */
function worstCalldataBytes(): number {
  const execute = (ledgerAbi as readonly { name?: string }[]).find(
    (x) => x.name === "execute",
  ) as unknown as {
    inputs: { components?: { name: string; type: string }[] }[];
  };
  const widest = (type: string) =>
    type.startsWith("uint")
      ? (1n << BigInt(Number(type.slice(4)) || 256)) - 1n
      : `0x${"ff".repeat(32)}`;
  const tuple = (i: number) =>
    Object.fromEntries((execute.inputs[i]?.components ?? []).map((c) => [c.name, widest(c.type)]));
  const n = GAS_PLANNING.limits.maxActions;
  const per = Math.floor(GAS_PLANNING.limits.maxBodyBytesPerPublication / n);
  const data = encodeFunctionData({
    abi: ledgerAbi,
    functionName: "execute",
    args: [Array(n).fill(tuple(0)), Array(n).fill(`0x${"ff".repeat(per)}`), tuple(2), "0x"],
  } as never);
  return (data.length - 2) / 2;
}

type Schedules = Record<string, { maxAbsErrorPercent: number }>;

/** Per schedule: the worst part's gas as a fraction of the cap, the floor's, and the headroom that keeps it in LIMIT. */
function headroomCheck(schedules: Schedules, headroomPercent: number) {
  const cap = GAS_PLANNING.txGasCap;
  const tokens = TOKENS_PER_BYTE * worstCalldataBytes();
  const intrinsic = INTRINSIC + STANDARD_PER_TOKEN * tokens;
  const floor = INTRINSIC + FLOOR_PER_TOKEN * tokens;
  const budget = Math.floor((cap * (100 - headroomPercent)) / 100);
  return Object.entries(schedules).map(([schedule, s]) => {
    const err = s.maxAbsErrorPercent / 100;
    const room = (LIMIT * cap - intrinsic) / (1 + err);
    return {
      schedule,
      maxAbsErrorPercent: s.maxAbsErrorPercent,
      fraction: (intrinsic + budget * (1 + err)) / cap,
      floorFits: Math.max(intrinsic, floor) <= cap,
      neededPercent: Math.ceil(1000 * (1 - room / cap)) / 10,
    };
  });
}
const failures = (schedules: Schedules, headroomPercent: number) =>
  headroomCheck(schedules, headroomPercent).flatMap((r) => [
    ...(r.fraction > LIMIT
      ? [
          `${r.schedule}: with maxAbsErrorPercent ${r.maxAbsErrorPercent}%, the worst part reaches ${(r.fraction * 100).toFixed(2)}% of the cap; headroomPercent must be at least ${r.neededPercent}% (it is ${headroomPercent}%)`,
        ]
      : []),
    ...(r.floorFits
      ? []
      : [`${r.schedule}: the EIP-7623 floor of the worst calldata is over the cap`]),
  ]);

describe("the planning headroom covers intrinsic gas, calldata and the model's error", () => {
  it("on every schedule of the vendored model", () => {
    expect(failures(GAS_SCHEDULES as unknown as Schedules, GAS_PLANNING.headroomPercent)).toEqual(
      [],
    );
    const amsterdam = headroomCheck(
      GAS_SCHEDULES as unknown as Schedules,
      GAS_PLANNING.headroomPercent,
    ).find((r) => r.schedule === "amsterdam");
    expect(amsterdam?.fraction).toBeLessThan(0.96); // 0.953 at contracts cbf5b78 (7.56%)
  });

  it("an error figure the headroom can't cover fails, naming the schedule and the headroom it needs", () => {
    const worse = {
      ...(GAS_SCHEDULES as unknown as Schedules),
      amsterdam: { maxAbsErrorPercent: 13 },
    };
    const f = failures(worse, GAS_PLANNING.headroomPercent);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/^amsterdam: .* headroomPercent must be at least 15\.\d% \(it is 15%\)$/);
  });

  it("the worst calldata is every action and body at its widest (39,236 bytes at contracts cbf5b78)", () => {
    expect(worstCalldataBytes()).toBe(39_236);
  });
});
