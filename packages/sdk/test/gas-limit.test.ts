// SPDX-License-Identifier: MIT
// The gas limit a send sets, per fee profile (contracts dev and PM, 2026-11-26, from EIP-8037 / EIP-7825 / EIP-7623).
//   prague / osaka (no state-gas reservoir): min(estimate × 1.25, cap), refused over the cap. Unchanged.
//   amsterdam (EIP-8037 reservoir): the cap bounds the EXECUTION part (intrinsic + execution ≤ 2^24), and state gas is
//   drawn from the reservoir, the overflow of tx.gas above 2^24. So tx.gas is never clamped at 2^24. It is never below
//   the model's execution plus state gas (× 1.15), and above the cap it is 2^24 + 1.15 × state gas, giving the full
//   execution budget with the state gas from the reservoir; at most 2^32 − 1. Whether a Glamsterdam node's
//   eth_estimateGas counts state gas is unconfirmed, so both readings are safe: refused only when the execution part
//   is over the cap under either.
// No chain runs amsterdam yet (the fixture is prague and osaka): these are the EIP-text rules, tested as arithmetic.
import { describe, expect, it } from "vitest";
import {
  gasLimitOf,
  planGasLimit,
  reservoirProfile,
  TX_GAS_HARD_MAX,
} from "../src/actions/gaslimit.ts";
import { batchGasOf, gasPlanFor, splitPublications } from "../src/actions/split.ts";
import { ZERO_WORD } from "../src/core/hex.ts";
import type { DeploymentInfo } from "../src/deployment/manifest.ts";
import { ACTION } from "../src/generated/constants.ts";

const CAP = 16_777_216n; // 2^24
const M = (n: number) => BigInt(Math.round(n * 1e6));

describe("gasLimitOf: prague and osaka, unchanged", () => {
  it("a quarter over the estimate, at most the cap; over the cap is refused", () => {
    expect(gasLimitOf({ reservoir: false, cap: CAP, estimate: M(1) })).toEqual({
      ok: true,
      gas: M(1.25),
    });
    expect(gasLimitOf({ reservoir: false, cap: CAP, estimate: M(15) })).toEqual({
      ok: true,
      gas: CAP,
    });
    expect(gasLimitOf({ reservoir: false, cap: CAP, estimate: M(20) })).toMatchObject({
      ok: false,
    });
  });
});

