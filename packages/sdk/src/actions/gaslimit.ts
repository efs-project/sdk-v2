// SPDX-License-Identifier: MIT
// The gas limit a send sets on its transaction, per fee profile (contracts dev and PM, 2026-11-26, from the EIP
// texts: EIP-7825 Final, EIP-7623 Final, EIP-8037 Last Call).
//
// prague / osaka: EIP-7825 caps tx.gas itself at 2^24. The limit is a quarter over the node's estimate, at most the
// cap, and an estimate over the cap is refused (split the save).
//
// amsterdam (EIP-8037): the cap bounds the execution part only. gas_left = min(2^24 − intrinsic, tx.gas − intrinsic),
// and whatever tx.gas holds above that is the state-gas reservoir, which state gas is drawn from first (then from
// gas_left). tx.gas may go up to 2^32 − 1. So a limit clamped at 2^24 starves a large-state publication (a deep
// first tag is ~3.3M execution + ~14.4M state): its state gas would come out of the execution budget. Here the limit
// is never below the model's whole gas (execution + state) with a margin, and once it is over 2^24 the reservoir
// alone holds the state gas with that margin (tx.gas ≥ 2^24 + 1.15 × state), so the execution budget stays whole.
// A block includes a transaction only while tx.gas ≤ the block's state gas still available (the block gas limit
// less its state gas used), so the limit is also never above the block gas limit when the deployment states it:
// any tx.gas ≥ the whole gas runs (state gas spills from the reservoir into gas_left), the margin is what is lost.
// Sepolia runs Glamsterdam (2026-11), and the contracts dev measured it there on Geth 1.17.9 and reth 2.11.0
// (tools/state-gas-probe.mjs, docs/GAS-SCHEDULES.md): over 2^24 a transaction starts with exactly the cap less
// intrinsic gas and draws state gas from the reservoir, and eth_estimateGas returns execution plus state gas, above
// 2^24 where it needs to be. Plain eth_call is not the rule on Geth (it does not cap ordinary gas), so nothing here
// reads the cap or the reservoir from it. Tested as arithmetic, against those measurements, and through the send
// path with the fixture's deployment named amsterdam (the fixture runs prague).
import type { DeploymentInfo } from "../deployment/manifest.js";
import { feeScheduleOf, txGasCapOf } from "./split.js";

/** EIP-8037's ceiling on tx.gas (2^32 − 1): the reservoir profile's limit never goes above it. */
export const TX_GAS_HARD_MAX: bigint = 2n ** 32n - 1n;

/** Gas to aim for per publication when splitting (contracts' guidance: about 14M, headroom under the cap). */
const SPLIT_TARGET = 14_000_000n;

/** The margin on the model's figures (its error is under 8% on every schedule today; the headroom check guards it). */
const MARGIN_PERCENT = 115n;

const ceilPercent = (x: bigint, percent: bigint): bigint => (x * percent + 99n) / 100n;
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const whole = (n: number): bigint => BigInt(Math.max(0, Math.ceil(n)));

export interface GasLimitInput {
  /** True on a schedule that splits execution gas from state gas (EIP-8037, amsterdam): see reservoirProfile. */
  reservoir: boolean;
  /** The per-transaction cap (EIP-7825), 2^24 unless the deployment states another. */
  cap: bigint;
  /** eth_estimateGas on the exact call. */
  estimate: bigint;
  /** The planner's figures for this publication (Plan.plannedGas), when a planner made it. */
  model?: { execution: number; total: number };
  /** The chain's block gas limit (efs-deployment chain.blockGasLimit), when stated: a reservoir limit stays under it. */
  blockGasLimit?: bigint;
}

export type GasLimit =
  | { ok: true; gas: bigint }
  /**
   * Nothing can be sent: split the save. `execution` is the publication's execution part; `suggestedParts` how many
   * publications to split it into: by the execution part when that is over the cap, by the whole gas against 85% of
   * the ceiling (the block gas limit or 2^32 − 1) when the whole is what can't fit.
   */
  | { ok: false; execution: bigint; detail: string; suggestedParts: number };

/** ⌈gas / per⌉, with `per` at least 1: a tiny or zero ceiling (a block gas limit of 1, or 0 passed in) never divides by 0. */
const partsFor = (gas: bigint, per: bigint): number => {
  const d = per > 0n ? per : 1n;
  return Number((gas + d - 1n) / d);
};

