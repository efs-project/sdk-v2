// SPDX-License-Identifier: MIT
// INTERIM (until the contracts' list release prices these shapes in gas/model.json): fresh slots a later BIND writes
// that its row's measurement did not, at the schedule's fresh-slot price (test/vectors/gas-schedules.json), in two
// independent parts (contracts 6d11858, figure (ii)):
//   1. a BIND on a head that never bound (not UNSET, `targetKind` 0) writes head.target fresh in the kernel: one slot
//      in E, one whole slot in the all-gas total, one slot of execution in K;
//   2. a restore that opens the binding's next history word (head revision before it 1 or a multiple of 5) writes one
//      in the index: one slot in E and the total, none in K. The restore rows were measured as a 3rd statement, where
//      no word opens; masks, releases and re-binds were measured as a 2nd, where one does, so they never pay it.
// A yes after a lone no pays both. Checked against the contracts dev's figure (ii) measurements
// (test/integration/LoneNoGas.t.sol), with the author's entry count omitted as the SDK always omits it.
import { describe, expect, it } from "vitest";
import {
  type BindRow,
  budgetOf,
  type GasConstants,
  type GasModel,
  modelGas,
  opensHistoryWord,
  type PlannedAction,
  ruleGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION } from "../src/actions/types.ts";
