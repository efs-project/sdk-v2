// SPDX-License-Identifier: MIT
// The publication splitter against the contracts' measurements (an 8,192-byte chunk ≈ 6.09M: two per transaction),
// the kernel's batch limits (LedgerCore._bounds), atomic groups, and honest refusals.
import { describe, expect, it } from "vitest";
import {
  type BindRow,
  budgetOf,
  floorMismatch,
  type GasModel,
  gasPlanFor,
  kernelQuote,
  modelGas,
  type PlannedAction,
  packBatches,
  partGas,
  priceAsNew,
  publicationGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import type { Hex } from "../src/core/hex.ts";
import { ZERO_WORD } from "../src/core/hex.ts";
import type { ChainFacts, DeploymentInfo } from "../src/deployment/manifest.ts";
import { GAS_ENVELOPE, GAS_SCHEDULES } from "../src/generated/gas.ts";

/** The contracts' fitted prague model, as generated from release.json gasModel. */
const MODEL: GasModel = { ...GAS_SCHEDULES.prague.constants, schedule: "prague" };
/** Every BIND row set to `n`. */
const bindsAt = (n: number) => ({
  bindHeadFresh: n,
  bindHeadRebind: n,
  bindFolderFreshFile: n,
  bindFolderFreshDirectory: n,
  bindFolderRebind: n,
});
const LIMITS = {
  maxActionsPerPublication: 64,
  maxBodyBytesPerPublication: 1 << 20,
  maxBindsPerPublication: 32,
  maxBodyBytes: 8192,
};
const CAP = 16_777_216n;

const action = (kind: number): ActionData => ({
  kind,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  saltOrStrength: ZERO_WORD,
});
const body = (n: number): Hex => `0x${"ab".repeat(n)}` as Hex;
const publish = (
  n: number,
  shape = "files-bytes/1",
  extra: Partial<PlannedAction> = {},
): PlannedAction => ({
  action: action(ACTION.PUBLISH),
  body: body(n),
  shape,
  ...extra,
});
const plain = (kind: number, group?: number): PlannedAction => ({
  action: action(kind),
  body: "0x",
  ...(group !== undefined ? { group } : {}),
});
const split = (list: PlannedAction[], o = {}) =>
  splitPublications(list, { model: MODEL, limits: LIMITS, txGasCap: CAP, ...o });

describe("splitPublications", () => {
  it("prices an 8 KB chunk like the contracts measured, so two chunks fit one transaction", () => {
    const one = publicationGas([publish(8192)], MODEL) - publicationGas([], MODEL);
    expect(one).toBeGreaterThan(6_090_000); // 6.09M measured, plus its calldata
    expect(one).toBeLessThan(6_300_000);
    const r = split(Array.from({ length: 10 }, () => publish(8192)));
    expect(r.ok && r.parts.map((p) => p.actions.length)).toEqual([2, 2, 2, 2, 2]);
    expect(r.ok && r.parts.every((p) => p.gas <= r.budget)).toBe(true);
    expect(r.ok && r.budget).toBe(Math.floor(16_777_216 * 0.85)); // the contracts' budget rule, 15% headroom
  });

  it("keeps order and never splits a group: a file's finish moves to the next publication whole", () => {
    const finish = [ACTION.PUBLISH, ACTION.PUBLISH, ACTION.CREATE, ACTION.BIND, ACTION.BIND].map(
      (k, i) =>
        k === ACTION.PUBLISH ? publish(96, "files-root/1 form 1", { group: 7 }) : plain(k, 7),
    );
    expect(finish.length).toBe(5);
    const list = [publish(8192), publish(8192), ...finish];
    // With 0.1M binds, two chunks and this finish fit together …
    const together = split(list, { model: { ...MODEL, ...bindsAt(100_000) } });
    expect(together.ok && together.parts.map((p) => p.actions.length)).toEqual([7]);
    // … with 1M binds they do not, and the finish moves whole to a publication of its own.
    const r = split(list, { model: { ...MODEL, ...bindsAt(1_000_000) } });
    if (!r.ok) throw new Error(r.reason.detail);
    expect(r.parts.map((p) => p.actions.length)).toEqual([2, 5]); // the finish did not fit beside two chunks
    expect(r.parts.flatMap((p) => p.actions)).toEqual(list);
  });

  it("enforces the kernel's batch limits: BIND, UNBIND and RELEASE count as binds", () => {
    const binds = [
      ...Array.from({ length: 20 }, () => plain(ACTION.BIND)),
      ...Array.from({ length: 10 }, () => plain(ACTION.UNBIND)),
      ...Array.from({ length: 10 }, () => plain(ACTION.RELEASE)),
    ];
    const r = split(binds, {
      model: { ...MODEL, ...bindsAt(1), unbindFolder: 1, releaseFolder: 1 },
    });
    expect(r.ok && r.parts.map((p) => p.actions.length)).toEqual([32, 8]);
    const many = split(
      Array.from({ length: 100 }, () => plain(ACTION.CREATE)),
      { model: { ...MODEL, create: 1 } },
    );
    expect(many.ok && many.parts.map((p) => p.actions.length)).toEqual([64, 36]);
  });

  it("refuses honestly: a body over the record limit, or a group too big for any transaction", () => {
    const big = split([publish(10), publish(9000)]);
    expect(big).toMatchObject({
      ok: false,
      at: 1,
      reason: { code: "LIMIT_EXCEEDED", retry: "after-replan" },
    });
    const group = Array.from({ length: 3 }, () => publish(8192, "files-bytes/1", { group: 1 }));
    const r = split([publish(10), ...group]);
    expect(r).toMatchObject({ ok: false, at: 1, reason: { code: "OVER_TX_GAS_CAP" } });
  });

  it("prices existing records as publishExisting and unknown shapes at the most expensive known one", () => {
    expect(publicationGas([publish(8192, "files-bytes/1", { exists: true })], MODEL)).toBeLessThan(
      publicationGas([publish(8192)], MODEL),
    );
    expect(publicationGas([publish(96, "no-such-shape")], MODEL)).toBe(
      publicationGas([publish(96, "files-span/1")], MODEL),
    );
  });

  it("never plans more of one shape per transaction than the contracts' envelope", () => {
    // The rule counts model gas only, as the envelope does: the headroom covers intrinsic and calldata gas.
    expect(GAS_ENVELOPE.txGasCap).toBe(16_777_216);
    const count = (n: number, shape: string) => {
      const r = split(Array.from({ length: 200 }, (_, i) => publish(n + (i % 2), shape)));
      if (!r.ok) throw new Error(r.reason.detail);
      return (r.parts[0] as { actions: unknown[] }).actions.length;
    };
    expect(count(8191, "files-bytes/1")).toBe(2); // contracts envelope: chunk × 2
    const spans = count(95, "files-span/1");
    expect(spans).toBe(38); // contracts envelope: spanNode × 38
  });

  it("prices BINDs by row, and the first-write surcharge only on the first part", () => {
    const head = (row?: "bindHeadFresh" | "bindHeadRebind"): PlannedAction => ({
      ...plain(ACTION.BIND),
      ...(row ? { bindRow: row } : {}),
    });
    const g = (a: PlannedAction) => publicationGas([a], MODEL) - publicationGas([], MODEL);
    expect(g(head("bindHeadRebind"))).toBeLessThan(g(head("bindHeadFresh")));
    // No row: the dearest BIND row there is, tag rows included.
    const rows = [
      "bindHeadFresh",
      "bindHeadRebind",
      "bindFolderFreshFile",
      "bindFolderFreshDirectory",
      "bindFolderRebind",
      "bindTagFresh",
      "bindTagSecondAuthor",
      "bindTagNumberChange",
      "restoreTag",
    ] as const;
    expect(g(head())).toBe(Math.max(...rows.map((r) => g({ ...plain(ACTION.BIND), bindRow: r }))));
    const list = Array.from({ length: 4 }, () => publish(8192));
    const plainSplit = split(list);
    const first = split(list, { firstWrite: true });
    if (!plainSplit.ok || !first.ok) throw new Error("not split");
    expect(
      (first.parts[0] as { gas: number }).gas - (plainSplit.parts[0] as { gas: number }).gas,
    ).toBe(MODEL.firstWriteSurcharge);
    expect((first.parts[1] as { gas: number }).gas).toBe(
      (plainSplit.parts[1] as { gas: number }).gas,
    );
  });
});

describe("the list tiers: every later statement at the long tier, first at its place or not", () => {
  const C = GAS_SCHEDULES.prague.constants;
  const w = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  /** A bind-kind action at place (purpose p, subject q). */
  const at = (kind: number, row: BindRow, p: number, q: number, first = false): PlannedAction => ({
    action: { ...plain(kind).action, purpose: w(p), subject: w(q) },
    body: "0x",
    bindRow: row,
    firstStatement: first,
  });
  /** What modelGas charges for these actions above the fixed term. */
  const priced = (list: PlannedAction[]) => modelGas(list, C) - Math.round(C.fixed);
  const mask = (p: number, q: number) => at(ACTION.UNBIND, "unbindTag", p, q);

  it("a later statement whose row has long tiers: LongNewPlace when first at its place, LongSamePlace after", () => {
    expect(priced([mask(1, 1)])).toBe(C.unbindTagLongNewPlace);
    expect(priced([mask(1, 1), mask(1, 1), mask(1, 1)])).toBe(
      C.unbindTagLongNewPlace + 2 * C.unbindTagLongSamePlace,
    );
    // A place is (purpose, subject): another subject, or another purpose, is a new place.
    expect(priced([mask(1, 1), mask(1, 2), mask(2, 1)])).toBe(3 * C.unbindTagLongNewPlace);
    // Of any kind: a release after a mask at the same place is at the same place.
    expect(priced([mask(1, 1), at(ACTION.RELEASE, "releaseTag", 1, 1)])).toBe(
      C.unbindTagLongNewPlace + C.releaseTagLongSamePlace,
    );
    // Every long row the model has, and restoreFolder (contracts 6d11858: a folder restore had no row before).
    for (const row of ["restoreFolder", "unbindProperty", "releaseSame", "restoreBroader"] as const)
      expect(priced([at(ACTION.BIND, row, 3, 3), at(ACTION.BIND, row, 3, 3)])).toBe(
        C[`${row}LongNewPlace`] + C[`${row}LongSamePlace`],
      );
  });

  it("a re-bind never takes a long tier: NewPlace when first at its place, its row after; it still marks the place", () => {
    const rebind = (q: number) => at(ACTION.BIND, "bindTagNumberChange", 1, q);
    expect(priced([rebind(1), rebind(1), rebind(2)])).toBe(
      2 * C.bindTagNumberChangeNewPlace + C.bindTagNumberChange,
    );
    expect(priced([at(ACTION.BIND, "bindFolderRebind", 1, 1)])).toBe(C.bindFolderRebindNewPlace);
    // A row with no tier at all (a HEAD re-bind) is its row.
    expect(priced([at(ACTION.BIND, "bindHeadRebind", 1, 1)])).toBe(C.bindHeadRebind);
    // An earlier re-bind at the place makes a later mask there a same-place statement.
    expect(priced([rebind(1), mask(1, 1)])).toBe(
      C.bindTagNumberChangeNewPlace + C.unbindTagLongSamePlace,
    );
  });

  it("a first statement pays its row and never marks a place", () => {
    const firstTag = at(ACTION.BIND, "bindTagFresh", 1, 1, true);
    expect(priced([firstTag, mask(1, 1)])).toBe(C.bindTagFresh + C.unbindTagLongNewPlace);
    expect(priced([at(ACTION.UNBIND, "unbindTagLone", 1, 1, true)])).toBe(C.unbindTagLone);
  });

  it("without a row: the dearest of its kind, its tiers included", () => {
    const bare = { ...mask(1, 1) } as PlannedAction;
    delete (bare as { bindRow?: BindRow }).bindRow;
    const unbinds = [
      "unbindFolder",
      "unbindTagLone",
      "unbindTag",
      "unbindProperty",
      "unbindSame",
      "unbindBroader",
    ] as const;
    const dearest = Math.max(
      ...unbinds.flatMap((r) => [
        C[r],
        (C as unknown as Record<string, number>)[`${r}LongNewPlace`] ?? 0,
      ]),
    );
    expect(priced([bare])).toBe(dearest);
  });

  it("each part a split makes is priced on its own: its first statement at a place is first there again", () => {
    const limits = { ...LIMITS, maxBindsPerPublication: 64 };
    const many = Array.from({ length: 90 }, (_, i) => ({ ...mask(1, 1), group: i }));
    const r = splitPublications(many, { model: FLOORED, limits, txGasCap: CAP });
    if (!r.ok) throw new Error(r.reason.code);
    expect(r.parts.length).toBeGreaterThan(1);
    for (const p of r.parts) {
      const n = p.actions.length;
      expect(p.rule.E).toBe(
        Math.round(C.fixed + C.unbindTagLongNewPlace + (n - 1) * C.unbindTagLongSamePlace),
      );
    }
  });
});

describe("gasPlanFor", () => {
  const dep = (chain: ChainFacts | null) => ({ chain }) as unknown as DeploymentInfo;
  const osaka: ChainFacts = {
    hardfork: "osaka",
    feeSchedule: "prague",
    txGasCap: 16_777_216n,
    blockGasLimit: 30_000_000n,
  };

  it("takes the schedule the deployment names, with its cap and the contracts' headroom", () => {
    const p = gasPlanFor(dep(osaka));
    expect(p).toMatchObject({
      ok: true,
      txGasCap: 16_777_216n,
      headroom: 0.15,
      blockGasLimit: 30_000_000n,
    });
    expect(p.ok && p.model).toMatchObject({ schedule: "prague", fixed: MODEL.fixed });
    expect(p.ok && p.model.total).toBeUndefined();
  });

  it("falls back to the schedule covering the hardfork, and refuses rather than guess", () => {
    const byFork = gasPlanFor(dep({ ...osaka, feeSchedule: null }));
    expect(byFork.ok && byFork.model.schedule).toBe("prague");
    expect(gasPlanFor(dep({ ...osaka, feeSchedule: "no-such-schedule" }))).toMatchObject({
      ok: false,
      reason: { code: "UNSUPPORTED_PROFILE" },
    });
    expect(gasPlanFor(dep({ ...osaka, hardfork: "future", feeSchedule: null })).ok).toBe(false);
    expect(gasPlanFor(dep(null))).toMatchObject({
      ok: false,
      reason: { code: "UNSUPPORTED_PROFILE" },
    });
  });

  it("amsterdam: the cap counts execution gas, and all gas must also fit the block", () => {
    const p = gasPlanFor(dep({ ...osaka, hardfork: "amsterdam", feeSchedule: "amsterdam" }));
    if (!p.ok) throw new Error(p.reason.detail);
    expect(p.model.fixed).toBe(GAS_SCHEDULES.amsterdam.executionGas.fixed);
    expect(p.model.total?.fixed).toBe(GAS_SCHEDULES.amsterdam.constants.fixed);
    // Two chunks fit the cap on execution gas, but not a small block on all gas.
    const two = [publish(8192), publish(8192)];
    const base = { model: p.model, limits: LIMITS, txGasCap: p.txGasCap };
    const roomy = splitPublications(two, { ...base, blockGasLimit: 100_000_000n });
    expect(roomy.ok && roomy.parts.length).toBe(1);
    const tight = splitPublications(two, { ...base, blockGasLimit: 40_000_000n });
    expect(tight.ok && tight.parts.length).toBe(2);
  });
});

describe("packBatches", () => {
  // A part as a sequence keeps it: actions and bodies, no shapes or bind rows.
  const part = (...sizes: number[]) => ({
    actions: sizes.map(() => action(ACTION.PUBLISH)),
    bodies: sizes.map((n) => body(n)),
  });
  const plan = { model: MODEL, txGasCap: CAP, headroom: 0.15 };
  const budget = Math.floor(Number(CAP) * 0.85);
  const sizes = (groups: number[][]) => groups.map((g) => g.length);

  it("packs consecutive parts while their summed estimate fits one transaction's budget", () => {
    const small = part(100);
    const k = Math.floor(budget / partGas(small, MODEL));
    expect(k).toBeGreaterThan(2);
    const groups = packBatches(
      Array.from({ length: 2 * k + 1 }, () => small),
      plan,
    );
    expect(sizes(groups)).toEqual([k, k, 1]);
    expect(groups.flat()).toEqual(Array.from({ length: 2 * k + 1 }, (_, i) => i));
  });

  it("a part with no neighbour that fits goes alone: two-chunk parts never share a batch", () => {
    const full = part(8192, 8192);
    expect(partGas(full, MODEL)).toBeLessThan(budget);
    expect(packBatches([full, full, full], plan)).toEqual([[0], [1], [2]]);
  });

  it("greedy and in order: every batch fits, and no batch could have taken the next part", () => {
    const mix = [100, 8192, 100, 100, 4000, 8192, 8192, 100, 2000, 100].map((n) =>
      n === 8192 ? part(8192, 8192) : part(n),
    );
    const groups = packBatches(mix, plan);
    expect(groups.flat()).toEqual(mix.map((_, i) => i));
    const sum = (g: number[]) => g.reduce((t, i) => t + partGas(mix[i] as never, MODEL), 0);
    groups.forEach((g, k) => {
      if (g.length > 1) expect(sum(g)).toBeLessThanOrEqual(budget);
      const next = groups[k + 1]?.[0];
      if (next !== undefined) expect(sum([...g, next])).toBeGreaterThan(budget);
    });
  });

  it("maxParts caps a batch (a wallet that refused a bigger one)", () => {
    expect(
      packBatches(
        Array.from({ length: 5 }, () => part(100)),
        plan,
        2,
      ),
    ).toEqual([[0, 1], [2, 3], [4]]);
    expect(sizes(packBatches([part(100), part(100)], plan, 1))).toEqual([1, 1]);
  });

  it("amsterdam: each batch's whole gas must also fit the block; with no block limit, nothing is batched", () => {
    const dep = {
      chain: {
        hardfork: "amsterdam",
        feeSchedule: "amsterdam",
        txGasCap: CAP,
        blockGasLimit: 60_000_000n,
      },
    } as unknown as DeploymentInfo;
    const p = gasPlanFor(dep);
    if (!p.ok) throw new Error(p.reason.detail);
    const m = p.model;
    const total = m.total as GasModel;
    const small = part(100);
    const byExec = Math.floor(budget / partGas(small, m));
    const byBlock = Math.floor((60_000_000 * 0.85) / partGas(small, total));
    const groups = packBatches(
      Array.from({ length: 12 }, () => small),
      p,
    );
    expect(sizes(groups)[0]).toBe(Math.min(12, byExec, byBlock));
    const { blockGasLimit: _, ...noBlock } = p;
    expect(sizes(packBatches([small, small, small], noBlock))).toEqual([1, 1, 1]);
  });

  it("never estimates a part below its shaped estimate", () => {
    const shaped: PlannedAction[] = [
      plain(ACTION.CREATE),
      publish(96, "files-root/1 form 0"),
      publish(12, "files-name/2"),
      { ...plain(ACTION.BIND), bindRow: "bindHeadFresh" },
      { ...plain(ACTION.BIND), bindRow: "bindFolderFreshFile" },
    ];
    const kept = { actions: shaped.map((a) => a.action), bodies: shaped.map((a) => a.body) };
    expect(partGas(kept, MODEL)).toBeGreaterThanOrEqual(publicationGas(shaped, MODEL, true));
  });
});

/** The release's prague model, with its kernel floor (formula 3). */
const FLOORED = {
  ...GAS_SCHEDULES.prague.constants,
  schedule: "prague",
  floor: GAS_SCHEDULES.prague.floor,
} as unknown as GasModel;
const releases = (n: number) => Array.from({ length: n }, () => plain(ACTION.RELEASE));

describe("the kernel's floor (formula 3)", () => {
  it("a 64-entry remove is 58 + 6 on prague: bound by the floor V, as contracts 6d11858 item 43 says (64 at 3ca53ba)", () => {
    const limits = { ...LIMITS, maxBindsPerPublication: 64 };
    const r = splitPublications(releases(64), { model: FLOORED, limits, txGasCap: CAP });
    if (!r.ok) throw new Error(r.reason.code);
    expect(r.parts.map((p) => p.actions.length)).toEqual([58, 6]);
    const rule = r.parts[0]?.rule;
    expect(rule?.V).toBeGreaterThan(rule?.E ?? 0);
    expect(Math.max(rule?.E ?? 0, rule?.V ?? 0)).toBeLessThanOrEqual(r.budget);
  });

  it("row classes (formula 3): first, re-bind or later; a RELEASE is later; an UNBIND first only when the planner says so", () => {
    const f = FLOORED.floor as NonNullable<GasModel["floor"]>;
    const w = f.workModel;
    const q = (list: PlannedAction[], o: { noPrincipal?: boolean } = {}) => {
      const r = kernelQuote(list, f, o);
      return [r.freshSlots, r.rewrites, r.prefixFloor] as const;
    };
    const bind = (extra: Partial<PlannedAction> = {}): PlannedAction => ({
      ...plain(ACTION.BIND),
      ...extra,
    });
    /** The quote of an empty publication plus these rows (fresh ×10, rewrites ×10, compute). */
    const rows = (...rs: [number, number, number][]) => {
      const fr = rs.reduce((t, r) => t + r[0], w.freshPerPublication);
      const rw = rs.reduce((t, r) => t + r[1], w.rwPerPublication);
      const c = rs.reduce((t, r) => t + r[2], w.computeBase + w.computePerAction * rs.length);
      const slots = Math.ceil(fr / 10);
      const rewrites = Math.ceil(rw / 10);
      return [
        slots,
        rewrites,
        c + slots * f.limits.floorFreshGas + rewrites * f.limits.floorRewriteGas,
      ];
    };
    const FIRST: [number, number, number] = [
      w.freshPerBindFirst,
      w.rwPerBindFirst,
      w.computePerBindFirst,
    ];
    const REBIND: [number, number, number] = [w.freshPerRebind, w.rwPerRebind, w.computePerRebind];
    const LATER: [number, number, number] = [
      w.freshPerBindLater,
      w.rwPerBindLater,
      w.computePerBindLater,
    ];
    const max = (...rs: [number, number, number][]): [number, number, number] => [
      Math.max(...rs.map((r) => r[0])),
      Math.max(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
    ];
    expect(q([bind()])).toEqual(rows(FIRST));
    expect(q([bind({ bindRow: "bindTagSecondAuthor" })])).toEqual(rows(FIRST));
    expect(q([bind({ bindRow: "bindFolderRebind" })])).toEqual(rows(REBIND));
    expect(q([bind({ bindRow: "bindTagNumberChange" })])).toEqual(rows(REBIND));
    expect(q([bind({ bindRow: "restoreTag" })])).toEqual(rows(LATER));
    expect(q([bind({ bindRow: "restoreFolder" })])).toEqual(rows(LATER));
    expect(q([plain(ACTION.UNBIND)])).toEqual(rows(LATER));
    expect(q([{ ...plain(ACTION.UNBIND), firstStatement: true }])).toEqual(rows(FIRST));
    expect(q([{ ...plain(ACTION.RELEASE), firstStatement: true }])).toEqual(rows(LATER));
    // A later BIND of no known row may be a re-bind or a restore: the larger of each field.
    expect(q([bind({ firstStatement: false })])).toEqual(rows(max(REBIND, LATER)));
    // Generation 1 has the later row at or above the re-bind row in every field; a model where it is not.
    const bigRebind = { ...f, workModel: { ...w, freshPerRebind: w.freshPerBindLater + 30 } };
    expect(kernelQuote([bind({ firstStatement: false })], bigRebind).freshSlots).toBe(
      Math.ceil((w.freshPerPublication + w.freshPerBindLater + 30) / 10),
    );
    // With no principal (LedgerIngress.indexFloor) every bind takes the largest of the three rows, field by field.
    expect(
      q([bind({ bindRow: "restoreTag" }), plain(ACTION.RELEASE)], { noPrincipal: true }),
    ).toEqual(rows(max(FIRST, REBIND, LATER), max(FIRST, REBIND, LATER)));
    // Every WITHDRAW after the first adds the later row; the first is in the per-publication terms.
    const withdraw = plain(ACTION.WITHDRAW);
    const withdraws = (n: number) => kernelQuote(Array(n).fill(withdraw), f);
    const later2 = rows([0, 0, 0], LATER);
    expect([withdraws(2).freshSlots, withdraws(2).rewrites, withdraws(2).prefixFloor]).toEqual(
      later2,
    );
  });

  it("the surcharge: its row of the same class is added when the purpose is the work model's surchargePurpose", () => {
    const f0 = FLOORED.floor as NonNullable<GasModel["floor"]>;
    const P = `0x${"5a".repeat(32)}` as Hex;
    const w = {
      ...f0.workModel,
      surchargePurpose: P,
      surchargeFreshFirst: 30,
      surchargeRwFirst: 40,
      surchargeComputeFirst: 5000,
      surchargeFreshLater: 10,
      surchargeRwLater: 70,
      surchargeComputeLater: 9000,
    };
    const f = { ...f0, workModel: w };
    const at = (purpose: Hex, extra: Partial<PlannedAction> = {}) =>
      kernelQuote(
        [{ ...plain(ACTION.BIND), action: { ...plain(ACTION.BIND).action, purpose }, ...extra }],
        f,
      );
    const plainFirst = kernelQuote([plain(ACTION.BIND)], f0);
    const other = `0x${"11".repeat(32)}` as Hex;
    expect(at(other)).toEqual(
      kernelQuote(
        [{ ...plain(ACTION.BIND), action: { ...plain(ACTION.BIND).action, purpose: other } }],
        f0,
      ),
    );
    const first = at(P);
    expect(first.freshSlots).toBe(
      Math.ceil((w.freshPerPublication + w.freshPerBindFirst + 30) / 10),
    );
    expect(first.prefixFloor).toBeGreaterThan(plainFirst.prefixFloor);
    const later = at(P, { bindRow: "restoreTag" });
    expect(later.rewrites).toBe(Math.ceil((w.rwPerPublication + w.rwPerBindLater + 70) / 10));
    // The kernel's own test is equality of the words, zero included (LedgerIngress._foldOne): a zero surchargePurpose
    // surcharges a zero purpose, so the planner does too (generation 1's surcharge rows are all zero).
    const zero = { ...f, workModel: { ...w, surchargePurpose: ZERO_WORD } };
    expect(kernelQuote([plain(ACTION.BIND)], zero).freshSlots).toBe(
      Math.ceil((w.freshPerPublication + w.freshPerBindFirst + 30) / 10),
    );
  });

  it("prices a record by its Type's references and specs, and an unknown Type at the dearest", () => {
    const f = FLOORED.floor as NonNullable<GasModel["floor"]>;
    const w = f.workModel;
    const span = f.types["files-span/1"] as { refs: number; specs: number };
    const quoted = (a: PlannedAction) => kernelQuote([a], f).freshSlots;
    expect(quoted(publish(96, "files-span/1"))).toBe(
      Math.ceil(
        (w.freshPerPublication +
          w.freshPerPublishFresh +
          w.freshPerDigestSpec * span.specs +
          w.freshPerRef * span.refs) /
          10,
      ),
    );
    const unknown = { action: action(ACTION.PUBLISH), body: "0x" as Hex };
    const dearest = Math.max(...Object.values(f.types).map((t) => t.refs));
    expect(quoted(unknown)).toBeGreaterThanOrEqual(
      Math.ceil((w.freshPerPublication + w.freshPerPublishFresh + w.freshPerRef * dearest) / 10),
    );
  });

  it("refuses to plan when the chain's kernel floor is not the model's, or the formula is not one it implements", () => {
    const d = { kernelFloor: null } as unknown as DeploymentInfo;
    expect(floorMismatch(d, FLOORED)).toBeNull();
    const f = FLOORED.floor as NonNullable<GasModel["floor"]>;
    const same = {
      kernelFloor: { workModel: { ...f.workModel }, ...f.limits },
    } as unknown as DeploymentInfo;
    expect(floorMismatch(same, FLOORED)).toBeNull();
    const heavier = {
      kernelFloor: { workModel: { ...f.workModel, finalComputePerBind: 120_000 }, ...f.limits },
    } as unknown as DeploymentInfo;
    expect(floorMismatch(heavier, FLOORED)?.detail).toMatch(/workModel.finalComputePerBind/);
    const { floor: _none, ...unfloored } = FLOORED;
    expect(floorMismatch(same, unfloored)?.code).toBe("UNSUPPORTED_PROFILE");
    const formula2 = {
      ...FLOORED,
      floor: { ...f, workModel: { ...f.workModel, formulaVersion: 2 } },
    };
    expect(floorMismatch(d, formula2)?.detail).toMatch(/formula 2; this SDK plans with formula 3/);
    // The surcharge purpose is a word: compared as one, whatever its case.
    const word = (w: string) =>
      ({
        kernelFloor: { workModel: { ...f.workModel, surchargePurpose: w }, ...f.limits },
      }) as unknown as DeploymentInfo;
    const P = `0x${"ab".repeat(32)}`;
    const withP = {
      ...FLOORED,
      floor: { ...f, workModel: { ...f.workModel, surchargePurpose: P as Hex } },
    };
    expect(floorMismatch(word(P.toUpperCase().replace("0X", "0x")), withP)).toBeNull();
    expect(floorMismatch(word(P), FLOORED)?.detail).toMatch(/workModel.surchargePurpose/);
  });

  it("an atomic batch counts each part's floor; the budget is the contracts' integer rule", () => {
    expect(budgetOf(CAP)).toBe(14_260_633);
    const part = {
      actions: releases(20).map((a) => a.action),
      bodies: releases(20).map(() => "0x" as Hex),
    };
    const g = { model: FLOORED, txGasCap: CAP };
    const one = partGas(part, FLOORED);
    expect(one).toBeGreaterThan(partGas(part, MODEL));
    expect(packBatches([part, part, part], g).every((b) => b.length * one <= budgetOf(CAP))).toBe(
      true,
    );
    expect(priceAsNew(0)).toBe(true);
    expect(priceAsNew(1)).toBe(true);
    expect(priceAsNew(2)).toBe(false);
    expect(priceAsNew(10)).toBe(true);
  });
});
