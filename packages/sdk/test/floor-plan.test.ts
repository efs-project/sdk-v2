// SPDX-License-Identifier: MIT
// The planning rule against the contracts' shared verdicts (test/vectors/floor-plan.json, written by their
// tools/gas-plan.mjs from gas/model.json): for each of the seventeen shapes on both schedules, the SDK must find the same
// E, K, V and kernel quote at the largest admitted count, refuse one unit more for the same reason, and split a
// longer run of the shape at exactly that count. The shapes themselves come from the vendored reference planner.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ES module from the contracts (no types), vendored with the vectors it wrote.
import { shapes } from "../../../protocol-inputs/contracts/tools/gas-plan.mjs";
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
import { GAS_PLANNING, GAS_SCHEDULES } from "../src/generated/gas.ts";

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
  | { kind: "bind"; cost: BindRow; first: boolean; levels?: Record<string, number> };

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
/** The reference planner's action, as the SDK's planners would plan it. */
function toSdk(a: RefAction, group: number): PlannedAction {
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
        action: { ...blank, kind },
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
/** k units of a shape, each unit its own group (so a split never cuts a unit). */
const unitsOf = (name: string, k: number): PlannedAction[] => {
  const s = all[name] as { units: number; of: (k: number) => RefAction[] };
  return s.of(k).map((a, i) => toSdk(a, Math.floor(i / s.units)));
};

describe("the planning rule reproduces the contracts' shared verdicts", () => {
  for (const [schedule, rows] of Object.entries(vectors.schedules)) {
    const m = modelFor(schedule);
    const budget = budgetOf(BigInt(GAS_PLANNING.txGasCap), GAS_PLANNING.headroomPercent / 100);
    for (const [name, v] of Object.entries(rows)) {
      it(`${schedule}: ${name}, ${v.k} per publication`, () => {
        expect(budget).toBe(v.budget);
        const at = ruleGas(unitsOf(name, v.k), m);
        expect({ E: at.E, K: at.K, V: at.V, ...at.quote }).toEqual({
          E: v.E,
          K: v.K,
          V: v.V,
          prefixFloor: v.prefixFloor,
          finalReserve: v.finalReserve,
          freshSlots: v.freshSlots,
          rewrites: v.rewrites,
        });
        expect(Math.max(at.E, at.V)).toBeLessThanOrEqual(budget);
        if (v.next.refused === "gas") {
          const next = ruleGas(unitsOf(name, v.k + 1), m);
          expect({ E: next.E, K: next.K, V: next.V }).toEqual({
            E: v.next.E,
            K: v.next.K,
            V: v.next.V,
          });
          expect(Math.max(next.E, next.V)).toBeGreaterThan(budget);
        } else {
          expect((v.k + 1) * v.units).toBeGreaterThan(GAS_PLANNING.limits.maxActions);
        }
        // The splitter cuts a longer run of the shape at exactly k units.
        const run = Math.min(v.k + 3, Math.floor(GAS_PLANNING.limits.maxActions / v.units) * 2);
        const r = splitPublications(unitsOf(name, run), {
          model: m,
          limits: LIMITS,
          txGasCap: BigInt(GAS_PLANNING.txGasCap),
        });
        if (!r.ok) throw new Error(r.reason.detail);
        expect(r.parts[0]?.actions.length).toBe(v.k * v.units);
      });
    }
  }
});
