// SPDX-License-Identifier: MIT
// The planning rule against the contracts' shared verdicts (test/vectors/floor-plan.json, written by their
// tools/gas-plan.mjs from gas/model.json): for each shape on both schedules, the SDK must find the same E, K, V and
// kernel quote at the largest admitted count, refuse one unit more for the same reason, and split a longer run of the
// shape at exactly that count. The shapes themselves come from the vendored reference planner.
//
// The SDK never passes an author's entry count (it prices every later statement at the long tier, gas/model.json
// laterLists), so where a shape's reference actions carry a short-tier count the SDK is held to the reference planner
// given the same actions without it, and the batch it plans is stated (SDK_SIZES): never larger than the vector's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ES module from the contracts (no types), vendored with the vectors it wrote.
import { planner, shapes } from "../../../protocol-inputs/contracts/tools/gas-plan.mjs";
import {
  type BindRow,
  budgetOf,
  type GasModel,
  type PlannedAction,
  ruleGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import { type Hex, ZERO_WORD } from "../src/core/hex.ts";
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
const LIMITS = {
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
  },
  amsterdam: {
    createFilesAtRemovedNames: 12,
    createFilesAtRemovedNamesNoName: 16,
    movesIntoRemovedNames: 19,
    movesIntoRemovedNamesNoName: 25,
    movesToFresh: 25,
  },
};
/**
 * The guarded shapes (contracts 19891fe, the guard release: a read-set guard over the batch's heads). The SDK prices
 * no guard yet; that is the guard step. Until then each is named here, so a new guarded vector fails, and its actions
 * are held to the reference planner's figures without the guard.
 */
const GUARDED = [
  "movesToFreshGuarded",
  "folderMasksGuarded",
  "folderRestoresGuarded",
  "tagNumberChangesGuarded",
  "editsLensGuarded",
  "editsLensOneGuarded",
  "createsGuarded1x128",
  "createsGuarded2x128",
];
const guardedShape = (name: string) => (all[name] as { guard?: unknown }).guard !== undefined;

describe("the planning rule reproduces the contracts' shared verdicts", () => {
  for (const [schedule, rows] of Object.entries(vectors.schedules)) {
    const m = modelFor(schedule);
    const budget = budgetOf(BigInt(GAS_PLANNING.txGasCap), GAS_PLANNING.headroomPercent / 100);
    const ref = planner(model, schedule) as {
      check: (a: RefAction[]) => Figures & { fits: boolean; refused: string | null };
      largest: (shape: (k: number) => RefAction[]) => number;
    };
    it(`${schedule}: the guarded shapes are exactly the ones held for the guard step`, () => {
      expect(Object.keys(rows).filter(guardedShape)).toEqual(GUARDED);
    });
    for (const [name, v] of Object.entries(rows)) {
      it(`${schedule}: ${name}, ${v.k} per publication`, () => {
        expect(budget).toBe(v.budget);
        if (guardedShape(name)) {
          // held for the guard step: the actions alone, as the reference prices them without the guard
          const acts = shortTier(name, v.k) ? withoutEntries(name)(v.k) : all[name]?.of(v.k);
          const at = ruleGas(unitsOf(name, v.k), m);
          const want = ref.check(acts as RefAction[]);
          expect({ E: at.E, K: at.K, V: at.V }).toEqual({ E: want.E, K: want.K, V: want.V });
          return;
        }
        const units = (all[name] as { units: number }).units;
        // what the SDK must find: the vector, or (a short-tier shape) the reference without the entry count
        const short = shortTier(name, v.k);
        const k = short ? ref.largest(withoutEntries(name)) : v.k;
        const want = short ? ref.check(withoutEntries(name)(k)) : v;
        const nextWant = short ? ref.check(withoutEntries(name)(k + 1)) : v.next;
        const nextRefused = short
          ? (nextWant as { refused: string | null }).refused
          : v.next.refused;
        if (short) {
          expect(k, "the SDK's batch, stated").toBe(SDK_SIZES[schedule]?.[name]);
          expect(k).toBeLessThanOrEqual(v.k);
        } else expect(SDK_SIZES[schedule]?.[name]).toBeUndefined();
        const at = ruleGas(unitsOf(name, k), m);
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
        if (nextRefused === "gas") {
          const next = ruleGas(unitsOf(name, k + 1), m);
          expect({ E: next.E, K: next.K, V: next.V }).toEqual({
            E: nextWant.E,
            K: nextWant.K,
            V: nextWant.V,
          });
          expect(Math.max(next.E, next.V)).toBeGreaterThan(budget);
        } else {
          expect((k + 1) * units).toBeGreaterThan(GAS_PLANNING.limits.maxActions);
        }
        // The splitter cuts a longer run of the shape at exactly k units.
        const run = Math.min(k + 3, Math.floor(GAS_PLANNING.limits.maxActions / units) * 2);
        const r = splitPublications(unitsOf(name, run), {
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