/**
 * The gas limit to sign or ask the wallet for, or a refusal. On a reservoir profile the node's estimate counts state
 * gas (measured on Sepolia), and the rule stays safe if a node's did not: the limit is at
 * least the estimate × 1.25 and at least the model's whole gas × 1.15, and the send is refused when the execution
 * part is over the cap under the reading that leaves it smallest (the estimate less the model's state gas) or by the
 * model's own execution figure, or when the model's whole gas can't fit under 2^32 − 1 or the block gas limit. The
 * limit is at most 2^32 − 1 and the block gas limit. With no model figures, the estimate × 1.25 alone, under the
 * same ceiling, never refused for size.
 */
export function gasLimitOf(g: GasLimitInput): GasLimit {
  const quarterOver = (g.estimate * 5n) / 4n;
  if (!g.reservoir) {
    if (g.estimate > g.cap)
      return {
        ok: false,
        execution: g.estimate,
        detail: `the publication needs ~${g.estimate} gas, over the per-transaction cap of ${g.cap}`,
        suggestedParts: partsFor(g.estimate, SPLIT_TARGET),
      };
    return { ok: true, gas: min(quarterOver, g.cap) };
  }
  // Without the planner's figures the state gas is unknown, so the estimate alone sets the limit and nothing is
  // refused for size: a node returns an estimate only for a limit that runs (one whose execution can't fit 2^24
  // fails to estimate), and the estimate may be mostly state gas.
  const ceiling =
    g.blockGasLimit !== undefined ? min(TX_GAS_HARD_MAX, g.blockGasLimit) : TX_GAS_HARD_MAX;
  if (!g.model) return { ok: true, gas: min(quarterOver, ceiling) };
  const execution = whole(g.model.execution);
  const total = max(whole(g.model.total), execution);
  const state = total - execution;
  const executionPart = max(g.estimate > state ? g.estimate - state : 0n, execution);
  if (executionPart > g.cap)
    return {
      ok: false,
      execution: executionPart,
      detail: `the publication's execution needs ~${executionPart} gas, over the per-transaction cap of ${g.cap} (state gas is not counted against it)`,
      suggestedParts: partsFor(executionPart, SPLIT_TARGET),
    };
  if (total > ceiling)
    return {
      ok: false,
      execution: executionPart,
      detail: `the publication needs ~${total} gas in all, over the largest gas limit a transaction can have here (${ceiling}${ceiling < TX_GAS_HARD_MAX ? ", the block gas limit" : ""})`,
      suggestedParts: partsFor(total, (ceiling * 85n) / 100n),
    };
  let gas = max(quarterOver, ceilPercent(total, MARGIN_PERCENT));
  // Over the cap, the reservoir (tx.gas above 2^24) must hold all the state gas, with the margin.
  if (gas > g.cap) gas = max(gas, g.cap + ceilPercent(state, MARGIN_PERCENT));
  return { ok: true, gas: min(gas, ceiling) };
}

/**
 * True when the deployment's fee schedule splits execution gas from state gas (the vendored schedule has
 * `executionGas`, as amsterdam does: EIP-8037's reservoir). Decided by the schedule alone: a deployment the planners
 * refuse (a kernel floor the model does not price) still sends under its chain's rule. A chain with no vendored
 * schedule is taken as not, and gets the 2^24 clamp EIP-7825 chains need.
 */
export function reservoirProfile(d: DeploymentInfo): boolean {
  return feeScheduleOf(d)?.schedule.executionGas !== undefined;
}

/** gasLimitOf for a plan on this deployment: its profile, its cap and the planner's figures it carries. */
export const planGasLimit = (
  d: DeploymentInfo,
  plan: { plannedGas?: { execution: number; total: number } },
  estimate: bigint,
): GasLimit =>
  gasLimitOf({
    reservoir: reservoirProfile(d),
    cap: txGasCapOf(d),
    estimate,
    ...(plan.plannedGas ? { model: plan.plannedGas } : {}),
    ...(d.chain?.blockGasLimit != null ? { blockGasLimit: d.chain.blockGasLimit } : {}),
  });
