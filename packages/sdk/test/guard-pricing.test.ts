// SPDX-License-Identifier: MIT
// The read-set guard's shape, limits and gas (contracts 19891fe, the guard release; gas-plan.mjs guardCost and
// guardBytes), and how the splitter keeps a guarded publication one grid within the Realm's limits. The exact figures
// against the reference planner are in floor-plan.test.ts (the eight guarded shapes); here, the rules around them.
import { describe, expect, it } from "vitest";
import {
  type GuardHead,
  guardBytes,
  guardCost,
  guardGrid,
  guardOver,
} from "../src/actions/guard.ts";
import {
  type GasModel,
  modelGas,
  type PlannedAction,
  publicationGas,
  ruleGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import { type Hex, type PrincipalId, ZERO_WORD } from "../src/core/hex.ts";
import { PURPOSES } from "../src/generated/constants.ts";
import { GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const P = (n: number) => word(0xa0 + n) as PrincipalId;
const head = (
  principal: number,
  position: number,
  term: GuardHead["term"] = "written",
): GuardHead => ({
  principal: P(principal),
  position: word(0x2000 + position),
  expected: ZERO_WORD,
  term,
});
const blank: ActionData = {
  kind: ACTION.UNBIND,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: PURPOSES.folder,
  subject: word(0x1000),
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 1n,
  saltOrStrength: ZERO_WORD,
};
/** A folder mask (a later UNBIND of a BOUND head), carrying `guard`. */
const mask = (i: number, guard?: GuardHead[]): PlannedAction => ({
  action: { ...blank, role: word(0x3000 + i) },
  body: "0x",
  bindRow: "unbindFolder",
  group: i,
  ...(guard ? { guard } : {}),
});
const sched = GAS_SCHEDULES as unknown as Record<string, Record<string, unknown>>;
const modelOf = (name: string): GasModel => {
  const s = sched[name] as Record<string, unknown>;
  const exec = (s["executionGas"] ?? s["constants"]) as Omit<GasModel, "schedule">;
  return {
    ...exec,
    schedule: name,
    floor: s["floor"],
    ...(s["executionGas"] ? { total: s["constants"] } : {}),
  } as GasModel;
};
const PRAGUE = modelOf("prague");
const LIMITS = {
  maxActionsPerPublication: 64,
  maxBodyBytesPerPublication: 16384,
  maxBindsPerPublication: 64,
  maxBodyBytes: 8192,
};
const CAP = BigInt(GAS_PLANNING.txGasCap);

describe("guardGrid: a guard names every principal at every position", () => {
  it("first-appearance order; the shape counts each term", () => {
    const g = guardGrid([head(1, 1), head(2, 1, "twoWords"), head(1, 2), head(2, 2, "oneWord")]);
    expect(g).toEqual({
      ok: true,
      grid: {
        principals: [P(1), P(2)],
        positions: [word(0x2001), word(0x2002)],
        shape: {
          principals: 2,
          positions: 2,
          written: 2,
          writtenUnread: 0,
          twoWords: 1,
          oneWord: 1,
        },
      },
    });
  });
  it("a head named twice, or a principal and a position with no head between them, is no grid", () => {
    expect(guardGrid([head(1, 1), head(1, 1, "twoWords")])).toEqual({
      ok: false,
      why: "duplicate",
    });
    expect(guardGrid([head(1, 1), head(2, 2)])).toEqual({ ok: false, why: "incomplete" });
    // case never tells two heads apart: ids are compared as words
    const lowerCase: GuardHead = { ...head(1, 1), position: word(0x20ab) };
    const upperCase: GuardHead = {
      ...head(1, 1),
      position: `0x${word(0x20ab).slice(2).toUpperCase()}` as Hex,
    };
    expect(upperCase.position).not.toBe(lowerCase.position);
    expect(guardGrid([lowerCase, upperCase])).toEqual({ ok: false, why: "duplicate" });
  });
  it("guardOver names the limit in the kernel's order: principals, positions, then n·m over maxReadCount", () => {
    const l = { maxReadSetPrincipals: 64, maxReadSetPositions: 128, maxReadCount: 256 };
    const s = (principals: number, positions: number) => ({
      principals,
      positions,
      written: 0,
      writtenUnread: 0,
      twoWords: principals * positions,
      oneWord: 0,
    });
    expect(guardOver(s(1, 128), l)).toBeNull();
    expect(guardOver(s(2, 128), l)).toBeNull();
    expect(guardOver(s(64, 4), l)).toBeNull();
    expect(guardOver(s(65, 1), l)).toBe("maxReadSetPrincipals");
    expect(guardOver(s(1, 129), l)).toBe("maxReadSetPositions");
    expect(guardOver(s(65, 129), l)).toBe("maxReadSetPrincipals");
    expect(guardOver(s(64, 5), l)).toBe("maxReadCount");
    expect(guardOver(s(3, 128), l)).toBe("maxReadCount");
  });
  it("guardBytes is abi.encode(ReadSet): 224 + 32·(n + m + n·m) (the vectors' 2,816 and 10,592)", () => {
    const s = (principals: number, positions: number) => ({
      principals,
      positions,
      written: 0,
      writtenUnread: 0,
      twoWords: 0,
      oneWord: 0,
    });
    expect(guardBytes(s(1, 40))).toBe(2816);
    expect(guardBytes(s(64, 4))).toBe(10592);
  });
});

describe("a guarded publication's gas", () => {
  const guarded = [mask(0, [head(1, 0)]), mask(1, [head(1, 1)])];
  const bare = [mask(0), mask(1)];
  const shape = {
    principals: 1,
    positions: 2,
    written: 2,
    writtenUnread: 0,
    twoWords: 0,
    oneWord: 0,
  };
  it("adds the guard's terms once to E and once to K, before rounding; the quote is the same", () => {
    const t = PRAGUE.guard;
    const k = PRAGUE.floor?.kernel.guard;
    if (!t || !k) throw new Error("the generated prague model has no guard terms");
    const a = ruleGas(guarded, PRAGUE);
    const b = ruleGas(bare, PRAGUE);
    expect(a.E).toBe(modelGas(guarded, PRAGUE));
    expect(Math.abs(a.E - b.E - guardCost(t, shape))).toBeLessThanOrEqual(1);
    expect(Math.abs(a.K - b.K - guardCost(k, shape))).toBeLessThanOrEqual(1);
    expect(a.quote).toEqual(b.quote);
  });
  it("the shown estimate adds the guard's terms and its real bytes as non-zero calldata", () => {
    const t = PRAGUE.guard;
    if (!t) throw new Error("no guard terms");
    const extra = publicationGas(guarded, PRAGUE) - publicationGas(bare, PRAGUE);
    expect(Math.abs(extra - (guardCost(t, shape) + guardBytes(shape) * 16))).toBeLessThanOrEqual(1);
  });
  it("amsterdam: E from the execution terms, the block's all gas from the all-gas terms (state gas included)", () => {
    const m = modelOf("amsterdam");
    const exec = m.guard;
    const all = m.total?.guard;
    if (!exec || !all) throw new Error("no amsterdam guard terms");
    expect(all.guardFixed - exec.guardFixed).toBe(97_920);
    const shownAll =
      publicationGas(guarded, m.total as GasModel) - publicationGas(bare, m.total as GasModel);
    expect(
      Math.abs(shownAll - (guardCost(all, shape) + guardBytes(shape) * 16)),
    ).toBeLessThanOrEqual(1);
  });
  it("a table without guard terms can't price a guard (MISUSE), and heads that form no grid are a planner's error", () => {
    const { guard: _, ...noGuard } = PRAGUE;
    expect(() => modelGas(guarded, noGuard as GasModel)).toThrow(
      expect.objectContaining({ code: "MISUSE" }),
    );
    expect(() => modelGas([mask(0, [head(1, 0), head(2, 1)])], PRAGUE)).toThrow(
      expect.objectContaining({ code: "INVARIANT" }),
    );
  });
});

describe("the splitter keeps each guarded publication one grid within the read-set limits", () => {
  it("cuts by the grid where it binds before gas (a smaller maxReadCount), never by gas alone", () => {
    const list = Array.from({ length: 10 }, (_, i) => mask(i, [head(1, i)]));
    const all = splitPublications(list, { model: PRAGUE, limits: LIMITS, txGasCap: CAP });
    if (!all.ok) throw new Error(all.reason.detail);
    expect(all.parts.map((p) => p.actions.length)).toEqual([10]);
    const tight = splitPublications(list, {
      model: PRAGUE,
      limits: { ...LIMITS, maxReadCount: 4 },
      txGasCap: CAP,
    });
    if (!tight.ok) throw new Error(tight.reason.detail);
    expect(tight.parts.map((p) => p.actions.length)).toEqual([4, 4, 2]);
    const fewer = splitPublications(list, {
      model: PRAGUE,
      limits: { ...LIMITS, maxReadSetPositions: 3 },
      txGasCap: CAP,
    });
    if (!fewer.ok) throw new Error(fewer.reason.detail);
    expect(fewer.parts.map((p) => p.actions.length)).toEqual([3, 3, 3, 1]);
  });
  it("never merges units whose heads would leave a principal and a position with no head between them", () => {
    // P1 at position 0, then P2 at position 1: one publication would name P1 at 1 and P2 at 0 too
    const r = splitPublications(
      [mask(0, [head(1, 0)]), mask(1, [head(2, 1)]), mask(2, [head(2, 2)])],
      {
        model: PRAGUE,
        limits: LIMITS,
        txGasCap: CAP,
      },
    );
    if (!r.ok) throw new Error(r.reason.detail);
    expect(r.parts.map((p) => p.actions.length)).toEqual([1, 2]);
    // unguarded actions ride with any guarded publication
    const mixed = splitPublications([mask(0, [head(1, 0)]), mask(1), mask(2, [head(1, 2)])], {
      model: PRAGUE,
      limits: LIMITS,
      txGasCap: CAP,
    });
    if (!mixed.ok) throw new Error(mixed.reason.detail);
    expect(mixed.parts.map((p) => p.actions.length)).toEqual([3]);
  });
  it("a unit over a read-set limit alone is refused, naming the limit; a planner's broken grid is INVARIANT", () => {
    const wide = mask(
      0,
      Array.from({ length: 65 }, (_, i) => head(i, 0, i === 0 ? "written" : "twoWords")),
    );
    const r = splitPublications([wide], { model: PRAGUE, limits: LIMITS, txGasCap: CAP });
    expect(r).toMatchObject({ ok: false, at: 0, reason: { code: "LIMIT_EXCEEDED" } });
    expect(!r.ok && r.reason.detail).toMatch(/maxReadSetPrincipals is 64/);
    expect(() =>
      splitPublications([mask(0, [head(1, 0), head(2, 1)])], {
        model: PRAGUE,
        limits: LIMITS,
        txGasCap: CAP,
      }),
    ).toThrow(expect.objectContaining({ code: "INVARIANT" }));
    expect(() =>
      splitPublications([mask(0, [head(1, 0)]), mask(1, [head(1, 0)])], {
        model: PRAGUE,
        limits: LIMITS,
        txGasCap: CAP,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVARIANT",
        message: "a head is guarded twice in one save",
      }),
    );
  });
});