describe("gasLimitOf: amsterdam, with the state-gas reservoir", () => {
  // The contracts' measured shapes (gas/model.json profiles.amsterdam validation), as the planner's figures:
  // execution includes intrinsic and calldata, total adds the state gas.
  const edit = { execution: 740_685, total: 740_685 + 1_762_560 };
  const deepTag = { execution: 3_280_000, total: 17_677_066 };

  it("a small publication: the estimate (with or without state gas) or the model's whole figure, whichever is more", () => {
    // The node counts state gas: its estimate is the whole.
    expect(
      gasLimitOf({ reservoir: true, cap: CAP, estimate: BigInt(edit.total), model: edit }),
    ).toEqual({
      ok: true,
      gas: (BigInt(edit.total) * 5n) / 4n,
    });
    // The node counts execution only: never below the model's execution plus state gas.
    const g = gasLimitOf({
      reservoir: true,
      cap: CAP,
      estimate: BigInt(edit.execution),
      model: edit,
    });
    expect(g).toEqual({ ok: true, gas: BigInt(Math.ceil(edit.total * 1.15)) });
  });

  it("a deep first tag (3.3M execution + 14.4M state): over 2^24, never clamped to it, its state gas in the reservoir", () => {
    for (const estimate of [BigInt(deepTag.total), BigInt(deepTag.execution)]) {
      const g = gasLimitOf({ reservoir: true, cap: CAP, estimate, model: deepTag });
      if (!g.ok) throw new Error("refused");
      const state = BigInt(deepTag.total - deepTag.execution);
      expect(g.gas).toBeGreaterThan(CAP);
      // The reservoir (tx.gas above 2^24) holds the state gas with its margin: the execution budget stays whole.
      expect(g.gas - CAP).toBeGreaterThanOrEqual((state * 115n) / 100n);
    }
  });

  it("refused only when the execution part is over the cap under either reading of the estimate", () => {
    // 30M estimated, 14.4M of it state gas: the execution part (15.6M) fits, so it goes out.
    expect(gasLimitOf({ reservoir: true, cap: CAP, estimate: M(30), model: deepTag }).ok).toBe(
      true,
    );
    // 40M estimated: even taking the state gas out, the execution part is over 2^24.
    expect(
      gasLimitOf({ reservoir: true, cap: CAP, estimate: M(40), model: deepTag }),
    ).toMatchObject({ ok: false });
    // The model's own execution figure over the cap is refused too.
    expect(
      gasLimitOf({
        reservoir: true,
        cap: CAP,
        estimate: M(1),
        model: { execution: 17_000_000, total: 20_000_000 },
      }),
    ).toMatchObject({ ok: false });
  });

  it("at most 2^32 − 1, and refused when even the unmargined whole can't fit under it", () => {
    const huge = { execution: 10_000_000, total: 4_000_000_000 };
    const g = gasLimitOf({ reservoir: true, cap: CAP, estimate: M(10), model: huge });
    expect(g).toEqual({ ok: true, gas: TX_GAS_HARD_MAX });
    const over = { execution: 10_000_000, total: 5_000_000_000 };
    expect(gasLimitOf({ reservoir: true, cap: CAP, estimate: M(10), model: over })).toMatchObject({
      ok: false,
    });
  });

  it("never above the block gas limit (a block includes tx.gas only up to its state gas available)", () => {
    // 60M block: the deep tag's 33.3M fits; a 45M-state save is clamped to the block (it still runs: ≥ its whole).
    const block = 60_000_000n;
    const deep = gasLimitOf({
      reservoir: true,
      cap: CAP,
      estimate: BigInt(deepTag.total),
      model: deepTag,
      blockGasLimit: block,
    });
    expect(deep.ok && deep.gas).toBeGreaterThan(30_000_000n);
    const big = { execution: 3_000_000, total: 48_000_000 };
    const g = gasLimitOf({
      reservoir: true,
      cap: CAP,
      estimate: M(48),
      model: big,
      blockGasLimit: block,
    });
    expect(g).toEqual({ ok: true, gas: block });
    // A whole that no block can hold is refused, and so is the estimate alone past the block (no figures) clamped.
    expect(
      gasLimitOf({
        reservoir: true,
        cap: CAP,
        estimate: M(1),
        model: { execution: 3_000_000, total: 61_000_000 },
        blockGasLimit: block,
      }),
    ).toMatchObject({ ok: false });
    expect(
      gasLimitOf({ reservoir: true, cap: CAP, estimate: M(70), blockGasLimit: block }),
    ).toEqual({
      ok: true,
      gas: block,
    });
  });

  it("with no model figures (a plan made outside the planners), the estimate alone, never clamped at 2^24", () => {
    // The state gas is unknown, so an estimate over the cap is not refused: a node returns an estimate only for a
    // gas limit that runs, and one whose execution can't fit 2^24 fails to estimate at all.
    expect(gasLimitOf({ reservoir: true, cap: CAP, estimate: M(20) })).toEqual({
      ok: true,
      gas: M(25),
    });
    expect(gasLimitOf({ reservoir: true, cap: CAP, estimate: 4_000_000_000n })).toEqual({
      ok: true,
      gas: TX_GAS_HARD_MAX,
    });
  });
});

const chainOf = (hardfork: string, feeSchedule: string) =>
  ({
    chain: { hardfork, feeSchedule, txGasCap: CAP, blockGasLimit: 100_000_000n },
  }) as unknown as DeploymentInfo;
const PRAGUE = chainOf("prague", "prague");
const OSAKA = chainOf("osaka", "prague");
const AMSTERDAM = chainOf("amsterdam", "amsterdam");

