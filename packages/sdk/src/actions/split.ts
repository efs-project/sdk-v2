// SPDX-License-Identifier: MIT
// Split an ordered list of actions into publications that each fit one transaction: the Realm's batch limits
// (LedgerCore._bounds: actions, BIND/UNBIND/RELEASE count, summed body bytes) and a gas budget under the
// per-transaction cap, estimated with the contracts' fitted gas model (release.json `gasModel`). Order is kept,
// because a record must be published no later than the publication that references it, and `group`s never split
// (a file's finish — revision, name, CREATE, HEAD and FOLDER binds — appears atomically or not at all).
//
// The estimate is the model's (fixed + Σ actions) plus what the model excludes: the 21,000 intrinsic gas and the
// calldata of the encoded call, priced as if every byte were non-zero. Plans aim at txGasCap × (1 − headroom), the
// contracts' budget rule with their 15% default (the fit's stated error is ~6–8%). eth_estimateGas on the exact call
// stays the authority before anything is sent (sendPlan refuses an estimate over the cap).
import { type Reason, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ACTION } from "../generated/constants.js";
import { GAS_ENVELOPE, GAS_SCHEDULES } from "../generated/gas.js";
import type { ActionData } from "./types.js";

/** One fee schedule's fitted constants (release.json gasModel.schedules[name]; generated as GAS_SCHEDULES). */
export interface GasConstants {
  fixed: number;
  perWord: number;
  perByte: number;
  /**
   * PUBLISH of a new record, by shape ("files-bytes/1", "files-child/1 form 0", "files-content/1 carrier 2", …),
   * before the per-word and per-byte terms. An unknown shape is priced at the most expensive one.
   */
  publishNew: Readonly<Record<string, number>>;
  /** PUBLISH of a record that already exists (no body storage). */
  publishExisting: number;
  reuse: number;
  create: number;
  bindHeadFresh: number;
  bindHeadRebind: number;
  bindFolderFreshFile: number;
  bindFolderFreshDirectory: number;
  bindFolderRebind: number;
  unbindFolder: number;
  releaseFolder: number;
  withdraw: number;
  /** Added once to a principal's first publication ever. */
  firstWriteSurcharge: number;
}

/** The model the planner splits with: what the per-transaction cap counts, for one fee schedule. */
export interface GasModel extends GasConstants {
  /** Fee schedule name, e.g. "prague". A model is never applied to a chain priced by another schedule. */
  schedule: string;
  /** Set when the cap counts only execution gas (amsterdam): all gas, which must also fit the block. */
  total?: GasConstants;
}

/** The gas-model row a BIND is priced at. Without one, the most expensive BIND row. */
export type BindRow =
  | "bindHeadFresh"
  | "bindHeadRebind"
  | "bindFolderFreshFile"
  | "bindFolderFreshDirectory"
  | "bindFolderRebind";
const BIND_ROWS: readonly BindRow[] = [
  "bindHeadFresh",
  "bindHeadRebind",
  "bindFolderFreshFile",
  "bindFolderFreshDirectory",
  "bindFolderRebind",
];

export interface PlannedAction {
  action: ActionData;
  /** The body, for PUBLISH; "0x" otherwise. */
  body: Hex;
  /** The record's shape key in the gas model; unknown shapes are priced at the model's most expensive one. */
  shape?: string;
  /** True when the record is known to exist already (priced as publishExisting). */
  exists?: boolean;
  /** For a BIND: the row it is priced at, when the planner knows (a fresh HEAD, a rebind, …). */
  bindRow?: BindRow;
  /** Consecutive actions with the same group id are kept in one publication. */
  group?: number;
}

export interface BatchLimits {
  maxActionsPerPublication: number;
  maxBodyBytesPerPublication: number;
  maxBindsPerPublication: number;
  /** One record body (Limits.maxBody). */
  maxBodyBytes: number;
}

export interface SplitOptions {
  model: GasModel;
  limits: BatchLimits;
  /** The per-transaction gas cap (EIP-7825; 2^24 unless the chain says otherwise). */
  txGasCap: bigint;
  /** Plan to txGasCap × (1 − headroom), the contracts' budget rule. Default 0.15. */
  headroom?: number;
  /** With `model.total`: every publication's whole gas must also fit this block gas limit (with the headroom). */
  blockGasLimit?: bigint;
  /** The principal has never published: the first part pays the model's firstWriteSurcharge. */
  firstWrite?: boolean;
}

export interface SplitPart {
  actions: PlannedAction[];
  /** The planning estimate (model + intrinsic + calldata), never the authority. */
  gas: number;
}

