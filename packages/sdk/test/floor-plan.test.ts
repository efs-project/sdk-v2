// SPDX-License-Identifier: MIT
// The planning rule against the contracts' shared verdicts (test/vectors/floor-plan.json, written by their
// tools/gas-plan.mjs from gas/model.json): for each shape on both schedules, the SDK must find the same E, K, V and
// kernel quote at the largest admitted count, refuse one unit more for the same reason, and split a longer run of the
// shape at exactly that count. The shapes themselves come from the vendored reference planner.
//
// The SDK never passes an author's entry count (it prices every later statement at the long tier, gas/model.json
// laterLists), so where a shape's reference actions carry a short-tier count the SDK is held to the reference planner
// given the same actions without it, and the batch it plans is stated (SDK_SIZES): never larger than the vector's.
//
// A guarded shape (the guard release, contracts 19891fe) carries its read set as the SDK's planners carry it, each head
// on the action it belongs to; the SDK must price it as the reference does and split a longer run by the read set's
// grid where that binds before gas (the lens edits: 64 principals × 4 positions, the fifth refused by maxReadCount).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ES module from the contracts (no types), vendored with the vectors it wrote.
import { planner, shapes } from "../../../protocol-inputs/contracts/tools/gas-plan.mjs";
import { type GuardHead, guardBytes, guardGrid, guardOver } from "../src/actions/guard.ts";
import {
  type BindRow,
  budgetOf,
  type GasModel,
  type PlannedAction,
  ruleGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import { type Hex, type PrincipalId, ZERO_WORD } from "../src/core/hex.ts";
import { PURPOSES } from "../src/generated/constants.ts";
import { GAS_LATER_LISTS, GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";

const IN = join(import.meta.dirname, "../../../protocol-inputs/contracts");
const model = JSON.parse(readFileSync(join(IN, "gas/model.json"), "utf8"));
const vectors = JSON.parse(readFileSync(join(IN, "test/vectors/floor-plan.json"), "utf8")) as {
  schedules: Record<string, Record<string, Vector>>;
};
interface Figures {
  E: number;
  K: number;
  V: number;
  prefixFloor: number;
  finalReserve: number;
  freshSlots: number;
  rewrites: number;
}
interface Vector extends Figures {
  units: number;
  k: number;
  budget: number;
  /** A guarded shape's guard length at k (gas-plan.mjs guardBytes). */
  guardBytes?: number;
  next: Partial<Figures> & { k: number; refused: string };
}
type RefAction =
  | { kind: "publish"; shape: string; bytes: number; fresh: boolean }
  | { kind: "reuse"; type: string }
  | { kind: "create" }
  | { kind: "withdraw" }
  | {
      kind: "bind";
      cost: BindRow;
      first: boolean;
      levels?: Record<string, number>;
      firstAtPlace?: boolean;
      entries?: number;
    };

const blank: ActionData = {
  kind: 0,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  saltOrStrength: ZERO_WORD,
};
/** The purpose a reference bind's constants key names (gas-plan.mjs `purposeOf`): the surcharge compares it. */
const purposeOf = (cost: string): Hex =>
  /Head/.test(cost)
    ? PURPOSES.head
    : /Folder/.test(cost)
      ? PURPOSES.folder
      : /Tag/.test(cost)
        ? PURPOSES.tag
        : /Property/.test(cost)
          ? PURPOSES.property
          : /Same/.test(cost)
            ? PURPOSES.same
            : PURPOSES.broader;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
/** The reference planner's action, as the SDK's planners would plan it (`subject` places a later statement). */
function toSdk(a: RefAction, group: number, subject: Hex = ZERO_WORD): PlannedAction {
  switch (a.kind) {
    case "publish":
      return {
        action: { ...blank, kind: ACTION.PUBLISH },
        body: `0x${"ab".repeat(a.bytes)}` as Hex,
        shape: a.shape,
        ...(a.fresh ? {} : { exists: true }),
        group,
      };
    case "reuse":
      return { action: { ...blank, kind: ACTION.REUSE }, body: "0x", shape: a.type, group };
    case "create":
      return { action: { ...blank, kind: ACTION.CREATE }, body: "0x", group };
    case "withdraw":
      return { action: { ...blank, kind: ACTION.WITHDRAW }, body: "0x", group };
    case "bind": {
      const kind = a.cost.startsWith("unbind")
        ? ACTION.UNBIND
        : a.cost.startsWith("release")
          ? ACTION.RELEASE
          : ACTION.BIND;
      return {
        action: { ...blank, kind, purpose: purposeOf(a.cost), subject },
        body: "0x",
        bindRow: a.cost,
        firstStatement: a.first,
        ...(a.levels ? { levels: a.levels } : {}),
        group,
      };
    }
  }
}
const modelFor = (schedule: string): GasModel => {
  const sch = (GAS_SCHEDULES as unknown as Record<string, Record<string, unknown>>)[
    schedule
  ] as Record<string, unknown>;
  const exec = (sch["executionGas"] ?? sch["constants"]) as Omit<GasModel, "schedule">;
  return { ...exec, schedule, floor: sch["floor"] } as GasModel;
};
const GUARD_LIMITS_OF = {
  maxReadSetPrincipals: GAS_PLANNING.limits.maxReadSetPrincipals,
  maxReadSetPositions: GAS_PLANNING.limits.maxReadSetPositions,
  maxReadCount: GAS_PLANNING.limits.maxReadCount,
};
const LIMITS = {
  ...GUARD_LIMITS_OF,
  maxActionsPerPublication: GAS_PLANNING.limits.maxActions,
  maxBindsPerPublication: GAS_PLANNING.limits.maxBindsPerPublication,
  maxBodyBytesPerPublication: GAS_PLANNING.limits.maxBodyBytesPerPublication,
  maxBodyBytes: 8192,
};
const all = shapes(model) as Record<string, { units: number; of: (k: number) => RefAction[] }>;
/**
 * The SDK's form of reference actions, each unit its own group (so a split never cuts a unit). A later statement first
 * at its place (`firstAtPlace`, default true) gets a subject of its own; one that is not shares the place of the last
 * later statement of the same row, as the reference's shapes mean it.
 */
const sdkOf = (acts: readonly RefAction[], units: number): PlannedAction[] => {
  const place = new Map<string, Hex>();
  let next = 0x1000;
  return acts.map((a, i) => {
    if (a.kind !== "bind" || a.first) return toSdk(a, Math.floor(i / units));
    const at = a.firstAtPlace === false ? place.get(a.cost) : undefined;
    const subject = at ?? word(next++);
    place.set(a.cost, subject);
    return toSdk(a, Math.floor(i / units), subject);
  });
};
const unitsOf = (name: string, k: number): PlannedAction[] => {
  const s = all[name] as { units: number; of: (k: number) => RefAction[] };
  return sdkOf(s.of(k), s.units);
};
/** A shape's reference actions as the SDK plans them: the entry count left out (unknown: the long tier). */
const withoutEntries = (name: string) => (k: number) =>
  (all[name] as { of: (k: number) => RefAction[] })
    .of(k)
    .map((a) => (a.kind === "bind" ? (({ entries: _, ...b }) => b)(a) : a));
/** Whether any of a shape's later statements is priced at the short tier in the vector (a known count of at most 48). */
const shortTier = (name: string, k: number) =>
  (all[name] as { of: (k: number) => RefAction[] })
    .of(k)
    .some(
      (a) =>
        a.kind === "bind" &&
        !a.first &&
        a.entries !== undefined &&
        a.entries <= GAS_LATER_LISTS.shortTierMaxEntries,
    );
/**
 * The batches the SDK plans where the vector's is planned at the short tier (the reference planner on the same
 * actions without the entry count): the price of never passing it, never larger than the vector's. In the list
 * release (contracts 04526b1) and the guard release (19891fe, which adds movesToFresh) every one equals the vector's:
 * these shapes are bounded by the floor V, whose rows carry no list term, not by E.
 */
const SDK_SIZES: Record<string, Record<string, number>> = {
  prague: {
    tagYesesAfterLoneNoes: 45,
    createFilesAtRemovedNames: 11,
    createFilesAtRemovedNamesNoName: 13,
    movesIntoRemovedNames: 18,
    movesIntoRemovedNamesNoName: 25,
    movesToFresh: 20,
    movesToFreshGuarded: 20,
    folderRestoresGuarded: 47,
  },
  amsterdam: {
    createFilesAtRemovedNames: 12,
    createFilesAtRemovedNamesNoName: 16,
    movesIntoRemovedNames: 19,
    movesIntoRemovedNamesNoName: 25,
    movesToFresh: 25,
    movesToFreshGuarded: 24,
    folderRestoresGuarded: 47,
  },
};
/** A guarded shape's read set at k units (gas-plan.mjs shapes' `guard`), and the reference planner's guard limits. */
type RefGuard = {
  principals: number;
  positions: number;
  written: number;
  writtenUnread: number;
  twoWords: number;
  oneWord: number;
};
const guardOf = (name: string) => (all[name] as { guard?: (k: number) => RefGuard }).guard;
const fixedK = (name: string) => (all[name] as { fixedK?: number }).fixedK;
const AUTHOR = word(0xa0) as PrincipalId;
const other = (i: number) => word(0xa1 + i) as PrincipalId;
const head = (principal: PrincipalId, position: Hex, term: GuardHead["term"]): GuardHead => ({
  principal,
  position,
  expected: ZERO_WORD,
  term,
});
/**
 * The SDK's form of a guarded shape's read set: each guarded head tied to an action, as the SDK's planners tie them,
 * so a split carries a head with its action. Three forms, by the reference's read set at the vector's k (and checked
 * against it there): one author whose every bind writes a head of its own (moves, masks, restores, number changes);
 * a Lens of n principals at each bind's position, the author's head written and the others' read (the lens edits); or
 * heads no action writes, spread evenly over the actions (the guarded CREATEs).
 */
const withGuard = (name: string, kAt: number, acts: PlannedAction[]): PlannedAction[] => {
  const g = (guardOf(name) as (k: number) => RefGuard)(kAt);
  let pos = 0x2000;
  const binds = (list: PlannedAction[]) => list.filter((a) => isBindLike(a.action.kind)).length;
  if (g.written > 0 && g.principals === 1)
    return acts.map((a) =>
      isBindLike(a.action.kind) ? { ...a, guard: [head(AUTHOR, word(pos++), "written")] } : a,
    );
  if (g.written > 0)
    return acts.map((a) => {
      if (!isBindLike(a.action.kind)) return a;
      const at = word(pos++);
      const others = Array.from({ length: g.principals - 1 }, (_, i) =>
        head(other(i), at, "twoWords"),
      );
      return { ...a, guard: [head(AUTHOR, at, "written"), ...others] };
    });
  const perAction = g.positions / unitsOf(name, kAt).length;
  expect(binds(acts)).toBe(0);
  expect(Number.isInteger(perAction)).toBe(true);
  return acts.map((a) => ({
    ...a,
    guard: Array.from({ length: perAction }, () => word(pos++)).flatMap((at) =>
      Array.from({ length: g.principals }, (_, i) =>
        head(i === 0 ? AUTHOR : other(i - 1), at, "twoWords"),
      ),
    ),
  }));
};
const isBindLike = (k: number) => k === ACTION.BIND || k === ACTION.UNBIND || k === ACTION.RELEASE;
/** A shape's actions as the SDK plans them, with its guard heads where the shape is guarded (`kAt`: its vector's k). */
const plannedOf = (name: string, k: number, kAt: number): PlannedAction[] =>
  guardOf(name) ? withGuard(name, kAt, unitsOf(name, k)) : unitsOf(name, k);
const heads = (acts: readonly PlannedAction[]) => acts.flatMap((a) => a.guard ?? []);
const GUARD_LIMITS = new Set(["maxReadSetPrincipals", "maxReadSetPositions", "maxReadCount"]);

describe("the planning rule reproduces the contracts' shared verdicts", () => {
  for (const [schedule, rows] of Object.entries(vectors.schedules)) {
    const m = modelFor(schedule);
    const budget = budgetOf(BigInt(GAS_PLANNING.txGasCap), GAS_PLANNING.headroomPercent / 100);
    const ref = planner(model, schedule) as {
      check: (
        a: RefAction[],
        o?: { guard?: RefGuard },
      ) => Figures & { fits: boolean; refused: string | null };
      largest: (
        shape: (k: number) => RefAction[],
        max?: number,
        guardOf?: ((k: number) => RefGuard) | null,
      ) => number;
    };
    for (const [name, v] of Object.entries(rows)) {
      it(`${schedule}: ${name}, ${v.k} per publication`, () => {
        expect(budget).toBe(v.budget);
        const units = (all[name] as { units: number }).units;
        const g = guardOf(name);
        const opt = (j: number) => (g ? { guard: g(j) } : {});
        // what the SDK must find: the vector, or (a short-tier shape) the reference without the entry count
        const short = shortTier(name, v.k);
        const k = short ? ref.largest(withoutEntries(name), undefined, g ?? null) : v.k;
        const want = short ? ref.check(withoutEntries(name)(k), opt(k)) : v;
        const nextWant = short ? ref.check(withoutEntries(name)(k + 1), opt(k + 1)) : v.next;
        const nextRefused = short
          ? (nextWant as { refused: string | null }).refused
          : v.next.refused;
        if (short) {
          expect(k, "the SDK's batch, stated").toBe(SDK_SIZES[schedule]?.[name]);
          expect(k).toBeLessThanOrEqual(v.k);
        } else expect(SDK_SIZES[schedule]?.[name]).toBeUndefined();
        const acts = plannedOf(name, k, v.k);
        if (g) {
          // the SDK's read set is the reference's, head for head (guardGrid: a complete grid)
          const grid = guardGrid(heads(acts));
          if (!grid.ok) throw new Error(`${name}: the test's guard is not a grid (${grid.why})`);
          expect(grid.grid.shape).toEqual(g(k));
          if ("guardBytes" in v) expect(guardBytes(grid.grid.shape)).toBe(v.guardBytes);
        }
        const at = ruleGas(acts, m);
        expect({ E: at.E, K: at.K, V: at.V, ...at.quote }).toEqual({
          E: want.E,
          K: want.K,
          V: want.V,
          prefixFloor: want.prefixFloor,
          finalReserve: want.finalReserve,
          freshSlots: want.freshSlots,
          rewrites: want.rewrites,
        });
        expect(Math.max(at.E, at.V)).toBeLessThanOrEqual(budget);
        // a shape checked at one size only (the reference's `fixedK`) says nothing about one unit more
        if (fixedK(name) !== undefined) {
          expect(v.next.refused).toBe("fixedK");
          return;
        }
        const next = ruleGas(plannedOf(name, k + 1, v.k), m);
        if (nextRefused === "gas") {
          expect({ E: next.E, K: next.K, V: next.V }).toEqual({
            E: nextWant.E,
            K: nextWant.K,
            V: nextWant.V,
          });
          expect(Math.max(next.E, next.V)).toBeGreaterThan(budget);
        } else if (nextRefused !== null && GUARD_LIMITS.has(nextRefused)) {
          // refused by the read set's grid, not by gas: one unit more is within the budget
          const grid = guardGrid(heads(plannedOf(name, k + 1, v.k)));
          if (!grid.ok) throw new Error(`${name}: the test's guard is not a grid (${grid.why})`);
          expect(guardOver(grid.grid.shape, GUARD_LIMITS_OF)).toBe(nextRefused);
          expect(Math.max(next.E, next.V)).toBeLessThanOrEqual(budget);
        } else {
          expect((k + 1) * units).toBeGreaterThan(GAS_PLANNING.limits.maxActions);
        }
        // The splitter cuts a longer run of the shape at exactly k units.
        const run = Math.min(k + 3, Math.floor(GAS_PLANNING.limits.maxActions / units) * 2);
        const r = splitPublications(plannedOf(name, run, v.k), {
          model: m,
          limits: LIMITS,
          txGasCap: BigInt(GAS_PLANNING.txGasCap),
        });
        if (!r.ok) throw new Error(r.reason.detail);
        expect(r.parts[0]?.actions.length).toBe(k * units);
      });
    }
  }
});

describe("statements about topics are priced by their own rows, as the reference planner prices them", () => {
  // contracts 0fb4804: a label (PROPERTY), "same as" and "broader", first and later; a label with a new text is the
  // text/1 publish row plus bindPropertyFresh.
  const rows: [BindRow, boolean][] = [
    ["bindPropertyFresh", true],
    ["bindPropertyRebind", false],
    ["unbindProperty", false],
    ["releaseProperty", false],
    ["bindSameFreshWord", true],
    ["bindSameFreshPath", true],
    ["unbindSame", false],
    ["releaseSame", false],
    ["restoreSame", false],
    ["bindBroaderFresh", true],
    ["unbindBroader", false],
    ["releaseBroader", false],
    ["restoreBroader", false],
  ];
  for (const schedule of Object.keys(vectors.schedules)) {
    const m = modelFor(schedule);
    const ref = planner(model, schedule) as {
      check: (a: RefAction[], o?: { firstWrite?: boolean }) => Figures;
    };
    const same = (acts: RefAction[], firstWrite: boolean) => {
      const at = ruleGas(
        acts.map((a) => toSdk(a, 0)),
        m,
        firstWrite,
      );
      const want = ref.check(acts, { firstWrite });
      expect({ E: at.E, K: at.K, V: at.V }).toEqual({ E: want.E, K: want.K, V: want.V });
    };
    it(`${schedule}: each of the thirteen rows, alone and as a first write`, () => {
      for (const [cost, first] of rows) {
        same([{ kind: "bind", cost, first }], false);
        same([{ kind: "bind", cost, first }], true);
      }
    });
    it(`${schedule}: a label with a new 24-byte text`, () => {
      same(
        [
          { kind: "publish", shape: "text/1", bytes: 24, fresh: true },
          { kind: "bind", cost: "bindPropertyFresh", first: true },
        ],
        false,
      );
    });
  }
});
