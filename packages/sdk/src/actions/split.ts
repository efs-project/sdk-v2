// SPDX-License-Identifier: MIT
// Split an ordered list of actions into publications that each fit one transaction: the Realm's batch limits
// (LedgerCore._bounds: actions, BIND/UNBIND/RELEASE count, summed body bytes) and a gas budget under the
// per-transaction cap, estimated with the contracts' fitted gas model (release.json `gasModel`). Order is kept,
// because a record must be published no later than the publication that references it, and `group`s never split
// (a file's finish — revision, name, CREATE, HEAD and FOLDER binds — appears atomically or not at all).
//
// The estimate is the model's (fixed + Σ actions) plus what the model excludes: the 21,000 intrinsic gas and the
// calldata of the encoded call, priced as if every byte were non-zero. Plans aim at the cap divided by
// (1 + headroom), 15% by default (the model under-predicts mixed publications by up to ~6–8%). eth_estimateGas on
// the exact call stays the authority before anything is sent (sendPlan refuses an estimate over the cap).
import { type Reason, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import { ACTION } from "../generated/constants.js";
import type { ActionData } from "./types.js";

/** The contracts' fitted gas model for one fee schedule (release.json gasModel.schedules[name].constants). */
export interface GasModel {
  /** Fee schedule name, e.g. "prague". A model is never applied to a chain priced by another schedule. */
  schedule: string;
  fixed: number;
  perWord: number;
  perByte: number;
  /** PUBLISH of a new record, by shape ("files-bytes/1", "files-root/1 form 0", …), before the per-word/byte terms. */
  publishNew: Readonly<Record<string, number>>;
  /** PUBLISH of a record that already exists (no body storage). */
  publishExisting: number;
  reuse: number;
  create: number;
  /** The most expensive BIND row (fresh or rebind, HEAD or FOLDER): the planner does not know which one applies. */
  bind: number;
  unbind: number;
  release: number;
  withdraw: number;
}

export interface PlannedAction {
  action: ActionData;
  /** The body, for PUBLISH; "0x" otherwise. */
  body: Hex;
  /** The record's shape key in the gas model; unknown shapes are priced at the model's most expensive one. */
  shape?: string;
  /** True when the record is known to exist already (priced as publishExisting). */
  exists?: boolean;
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
  /** Plan to txGasCap / (1 + headroom). Default 0.15. */
  headroom?: number;
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
export function actionGas(a: PlannedAction, m: GasModel): number {
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
  if (k === ACTION.BIND) return m.bind;
  if (k === ACTION.UNBIND) return m.unbind;
  if (k === ACTION.RELEASE) return m.release;
  if (k === ACTION.WITHDRAW) return m.withdraw;
  return Math.max(m.bind, m.create, m.unbind); // an unknown kind: priced high, never zero
}

/** The planning estimate of one publication: model + intrinsic + calldata (all bytes priced as non-zero). */
export function publicationGas(actions: readonly PlannedAction[], m: GasModel): number {
  let gas = m.fixed + INTRINSIC + CALL_OVERHEAD_BYTES * NONZERO_BYTE;
  for (const a of actions) {
    const n = bodyLen(a.body);
    gas += actionGas(a, m) + (ACTION_BYTES + Math.ceil(n / 32) * 32) * NONZERO_BYTE;
  }
  return gas;
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
  const budget = Math.floor(Number(o.txGasCap) / (1 + (o.headroom ?? 0.15)));
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
  const fits = (list: readonly PlannedAction[]): true | Reason => {
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
    const gas = publicationGas(list, m);
    if (gas > budget)
      return reason(
        "OVER_TX_GAS_CAP",
        "after-replan",
        `~${gas} gas; the budget is ${budget} (cap ${o.txGasCap})`,
      );
    return true;
  };
  const parts: SplitPart[] = [];
  let current: PlannedAction[] = [];
  for (const u of units(actions)) {
    const alone = fits(u.list);
    if (alone !== true) return { ok: false, reason: alone, at: u.start };
    if (current.length && fits([...current, ...u.list]) !== true) {
      parts.push({ actions: current, gas: publicationGas(current, m) });
      current = [];
    }
    current.push(...u.list);
  }
  if (current.length) parts.push({ actions: current, gas: publicationGas(current, m) });
  return { ok: true, parts, budget };
}