export type SplitResult =
  | { ok: true; parts: SplitPart[]; budget: number }
  /** `at`: the index of the first action that cannot fit even alone (or in its group). */
  | { ok: false; reason: Reason; at: number };

const INTRINSIC = 21_000;
/** One encoded Action tuple (9 words) plus its body's offset and length words. */
const ACTION_BYTES = 11 * 32;
/** execute(...) selector, the native context and the two array headers, rounded up. */
const CALL_OVERHEAD_BYTES = 1024;
const NONZERO_BYTE = 16;

const bodyLen = (b: Hex): number => (b.length - 2) / 2;
const isBindLike = (k: number): boolean =>
  k === ACTION.BIND || k === ACTION.UNBIND || k === ACTION.RELEASE;

/** The model's gas for one action (without the per-publication terms). */
export function actionGas(a: PlannedAction, m: GasConstants): number {
  const k = a.action.kind;
  if (k === ACTION.PUBLISH) {
    if (a.exists) return m.publishExisting;
    const n = bodyLen(a.body);
    const base =
      (a.shape !== undefined ? m.publishNew[a.shape] : undefined) ??
      Math.max(0, ...Object.values(m.publishNew));
    return base + m.perWord * Math.ceil(n / 32) + m.perByte * n;
  }
  if (k === ACTION.REUSE) return m.reuse;
  if (k === ACTION.CREATE) return m.create;
  if (k === ACTION.BIND)
    return a.bindRow !== undefined ? m[a.bindRow] : Math.max(...BIND_ROWS.map((r) => m[r]));
  if (k === ACTION.UNBIND) return m.unbindFolder;
  if (k === ACTION.RELEASE) return m.releaseFolder;
  if (k === ACTION.WITHDRAW) return m.withdraw;
  // an unknown kind: priced high, never zero
  return Math.max(m.create, m.unbindFolder, ...BIND_ROWS.map((r) => m[r]));
}

/**
 * The planning estimate of one publication: model + intrinsic + calldata (all bytes priced as non-zero), plus the
 * first-write surcharge when `firstWrite`.
 */
export function publicationGas(
  actions: readonly PlannedAction[],
  m: GasConstants,
  firstWrite = false,
): number {
  let gas = m.fixed + INTRINSIC + CALL_OVERHEAD_BYTES * NONZERO_BYTE;
  if (firstWrite) gas += Math.max(0, m.firstWriteSurcharge);
  for (const a of actions) {
    const n = bodyLen(a.body);
    gas += actionGas(a, m) + (ACTION_BYTES + Math.ceil(n / 32) * 32) * NONZERO_BYTE;
  }
  return Math.ceil(gas);
}

interface Tally {
  actions: number;
  binds: number;
  bodyBytes: number;
}
const tally = (list: readonly PlannedAction[]): Tally => ({
  actions: list.length,
  binds: list.filter((a) => isBindLike(a.action.kind)).length,
  bodyBytes: list.reduce((n, a) => n + bodyLen(a.body), 0),
});

/** Consecutive actions sharing a group id form one unit; every other action is a unit of its own. */
function units(actions: readonly PlannedAction[]): { start: number; list: PlannedAction[] }[] {
  const out: { start: number; list: PlannedAction[] }[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] as PlannedAction;
    const last = out[out.length - 1];
    if (a.group !== undefined && last && last.list[0]?.group === a.group) last.list.push(a);
    else out.push({ start: i, list: [a] });
  }
  return out;
}

