// SPDX-License-Identifier: MIT
// The planning headroom must cover what the gas model leaves out: the 21,000 intrinsic cost, calldata (EIP-2028 /
// EIP-7623) and the model's own error (gas/model.json planning.headroomCovers): its largest UNDER-prediction (predicted
// below measured; an over-prediction plans less than the cap allows, never more) of the gas the cap counts: all gas on
// prague (maxUnderErrorPercent), execution gas only on amsterdam (maxUnderExecutionErrorPercent; its all-gas figures
// bound the total against the block, never the 2^24 cap). Contracts 6d11858 tools/RELEASE.md item 47. A part is planned with
// E ≤ ⌊txGasCap × (100 − headroomPercent) / 100⌋. Per the EIP texts (contracts dev, 2026-11-26: EIP-8037 Last Call,
// EIP-7825 and EIP-7623 Final), intrinsic gas and calldata count against the 2^24 cap on every schedule (the
// execution budget is TX_MAX_GAS_LIMIT − intrinsic), and EIP-7623's floor is a separate condition. So, for the largest
// calldata a part can carry (maxActions actions and maxBodyBytesPerPublication of bodies, encoded as `execute`, every
// byte nonzero: 39,236 bytes today):
//   intrinsic = 21000 + 16 × bytes (4 per zero byte, 16 per nonzero byte)
//   intrinsic + E × (1 + capError / 100) ≤ 0.999 × cap      the execution budget, with 0.1% to spare
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

type Schedules = Record<
  string,
  {
    maxAbsErrorPercent: number;
    maxAbsExecutionErrorPercent?: number;
    maxUnderErrorPercent: number;
    maxUnderExecutionErrorPercent?: number;
  }
>;
/** The error the cap condition is tested against: the under-prediction of execution gas where the cap counts only it. */
const capError = (s: Schedules[string]): number =>
  s.maxUnderExecutionErrorPercent ?? s.maxUnderErrorPercent;

/** Per schedule: the worst part's gas as a fraction of the cap, the floor's, and the headroom that keeps it in LIMIT. */
function headroomCheck(schedules: Schedules, headroomPercent: number) {
  const cap = GAS_PLANNING.txGasCap;
  const tokens = TOKENS_PER_BYTE * worstCalldataBytes();
  const intrinsic = INTRINSIC + STANDARD_PER_TOKEN * tokens;
  const floor = INTRINSIC + FLOOR_PER_TOKEN * tokens;
  const budget = Math.floor((cap * (100 - headroomPercent)) / 100);
  return Object.entries(schedules).map(([schedule, s]) => {
    const err = capError(s) / 100;
    const room = (LIMIT * cap - intrinsic) / (1 + err);
    return {
      schedule,
      capErrorPercent: capError(s),
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
          `${r.schedule}: with a cap error of ${r.capErrorPercent}%, the worst part reaches ${(r.fraction * 100).toFixed(2)}% of the cap; headroomPercent must be at least ${r.neededPercent}% (it is ${headroomPercent}%)`,
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
    const at = (name: string) =>
      headroomCheck(GAS_SCHEDULES as unknown as Schedules, GAS_PLANNING.headroomPercent).find(
        (r) => r.schedule === name,
      );
    // Tripwires on the spare, one per schedule, never raised: when one fires, report the figure and the headroom
    // needed. Either fires once its under-prediction passes 10.74%. At contracts 19891fe (the guard release), as at
    // 04526b1 (the list release): prague
    // 0.9710 (9.68%, tag releases at entry 47 across topics; headroom needed 12.5%), amsterdam 0.9781 (10.52% of
    // execution gas, create file lists exist; needed 13.2%), 0.22 points from firing. At 6d11858 they were 0.9710
    // (9.69%) and 0.9792 (10.65%); at 3ca53ba amsterdam was 0.9789 (10.62%).
    expect(at("prague")?.fraction).toBeCloseTo(0.971, 3);
    expect(at("amsterdam")?.fraction).toBeCloseTo(0.9781, 4);
    expect([at("prague")?.neededPercent, at("amsterdam")?.neededPercent]).toEqual([12.5, 13.2]);
    expect(at("prague")?.fraction).toBeLessThan(0.98);
    expect(at("amsterdam")?.fraction).toBeLessThan(0.98);
  });

  it("an error figure the headroom can't cover fails, naming the schedule and the headroom it needs", () => {
    const worse = {
      ...(GAS_SCHEDULES as unknown as Schedules),
      amsterdam: {
        maxAbsErrorPercent: 30,
        maxAbsExecutionErrorPercent: 30,
        maxUnderErrorPercent: 30,
        maxUnderExecutionErrorPercent: 13,
      },
    };
    const f = failures(worse, GAS_PLANNING.headroomPercent);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/^amsterdam: .* headroomPercent must be at least 15\.\d% \(it is 15%\)$/);
  });

  it("the cap is tested against the under-prediction of the gas it counts, never an over-prediction or the all-gas figure", () => {
    const vendored = GAS_SCHEDULES as unknown as Schedules;
    // contracts 19891fe (gas/model.json; release.json carries the maxAbs figures, codegen adds the maxUnder ones). The
    // guard release moved amsterdam's all-gas under-prediction 6.63 -> 6.62; nothing else here moved.
    // Since the list release maxAbs is the larger of under- and over-prediction: amsterdam's 18.42 is an
    // over-prediction of all gas (tag restores at revision 5), which plans below the cap, never above it.
    expect(vendored["amsterdam"]).toMatchObject({
      maxUnderExecutionErrorPercent: 10.52,
      maxUnderErrorPercent: 6.62,
      maxAbsExecutionErrorPercent: 13.89, // an over-prediction: plans below the cap, never above it
      maxAbsErrorPercent: 18.42,
    });
    expect(vendored["prague"]).toMatchObject({
      maxUnderErrorPercent: 9.68,
      maxAbsErrorPercent: 11.15,
    });
    // Figures far over the headroom change nothing while the under-prediction the cap counts fits.
    const others = {
      ...vendored,
      amsterdam: {
        maxAbsErrorPercent: 40,
        maxAbsExecutionErrorPercent: 40,
        maxUnderErrorPercent: 40,
        maxUnderExecutionErrorPercent: 10.52,
      },
      prague: { maxAbsErrorPercent: 40, maxUnderErrorPercent: 9.68 },
    };
    expect(failures(others, GAS_PLANNING.headroomPercent)).toEqual([]);
    // prague has all-gas figures only (its cap counts all gas).
    expect(vendored["prague"]?.maxUnderExecutionErrorPercent).toBeUndefined();
  });

  it("the worst calldata is every action and body at its widest (39,236 bytes at contracts 19891fe, unguarded)", () => {
    expect(worstCalldataBytes()).toBe(39_236);
  });
});
