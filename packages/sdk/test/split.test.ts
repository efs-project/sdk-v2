// SPDX-License-Identifier: MIT
// The publication splitter against the contracts' measurements (an 8,192-byte chunk ≈ 6.09M: two per transaction),
// the kernel's batch limits (LedgerCore._bounds), atomic groups, and honest refusals.
import { describe, expect, it } from "vitest";
import {
  type GasModel,
  gasPlanFor,
  type PlannedAction,
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
  salt: ZERO_WORD,
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
    // The envelope counts model gas only; the SDK adds intrinsic and calldata, so it may fit one or two fewer.
    expect(GAS_ENVELOPE.txGasCap).toBe(16_777_216);
    const count = (n: number, shape: string) => {
      const r = split(Array.from({ length: 200 }, (_, i) => publish(n + (i % 2), shape)));
      if (!r.ok) throw new Error(r.reason.detail);
      return (r.parts[0] as { actions: unknown[] }).actions.length;
    };
    expect(count(8191, "files-bytes/1")).toBe(2); // contracts envelope: chunk × 2
    const spans = count(95, "files-span/1");
    expect(spans).toBeLessThanOrEqual(36); // contracts envelope: spanNode × 36
    expect(spans).toBeGreaterThanOrEqual(34);
  });

  it("prices BINDs by row, and the first-write surcharge only on the first part", () => {
    const head = (row?: "bindHeadFresh" | "bindHeadRebind"): PlannedAction => ({
      ...plain(ACTION.BIND),
      ...(row ? { bindRow: row } : {}),
    });
    const g = (a: PlannedAction) => publicationGas([a], MODEL) - publicationGas([], MODEL);
    expect(g(head("bindHeadRebind"))).toBeLessThan(g(head("bindHeadFresh")));
    expect(g(head())).toBe(g({ ...plain(ACTION.BIND), bindRow: "bindFolderFreshFile" })); // the largest row
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