/** Greedy, order-keeping split: each publication takes as many whole units as fit. */
export function splitPublications(actions: readonly PlannedAction[], o: SplitOptions): SplitResult {
  const { model: m, limits: L } = o;
  const keep = 1 - (o.headroom ?? 0.15);
  const budget = Math.floor(Number(o.txGasCap) * keep);
  const blockBudget =
    m.total && o.blockGasLimit !== undefined
      ? Math.floor(Number(o.blockGasLimit) * keep)
      : undefined;
  for (let i = 0; i < actions.length; i++) {
    const n = bodyLen((actions[i] as PlannedAction).body);
    if (n > L.maxBodyBytes)
      return {
        ok: false,
        at: i,
        reason: reason(
          "LIMIT_EXCEEDED",
          "after-replan",
          `a ${n}-byte body is over the ${L.maxBodyBytes}-byte record limit: chunk it`,
        ),
      };
  }
  const fits = (list: readonly PlannedAction[], first: boolean): true | Reason => {
    const t = tally(list);
    if (t.actions > L.maxActionsPerPublication)
      return reason(
        "LIMIT_EXCEEDED",
        "after-replan",
        `${t.actions} actions; the limit is ${L.maxActionsPerPublication}`,
      );
    if (t.binds > L.maxBindsPerPublication)
      return reason(
        "LIMIT_EXCEEDED",
        "after-replan",
        `${t.binds} binds; the limit is ${L.maxBindsPerPublication}`,
      );
    if (t.bodyBytes > L.maxBodyBytesPerPublication)
      return reason(
        "LIMIT_EXCEEDED",
        "after-replan",
        `${t.bodyBytes} body bytes; the limit is ${L.maxBodyBytesPerPublication}`,
      );
    const gas = publicationGas(list, m, first && o.firstWrite === true);
    if (gas > budget)
      return reason(
        "OVER_TX_GAS_CAP",
        "after-replan",
        `~${gas} gas; the budget is ${budget} (cap ${o.txGasCap})`,
      );
    if (m.total && blockBudget !== undefined) {
      const all = publicationGas(list, m.total, first && o.firstWrite === true);
      if (all > blockBudget)
        return reason(
          "OVER_TX_GAS_CAP",
          "after-replan",
          `~${all} gas in all; the block budget is ${blockBudget} (block gas limit ${o.blockGasLimit})`,
        );
    }
    return true;
  };
  const parts: SplitPart[] = [];
  let current: PlannedAction[] = [];
  const gasOf = (list: readonly PlannedAction[], first: boolean): number =>
    publicationGas(list, m, first && o.firstWrite === true);
  for (const u of units(actions)) {
    const alone = fits(u.list, parts.length === 0 && current.length === 0);
    if (alone !== true) return { ok: false, reason: alone, at: u.start };
    if (current.length && fits([...current, ...u.list], parts.length === 0) !== true) {
      parts.push({ actions: current, gas: gasOf(current, parts.length === 0) });
      current = [];
    }
    current.push(...u.list);
  }
  if (current.length) parts.push({ actions: current, gas: gasOf(current, parts.length === 0) });
  return { ok: true, parts, budget };
}

/** EIP-7825's per-transaction gas cap (2^24): the default when the deployment document states none. */
export const TX_GAS_CAP: bigint = BigInt(GAS_ENVELOPE.txGasCap);
/** The cap of this deployment's chain (efs-deployment.chain.txGasCap). Always enforced. */
export const txGasCapOf = (d: DeploymentInfo): bigint => d.chain?.txGasCap ?? TX_GAS_CAP;

export type GasPlan =
  | {
      ok: true;
      model: GasModel;
      txGasCap: bigint;
      /** The contracts' planning headroom (GAS_ENVELOPE.headroomPercent / 100). */
      headroom: number;
      blockGasLimit?: bigint;
    }
  | { ok: false; reason: Reason };

/**
 * The gas model and cap to split with on this deployment's chain: the schedule `chain.feeSchedule` names, else the
 * one whose hardforks include `chain.hardfork`. Refused, never guessed, when the document has no `chain` block or
 * names a schedule this SDK was not generated with (pass an explicit model instead).
 */
export function gasPlanFor(d: DeploymentInfo): GasPlan {
  const chain = d.chain;
  if (!chain)
    return {
      ok: false,
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        "the deployment document has no `chain` block naming its fee schedule: pass a gas model",
      ),
    };
  type Schedule = {
    hardforks: readonly string[];
    constants: Omit<GasConstants, never>;
    executionGas?: Omit<GasConstants, never>;
  };
  const all = GAS_SCHEDULES as unknown as Readonly<Record<string, Schedule>>;
  const name =
    chain.feeSchedule ??
    Object.keys(all).find((k) => (all[k] as Schedule).hardforks.includes(chain.hardfork));
  const sch = name !== undefined ? all[name] : undefined;
  if (!name || !sch)
    return {
      ok: false,
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        `no gas model for ${chain.feeSchedule ? `fee schedule ${chain.feeSchedule}` : `hardfork ${chain.hardfork}`} in this SDK (it has ${Object.keys(all).join(", ")})`,
      ),
    };
  const model: GasModel = sch.executionGas
    ? { ...sch.executionGas, schedule: name, total: sch.constants }
    : { ...sch.constants, schedule: name };
  return {
    ok: true,
    model,
    txGasCap: chain.txGasCap,
    headroom: GAS_ENVELOPE.headroomPercent / 100,
    ...(chain.blockGasLimit !== null ? { blockGasLimit: chain.blockGasLimit } : {}),
  };
}