import { type Hex, ZERO_WORD } from "../src/core/hex.ts";
import { GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";
import { neverBoundHead } from "../src/protocol/status.ts";

const S = GAS_SCHEDULES as unknown as Record<
  string,
  { constants: GasConstants; executionGas?: GasConstants; floor: GasModel["floor"] }
>;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TAG = word(0x7a6);
type Facts = { neverBound?: boolean; headRevision?: bigint; row?: BindRow; kind?: number };
/** k later statements: across places (k subjects) or at one place (one subject, k things). */
const later = (k: number, across: boolean, f: Facts = {}): PlannedAction[] =>
  Array.from({ length: k }, (_, i) => ({
    action: {
      kind: f.kind ?? ACTION.BIND,
      typeId: ZERO_WORD,
      bodyHashOrRecordId: ZERO_WORD,
      purpose: TAG,
      subject: across ? word(1000 + i) : word(1000),
      role: word(5000 + i),
      target: word(5000 + i),
      expectedRevision: f.headRevision ?? 1n,
      saltOrStrength: ZERO_WORD,
    },
    body: "0x",
    bindRow: f.row ?? "restoreTag",
    firstStatement: false,
    ...(f.neverBound ? { neverBound: true } : {}),
    ...(f.headRevision !== undefined ? { headRevision: f.headRevision } : {}),
  }));
/** A yes after a lone no: never bound, after one statement. */
const afterLoneNo: Facts = { neverBound: true, headRevision: 1n };
const modelOf = (schedule: string): GasModel => {
  const s = S[schedule] as (typeof S)[string];
  const exec = s.executionGas ?? s.constants;
  return {
    ...exec,
    schedule,
    ...(s.executionGas ? { total: s.constants } : {}),
    ...(s.floor ? { floor: s.floor } : {}),
  } as GasModel;
};
const P = modelOf("prague");
const A = modelOf("amsterdam");
const T = A.total as GasConstants;
/** What E (prague all gas, amsterdam execution), the amsterdam total and both Ks add over the unmarked statements. */
const extra = (k: number, f: Facts) => {
  const base = later(k, true, {
    ...(f.row ? { row: f.row } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
  });
  const marked = later(k, true, f);
  return {
    E: [modelGas(marked, P) - modelGas(base, P), modelGas(marked, A) - modelGas(base, A)],
    total: modelGas(marked, T) - modelGas(base, T),
    K: [ruleGas(marked, P).K - ruleGas(base, P).K, ruleGas(marked, A).K - ruleGas(base, A).K],
  };
};

// [name, k, across, prague model E, measured, amsterdam execution model E, measured, amsterdam all gas, measured]
const CASES: [string, number, boolean, number, number, number, number, number, number][] = [
  [
    "32 across places, 48 entries",
    32,
    true,
    8_285_547,
    8_219_091,
    8_378_816,
    7_743_769,
    21_518_403,
    23_998_489,
  ],
  [
    "32 at one topic of 48",
    32,
    false,
    7_605_159,
    7_811_115,
    8_004_274,
    7_112_639,
    18_108_341,
    23_367_359,
  ],
  [
    "32 across places, 256 entries",
    32,
    true,
    8_285_547,
    9_262_279,
    8_378_816,
    8_470_023,
    21_518_403,
    27_858_183,
  ],
  [
    "16 across places, 1,025 entries",
    16,
    true,
    4_298_667,
    4_881_729,
    4_334_336,
    4_465_799,
    11_207_043,
    14_453_639,
  ],
  [
    "51 across places, 1,025 entries",
    51,
    true,
    13_019_967,
    15_099_369,
    13_181_636,
    13_860_261,
    33_763_143,
    44_411_301,
  ],
  [
    "51 at one topic of 1,025",
    51,
    false,
    11_922_567,
    13_103_652,
    12_577_536,
    11_959_524,
    28_263_043,
    38_006_244,
  ],
];

describe("INTERIM: fresh slots a later BIND writes beyond its row", () => {
  it("a never-bound head: not UNSET and targetKind 0 (served as stored), at any revision", () => {
    expect(neverBoundHead({ state: 0, targetKind: 0 })).toBe(false); // UNSET: a first statement
    expect(neverBoundHead({ state: 2, targetKind: 0 })).toBe(true); // a lone no, or a no then another no
    expect(neverBoundHead({ state: 3, targetKind: 0 })).toBe(true); // a no then a release
    expect(neverBoundHead({ state: 2, targetKind: 3 })).toBe(false); // a yes then a mask: the stored target is kept
    expect(neverBoundHead({ state: 3, targetKind: 1 })).toBe(false); // a yes then a release
    expect(neverBoundHead({ state: 7, targetKind: 0n })).toBe(true); // unrecognized: the dearer reading
  });

  it("a history word opens after 1 statement, then after every multiple of 5, forever", () => {
    const opens = Array.from({ length: 32 }, (_, r) => r).filter((r) =>
      opensHistoryWord(BigInt(r)),
    );
    expect(opens).toEqual([1, 5, 10, 15, 20, 25, 30]);
    expect(opensHistoryWord(1_000_000_000_000_000n)).toBe(true);
  });

  it("the prices are the schedule's fresh slot: E and the total pay each part, K only the kernel's", () => {
    expect([P.interimNeverBoundBind, P.interimHistoryWord]).toEqual([22_100, 22_100]);
    expect([P.floor?.kernel.interimNeverBoundBind, P.floor?.kernel.interimHistoryWord]).toEqual([
      22_100, 0,
    ]);
    expect([A.interimNeverBoundBind, A.interimHistoryWord]).toEqual([12_100, 12_100]);
    expect([T.interimNeverBoundBind, T.interimHistoryWord]).toEqual([110_020, 110_020]);
    expect([A.floor?.kernel.interimNeverBoundBind, A.floor?.kernel.interimHistoryWord]).toEqual([
      12_100, 0,
    ]);
  });

  it("the parts, one at a time", () => {
    const k = 10;
    // A yes after a lone no (revision 1, never bound): both.
    expect(extra(k, afterLoneNo)).toEqual({
      E: [k * 44_200, k * 24_200],
      total: k * 220_040,
      K: [k * 22_100, k * 12_100],
    });
    // A no, a release, then a yes (revision 2, never bound): the kernel's slot only.
    expect(extra(k, { neverBound: true, headRevision: 2n })).toEqual({
      E: [k * 22_100, k * 12_100],
      total: k * 110_020,
      K: [k * 22_100, k * 12_100],
    });
    // A yes, a mask, a restore, a mask, then a restore (revision 5, bound before): the history word only.
    expect(extra(k, { headRevision: 5n })).toEqual({
      E: [k * 22_100, k * 12_100],
      total: k * 110_020,
      K: [0, 0],
    });
    // A restore that opens no word, and masks, releases and re-binds anywhere (measured where one opened): nothing.
    expect(extra(k, { headRevision: 3n })).toEqual({ E: [0, 0], total: 0, K: [0, 0] });
    for (const [row, kind] of [
      ["unbindTag", ACTION.UNBIND],
      ["releaseTag", ACTION.RELEASE],
      ["bindTagNumberChange", ACTION.BIND],
      ["bindFolderRebind", ACTION.BIND],
    ] as const)
      expect(extra(k, { row, kind, headRevision: 5n }), row).toEqual({
        E: [0, 0],
        total: 0,
        K: [0, 0],
      });
    // Every restore row and its tiers (the folder, same and broader restores too).
    for (const row of ["restoreFolder", "restoreSame", "restoreBroader"] as const)
      expect(extra(k, { row, headRevision: 10n }).E, row).toEqual([k * 22_100, k * 12_100]);
  });

  for (const [name, k, across, pE, pM, aE, aM, aT, aTM] of CASES) {
    it(`${name}: E before the rule is the contracts' model E; with it, never more than 2% under measured`, () => {
      expect(modelGas(later(k, across), P)).toBe(pE);
      expect(modelGas(later(k, across), A)).toBe(aE);
      expect(modelGas(later(k, across), T)).toBe(aT);
      const withP = modelGas(later(k, across, afterLoneNo), P);
      const withA = modelGas(later(k, across, afterLoneNo), A);
      const withT = modelGas(later(k, across, afterLoneNo), T);
      expect([withP - pE, withA - aE, withT - aT]).toEqual([k * 44_200, k * 24_200, k * 220_040]);
      expect(withP).toBeGreaterThanOrEqual(0.98 * pM);
      expect(withA).toBeGreaterThanOrEqual(0.98 * aM);
      expect(withT).toBeGreaterThanOrEqual(0.98 * aTM);
    });
  }

  it("the largest planned batch of a yes after a lone no fits the budget: 51 before the rule, 46 prague and 48 amsterdam", () => {
    const budget = budgetOf(BigInt(GAS_PLANNING.txGasCap), GAS_PLANNING.headroomPercent / 100);
    const limits = {
      maxActionsPerPublication: GAS_PLANNING.limits.maxActions,
      maxBindsPerPublication: GAS_PLANNING.limits.maxBindsPerPublication,
      maxBodyBytesPerPublication: GAS_PLANNING.limits.maxBodyBytesPerPublication,
      maxBodyBytes: 8192,
    };
    const sizes: Record<string, [number, number]> = {};
    for (const [schedule, m] of [
      ["prague", P],
      ["amsterdam", A],
    ] as const) {
      const first = (f: Facts) => {
        const all = later(64, true, f).map((a, i) => ({ ...a, group: i }));
        const r = splitPublications(all, {
          model: m,
          limits,
          txGasCap: BigInt(GAS_PLANNING.txGasCap),
        });
        if (!r.ok) throw new Error(r.reason.code);
        const part = r.parts[0];
        if (!part) throw new Error("no part");
        expect(Math.max(part.rule.E, part.rule.V)).toBeLessThanOrEqual(budget);
        return part.actions.length;
      };
      sizes[schedule] = [first({}), first(afterLoneNo)];
    }
    expect(sizes).toEqual({ prague: [51, 46], amsterdam: [51, 48] });
  });

  it("the gas model has no rows for these shapes yet: this fails once the list release adds them (then drop the rule)", () => {
    const named = (c: GasConstants) =>
      Object.keys(c).filter(
        (k) =>
          /lone|afterNo|yesAfter|neverBound|history/i.test(k) &&
          k !== "unbindTagLone" &&
          !k.startsWith("interim"),
      );
    for (const s of Object.values(S)) {
      expect(named(s.constants)).toEqual([]);
      if (s.executionGas) expect(named(s.executionGas)).toEqual([]);
      if (s.floor) expect(named(s.floor.kernel)).toEqual([]);
    }
  });
});
