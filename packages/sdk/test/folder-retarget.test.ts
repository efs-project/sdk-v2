// SPDX-License-Identifier: MIT
// INTERIM (until the contracts' list release measures restoreFolder with a new target): a FOLDER BIND on a masked or
// released head that bound before (a new file placed at a removed name, a move into one) makes the kernel rewrite
// head.target (LedgerApply), which the restoreFolder rows leave out. K pays one rewrite at the floor's price
// (floorRewriteGas: 5,000 prague, 12,100 amsterdam); E, which over-predicts this shape, pays nothing. Checked on the
// two shapes the folder planners build at removed names (no name PUBLISH: the name record exists), at their largest.
import { describe, expect, it } from "vitest";
import {
  type BindRow,
  budgetOf,
  type GasConstants,
  type GasModel,
  type PlannedAction,
  ruleGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION } from "../src/actions/types.ts";
import { type Hex, ZERO_WORD } from "../src/core/hex.ts";
import { PURPOSES } from "../src/generated/constants.ts";
import { GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";

const S = GAS_SCHEDULES as unknown as Record<
  string,
  { constants: GasConstants; executionGas?: GasConstants; floor: GasModel["floor"] }
>;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const modelOf = (schedule: string, term = true): GasModel => {
  const s = S[schedule] as (typeof S)[string];
  const f = s.floor as NonNullable<GasModel["floor"]>;
  return {
    ...(s.executionGas ?? s.constants),
    schedule,
    ...(s.executionGas ? { total: s.constants } : {}),
    floor: term ? f : { ...f, kernel: { ...f.kernel, interimFolderRetarget: 0 } },
  } as GasModel;
};
const plain = (
  kind: number,
  over: Partial<PlannedAction> = {},
  fields: Record<string, unknown> = {},
) =>
  ({
    action: {
      kind,
      typeId: ZERO_WORD,
      bodyHashOrRecordId: ZERO_WORD,
      purpose: ZERO_WORD,
      subject: ZERO_WORD,
      role: ZERO_WORD,
      target: ZERO_WORD,
      expectedRevision: 0n,
      saltOrStrength: ZERO_WORD,
      ...fields,
    },
    body: "0x",
    ...over,
  }) as PlannedAction;
const SRC = word(0x51c);
const DEST = word(0xde5);
/** A FOLDER BIND at a removed name in DEST (bound before: a restoreFolder row, revision 2). */
const placeAgain = (i: number, row: BindRow = "restoreFolder", neverBound = false) =>
  plain(
    ACTION.BIND,
    {
      bindRow: row,
      firstStatement: false,
      headRevision: 2n,
      ...(neverBound ? { neverBound: true } : {}),
    },
    { purpose: PURPOSES.folder, subject: DEST, role: word(i), target: word(0x7000 + i) },
  );
/** planMoveEntries into removed names: the RELEASE at the old name, then the BIND at the new. */
const moves = (k: number) =>
  Array.from({ length: k }, (_, i) => [
    {
      ...plain(
        ACTION.RELEASE,
        { bindRow: "releaseFolder" },
        { purpose: PURPOSES.folder, subject: SRC, role: word(0x100 + i) },
      ),
      group: i,
    },
    { ...placeAgain(i), group: i },
  ]).flat();
/** planCreateFile at removed names: CREATE, the root record, a fresh HEAD, and the FOLDER BIND (no name PUBLISH). */
const creates = (k: number) =>
  Array.from({ length: k }, (_, i) => [
    { ...plain(ACTION.CREATE), group: i },
    {
      ...plain(ACTION.PUBLISH, { shape: "files-root/1 form 0" }),
      body: `0x${"ab".repeat(82)}` as Hex,
      group: i,
    },
    { ...plain(ACTION.BIND, { bindRow: "bindHeadFresh", firstStatement: true }), group: i },
    { ...placeAgain(i), group: i },
  ]).flat();

describe("INTERIM: the kernel's rewrite of a folder entry's target", () => {
  it("the price is the floor's rewrite, in K only", () => {
    for (const [s, rw] of [
      ["prague", 5_000],
      ["amsterdam", 12_100],
    ] as const) {
      const sch = S[s] as (typeof S)[string];
      expect(sch.floor?.kernel.interimFolderRetarget).toBe(rw);
      expect(sch.floor?.limits.floorRewriteGas).toBe(rw);
      expect(sch.constants.interimFolderRetarget).toBe(0);
      if (sch.executionGas) expect(sch.executionGas.interimFolderRetarget).toBe(0);
    }
  });

  it("a folder entry bound before pays it in K; a never-bound one and other purposes don't", () => {
    for (const [s, rw] of [
      ["prague", 5_000],
      ["amsterdam", 12_100],
    ] as const) {
      const m = modelOf(s);
      const off = modelOf(s, false);
      const delta = (a: PlannedAction) => {
        const on = ruleGas([a], m);
        const no = ruleGas([a], off);
        return [on.E - no.E, on.K - no.K];
      };
      expect(delta(placeAgain(1))).toEqual([0, rw]);
      expect(delta(placeAgain(1, "restoreFolder", true))).toEqual([0, 0]); // its target is written fresh instead
      expect(delta(placeAgain(1, "restoreTag"))).toEqual([0, 0]);
      expect(delta(placeAgain(1, "bindFolderRebind"))).toEqual([0, 0]); // a BOUND head: the re-bind row measures it
    }
  });

  it("moves into and new files at removed names: the largest planned part fits the budget (sizes before → now)", () => {
    const budget = budgetOf(BigInt(GAS_PLANNING.txGasCap), GAS_PLANNING.headroomPercent / 100);
    const limits = {
      maxActionsPerPublication: GAS_PLANNING.limits.maxActions,
      maxBindsPerPublication: GAS_PLANNING.limits.maxBindsPerPublication,
      maxBodyBytesPerPublication: GAS_PLANNING.limits.maxBodyBytesPerPublication,
      maxBodyBytes: 8192,
    };
    const first = (m: GasModel, all: PlannedAction[]) => {
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
    const sizes: Record<string, Record<string, [number, number]>> = {};
    for (const s of ["prague", "amsterdam"]) {
      sizes[s] = {
        moves: [first(modelOf(s, false), moves(40)) / 2, first(modelOf(s), moves(40)) / 2],
        creates: [first(modelOf(s, false), creates(20)) / 4, first(modelOf(s), creates(20)) / 4],
      };
    }
    expect(sizes).toEqual(SIZES);
  });

  it("the gas model has no new-target restore rows yet: this fails once the list release adds them (then drop it)", () => {
    for (const s of Object.values(S))
      for (const c of [s.constants, s.executionGas, s.floor?.kernel])
        if (c)
          expect(
            Object.keys(c).filter((k) =>
              /^restoreProperty|restoreHead|headRestore|newTarget/i.test(k),
            ),
          ).toEqual([]);
  });
});

/**
 * This SDK's planner, [before the term, with it]: entries moved, or files created, per part. The term moves no size:
 * with it the largest parts' V is 14,195,765 (prague moves), 14,228,131 (amsterdam moves, 32,502 under the budget),
 * 13,402,140 (prague creates) and 13,698,137 (amsterdam creates), against a budget of 14,260,633.
 */
const SIZES = {
  prague: { moves: [27, 27], creates: [13, 13] },
  amsterdam: { moves: [26, 26], creates: [16, 16] },
};