describe("the profile comes from the deployment's fee schedule", () => {
  it("amsterdam (execution gas split from state gas) is a reservoir profile; prague, osaka and no model are not", () => {
    expect(reservoirProfile(AMSTERDAM)).toBe(true);
    expect(reservoirProfile(PRAGUE)).toBe(false);
    expect(reservoirProfile(OSAKA)).toBe(false);
    expect(reservoirProfile({ chain: null } as unknown as DeploymentInfo)).toBe(false);
    expect(reservoirProfile(chainOf("glamsterdam-next", "no-such-schedule"))).toBe(false);
  });

  it("by the schedule alone: a kernel floor the planners refuse still sends under amsterdam's rule", () => {
    const odd = {
      ...AMSTERDAM,
      kernelFloor: {
        workModel: { formulaVersion: 2 },
        floorFreshGas: 1,
        floorRewriteGas: 1,
        kernelTail: 1,
      },
    } as unknown as DeploymentInfo;
    expect(gasPlanFor(odd).ok).toBe(false);
    expect(reservoirProfile(odd)).toBe(true);
  });

  it("planGasLimit: the same plan and estimate, clamped at 2^24 on osaka, its state gas in the reservoir on amsterdam", () => {
    const plan = { plannedGas: { execution: 3_280_000, total: 17_677_066 } };
    expect(planGasLimit(OSAKA, plan, M(14))).toEqual({ ok: true, gas: CAP });
    const a = planGasLimit(AMSTERDAM, plan, M(14));
    expect(a.ok && a.gas).toBeGreaterThan(CAP + 14_397_066n);
    // Without the planner's figures, the estimate alone.
    expect(planGasLimit(AMSTERDAM, {}, M(14))).toEqual({ ok: true, gas: M(17.5) });
  });
});

describe("a deep first tag, priced by the splitter on the vendored amsterdam model", () => {
  it("the part's figures give a limit over 2^24 whose reservoir holds its state gas", () => {
    const p = gasPlanFor(AMSTERDAM);
    if (!p.ok) throw new Error(p.reason.detail);
    const bind = {
      action: {
        kind: ACTION.BIND,
        typeId: ZERO_WORD,
        bodyHashOrRecordId: ZERO_WORD,
        purpose: ZERO_WORD,
        subject: ZERO_WORD,
        role: ZERO_WORD,
        target: ZERO_WORD,
        expectedRevision: 0n,
        saltOrStrength: ZERO_WORD,
      },
      body: "0x" as const,
      bindRow: "bindHeadFresh" as const,
      // A first statement on a 64-level topic: every level of its path is new, mine and shared.
      levels: { mineNew: 64, sharedNew: 64 },
    };
    const r = splitPublications([bind], {
      model: p.model,
      limits: {
        maxActionsPerPublication: 64,
        maxBodyBytesPerPublication: 1 << 20,
        maxBindsPerPublication: 32,
        maxBodyBytes: 8192,
      },
      txGasCap: CAP,
      blockGasLimit: 100_000_000n,
    });
    if (!r.ok) throw new Error(r.reason.detail);
    expect(r.parts).toHaveLength(1);
    const figures = batchGasOf(r.parts[0] as never);
    const model = { execution: figures.gas, total: figures.total as number };
    const state = BigInt(model.total - model.execution);
    // The shape the contracts measured (~3.28M execution + ~14.4M state): the whole is over 2^24.
    expect(model.execution).toBeGreaterThan(3_000_000);
    expect(model.execution).toBeLessThan(3_500_000);
    expect(model.total).toBeGreaterThan(Number(CAP));
    for (const estimate of [BigInt(model.total), BigInt(model.execution)]) {
      const g = gasLimitOf({ reservoir: true, cap: CAP, estimate, model });
      if (!g.ok) throw new Error(g.detail);
      expect(g.gas).toBeGreaterThan(CAP);
      expect(g.gas - CAP).toBeGreaterThanOrEqual((state * 115n) / 100n);
      expect(g.gas).toBeGreaterThanOrEqual(BigInt(model.total));
    }
    // On a profile without the reservoir the same estimate is over the cap: refused, as today.
    expect(gasLimitOf({ reservoir: false, cap: CAP, estimate: BigInt(model.total) }).ok).toBe(
      false,
    );
  });
});

describe("batchGasOf: total − gas is the state gas", () => {
  it("the floor's extra visible gas (V over E) is added to both figures", () => {
    const part = {
      actions: [],
      gas: 1_000_000,
      rule: { E: 900_000, K: 900_000, V: 1_200_000, quote: null },
      total: 9_000_000,
    };
    expect(batchGasOf(part)).toEqual({ gas: 1_300_000, total: 9_300_000 });
    const f = batchGasOf(part);
    expect((f.total as number) - f.gas).toBe(part.total - part.gas);
    // Without V over E, or without a total (prague), unchanged.
    expect(batchGasOf({ ...part, rule: { ...part.rule, V: 800_000 } })).toEqual({
      gas: 1_000_000,
      total: 9_000_000,
    });
    const { total: _t, ...prague } = part;
    expect(batchGasOf(prague)).toEqual({ gas: 1_300_000 });
  });
});
