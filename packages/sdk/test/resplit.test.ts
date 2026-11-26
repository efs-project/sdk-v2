// SPDX-License-Identifier: MIT
// Re-splitting a part refused as over the per-transaction cap (runSequence, src/actions/sequence.ts): it is cut only
// between its units, in order, into near-equal pieces; each piece carries its units' effects (a registration-only
// piece its registration effect) and no gas figures; a part without valid units, or of one unit, can't be cut. The
// pieces' actions differ from each other and from the refused part, so the twin guard never holds one as another.
import { describe, expect, it } from "vitest";
import type { PartUnit, SequencePart } from "../src/actions/journal.ts";
import { actionsHash } from "../src/actions/plan.ts";
import { MAX_SPLIT_DEPTH, resplit } from "../src/actions/sequence.ts";
import type { ActionData, EffectView } from "../src/actions/types.ts";
import { type Hex, ZERO_WORD } from "../src/core/hex.ts";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const action = (n: number): ActionData => ({
  kind: 3,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: word(n),
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: word(n),
  target: ZERO_WORD,
  expectedRevision: 0n,
  saltOrStrength: ZERO_WORD,
});
const effect = (stage: string, n: number): EffectView => ({
  code: stage === "register" ? "tags.register" : "tags.tag",
  args: { thing: word(n), part: "1", parts: "1", stage },
});

/** A tag part: a registration of `reg` actions, then `stmts` statements (one action each). */
function tagPart(reg: number, stmts: number): SequencePart {
  const units: PartUnit[] = [];
  if (reg) units.push({ actions: reg, effect: effect("register", 0) });
  for (let s = 0; s < stmts; s++) units.push({ actions: 1, effect: effect("finish", 100 + s) });
  const n = reg + stmts;
  return {
    actions: Array.from({ length: n }, (_, i) => action(i)),
    bodies: Array.from({ length: n }, () => "0x" as Hex),
    effects: units.filter((u) => u.effect.args["stage"] !== "register").map((u) => u.effect),
    units,
    gas: 20_000_000,
    total: 20_000_000,
    planId: word(9),
  };
}

describe("resplit", () => {
  it("cuts only between units, in order, into near-equal pieces", () => {
    const part = tagPart(3, 4); // units: [reg×3] s s s s
    const pieces = resplit(part, 2);
    expect(pieces?.map((p) => p.actions.length)).toEqual([4, 3]); // [reg×3, s] and [s, s, s]
    expect(pieces?.flatMap((p) => p.actions)).toEqual(part.actions); // nothing lost, nothing reordered
    expect(pieces?.map((p) => p.units?.map((u) => u.actions))).toEqual([
      [3, 1],
      [1, 1, 1],
    ]);
    // Never more pieces than units, never fewer than 2.
    expect(resplit(part, 50)?.length).toBe(5);
    expect(resplit(part, 1)?.length).toBe(2);
  });

  it("each piece carries its units' effects; a registration-only piece keeps the registration effect", () => {
    const part = tagPart(2, 1); // units: [reg×2] s
    const [first, second] = resplit(part, 2) as SequencePart[];
    expect(first?.effects.map((e) => e.args["stage"])).toEqual(["register"]);
    expect(second?.effects.map((e) => e.args["thing"])).toEqual([word(100)]);
    const [a] = resplit(tagPart(1, 3), 2) as SequencePart[];
    expect(a?.effects.map((e) => e.args["stage"])).toEqual(["finish"]); // a statement is there: no register effect
  });

  it("pieces carry no plan, no gas figures, and their depth; the refused part's own figures are not reused", () => {
    const pieces = resplit(tagPart(1, 5), 3) as SequencePart[];
    for (const p of pieces) {
      expect(p.planId).toBeUndefined();
      expect(p.gas).toBeUndefined();
      expect(p.total).toBeUndefined();
      expect(p.splitDepth).toBe(1);
    }
    expect((resplit({ ...tagPart(0, 4), splitDepth: 2 }, 2) as SequencePart[])[0]?.splitDepth).toBe(
      3,
    );
    expect(MAX_SPLIT_DEPTH).toBe(6);
  });

  it("no valid units, or a single unit, can't be cut", () => {
    const part = tagPart(2, 3);
    const { units: _u, ...noUnits } = part;
    expect(resplit(noUnits as SequencePart, 2)).toBeNull(); // a content part, or a record from before units
    expect(
      resplit({ ...part, units: [{ actions: 5, effect: effect("finish", 1) }] }, 2),
    ).toBeNull();
    expect(
      resplit({ ...part, units: [{ actions: 4, effect: effect("finish", 1) }] }, 2),
    ).toBeNull(); // 4 ≠ 5 actions
    expect(resplit({ ...part, units: [] }, 2)).toBeNull();
  });

  it("the pieces' actions differ from each other and from the refused part (never twins)", () => {
    const part = tagPart(3, 6);
    const hashes = [part, ...(resplit(part, 3) as SequencePart[])].map((p) =>
      actionsHash(p.actions),
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
