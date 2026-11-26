// SPDX-License-Identifier: MIT
// Split an ordered list of actions into publications that each fit one transaction, by the contracts' planning rule
// (gas/model.json `planning`; the reference is the contracts' tools/gas-plan.mjs, and the SDK reproduces its verdicts
// on test/vectors/floor-plan.json). Order is kept, because a record must be published no later than the publication
// that references it, and `group`s never split (a file's finish appears atomically or not at all).
//
// A publication is planned when it is inside the Realm's limits (actions, bind-kind actions, summed PUBLISH body
// bytes) and max(E, V) ≤ ⌊txGasCap × (100 − headroomPercent) / 100⌋, on the chain's fee schedule:
//   E  the model's execution estimate: fixed + Σ actions (+ the first-write surcharge on a principal's first write);
//   V  the visible gas the kernel's floor checks need: max(K + prefixNeed(P), E) + ⌈F·64/63⌉ + kernelTail, where K is
//      the kernel's own share of E (floor.kernel, the same model with the index's callbacks removed), and P and F the
//      kernel's own quote (prefix floor, final reserve) from the work model (formula 2).
// The headroom covers the 21,000 intrinsic gas, the calldata and the model's error. eth_estimateGas on the exact call
// stays the authority before anything is sent, and the gas limit comes from the estimate, never from V.
import { type Reason, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ACTION, PURPOSES } from "../generated/constants.js";
import { GAS_PLANNING, GAS_SCHEDULES, GAS_TAG_LISTS } from "../generated/gas.js";
import type { ActionData } from "./types.js";

/** The per-level terms a first TAG statement pays at each proper ancestor of its topic (tagLists). */
export type TagLevel = "mineNew" | "mineExisting" | "sharedNew" | "sharedExisting";

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
  bindTagFresh: number;
  bindTagSecondAuthor: number;
  bindTagNumberChange: number;
  unbindTagLone: number;
  unbindTag: number;
  releaseTag: number;
  restoreTag: number;
  /** Statements about topics: a label (PROPERTY), "same as" and "broader", first and later (contracts 0fb4804). */
  bindPropertyFresh: number;
  bindPropertyRebind: number;
  unbindProperty: number;
  releaseProperty: number;
  bindSameFreshWord: number;
  bindSameFreshPath: number;
  unbindSame: number;
  releaseSame: number;
  restoreSame: number;
  bindBroaderFresh: number;
  unbindBroader: number;
  releaseBroader: number;
  restoreBroader: number;
  withdraw: number;
  /** Added once to a principal's first publication ever. */
  firstWriteSurcharge: number;
  tagLevel: Readonly<Record<TagLevel, number>>;
}

/** The work model the kernel quotes its floor with (formula 2; efs-deployment index.workModel). */
export interface WorkModel {
  formulaVersion: number;
  freshPerPublication: number;
  rwPerPublication: number;
  freshPerPublishFresh: number;
  freshPerPublishExisting: number;
  rwPerPublish: number;
  freshPerBindFresh: number;
  rwPerBind: number;
  rwPerBindLater: number;
  freshPerRef: number;
  freshPerDigestSpec: number;
  computeBase: number;
  computePerAction: number;
  computePerHookEffect: number;
  finalComputeBase: number;
  finalComputePerBind: number;
  finalComputePerPublish: number;
}

/** The kernel's floor, per schedule (gas/model.json profiles.<schedule>.floor). */
export interface FloorModel {
  workModel: WorkModel;
  limits: { floorFreshGas: number; floorRewriteGas: number; kernelTail: number };
  /** The 63/64 rule: what a call keeps of the gas it forwards. */
  callGasRetained: { numerator: number; denominator: number };
  /** The most the ingress spends between the kernel's forward and the index's. */
  dispatchOverhead: number;
  /** References and digest specs per Type name: what the quote charges per record. */
  types: Readonly<Record<string, { refs: number; specs: number }>>;
  /** The kernel's own execution gas: the same model fitted with the index's callbacks removed (K). */
  kernel: GasConstants;
}

/** The model the planner splits with: what the per-transaction cap counts, for one fee schedule. */
export interface GasModel extends GasConstants {
  /** Fee schedule name, e.g. "prague". A model is never applied to a chain priced by another schedule. */
  schedule: string;
  /** Set when the cap counts only execution gas (amsterdam): all gas, which must also fit the block. */
  total?: GasConstants;
  /** The kernel's floor on this schedule. Without one, a publication is planned by E alone. */
  floor?: FloorModel;
}

/** The gas-model row a BIND, UNBIND or RELEASE is priced at. Without one, the most expensive row of its kind. */
export type BindRow =
  | "bindHeadFresh"
  | "bindHeadRebind"
  | "bindFolderFreshFile"
  | "bindFolderFreshDirectory"
  | "bindFolderRebind"
  | "unbindFolder"
  | "releaseFolder"
  | "bindTagFresh"
  | "bindTagSecondAuthor"
  | "bindTagNumberChange"
  | "unbindTagLone"
  | "unbindTag"
  | "releaseTag"
  | "restoreTag"
  | "bindPropertyFresh"
  | "bindPropertyRebind"
  | "unbindProperty"
  | "releaseProperty"
  | "bindSameFreshWord"
  | "bindSameFreshPath"
  | "unbindSame"
  | "releaseSame"
  | "restoreSame"
  | "bindBroaderFresh"
  | "unbindBroader"
  | "releaseBroader"
  | "restoreBroader";
const BIND_ROWS: readonly BindRow[] = [
  "bindHeadFresh",
  "bindHeadRebind",
  "bindFolderFreshFile",
  "bindFolderFreshDirectory",
  "bindFolderRebind",
  "bindTagFresh",
  "bindTagSecondAuthor",
  "bindTagNumberChange",
  "restoreTag",
  "bindPropertyFresh",
  "bindPropertyRebind",
  "bindSameFreshWord",
  "bindSameFreshPath",
  "restoreSame",
  "bindBroaderFresh",
  "restoreBroader",
];
const UNBIND_ROWS: readonly BindRow[] = [
  "unbindFolder",
  "unbindTagLone",
  "unbindTag",
  "unbindProperty",
  "unbindSame",
  "unbindBroader",
];
const RELEASE_ROWS: readonly BindRow[] = [
  "releaseFolder",
  "releaseTag",
  "releaseProperty",
  "releaseSame",
  "releaseBroader",
];
/** Rows that are never a first statement: the author's head at the position already exists. */
const LATER_ROWS: ReadonlySet<BindRow> = new Set<BindRow>([
  "bindHeadRebind",
  "bindFolderRebind",
  "bindTagNumberChange",
  "restoreTag",
  "unbindTag",
  "unbindFolder",
  "bindPropertyRebind",
  "restoreSame",
  "restoreBroader",
]);

export interface PlannedAction {
  action: ActionData;
  /** The body, for PUBLISH; "0x" otherwise. */
  body: Hex;
  /**
   * The record's shape key in the gas model ("files-bytes/1", "files-content/1 carrier 2"); its first word names the
   * Type. Unknown shapes are priced at the model's most expensive one.
   */
  shape?: string;
  /** True when the record is known to exist already (priced as publishExisting). */
  exists?: boolean;
  /** For a BIND, UNBIND or RELEASE: the row it is priced at, when the planner knows. */
  bindRow?: BindRow;
  /** For a first TAG statement: the per-level terms it pays at its topic's proper ancestors (tagLists). */
  levels?: Readonly<Partial<Record<TagLevel, number>>>;
  /** Consecutive actions with the same group id are kept in one publication. */
  group?: number;
  /**
   * For a BIND or UNBIND: whether the writer's head at the position is UNSET (a first statement of either sign),
   * which the kernel's floor charges fresh slots for. Absent: a BIND is a first statement unless its `bindRow` is a
   * later statement's row; an UNBIND is not (a lone negative says so). A RELEASE never is.
   */
  firstStatement?: boolean;
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
  /** Type names by Type id (lowercase), for records without a shape (DeploymentInfo.typeIds, inverted). */
  typeNames?: Readonly<Record<string, string>>;
}

/** What the planning rule compares to the budget: E, K, V and the kernel's quote. */
export interface RuleGas {
  /** The model's execution estimate. */
  E: number;
  /** The kernel's own share of it (E when the model has no floor). */
  K: number;
  /** The visible gas the kernel's floor needs (E when the model has no floor). */
  V: number;
  quote: KernelQuote | null;
}

export interface SplitPart {
  actions: PlannedAction[];
  /** The planning estimate shown to people: the model plus intrinsic and calldata gas, never the authority. */
  gas: number;
  /** What the rule judged: the part fits when max(E, V) is within the budget. */
  rule: RuleGas;
  /** With `model.total` (amsterdam): the whole gas shown the same way, which the block must also hold. */
  total?: number;
}

/**
 * What a part weighs in an atomic batch, from the planner's own pricing (rows, per-level terms, the kernel's floor):
 * the shown gas plus whatever V adds above E, and the whole gas where the block must hold it too. Carried on each
 * sequence part (`SequencePartInput.gas`) so packBatches never re-prices a part from its bare actions. The floor's
 * extra is added to both, so `total − gas` is exactly the part's state gas (the send's gas limit relies on it).
 */
export function batchGasOf(p: SplitPart): { gas: number; total?: number } {
  const extra = Math.max(p.rule.E, p.rule.V) - p.rule.E;
  return {
    gas: p.gas + extra,
    ...(p.total !== undefined ? { total: p.total + extra } : {}),
  };
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
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

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
  if (k === ACTION.WITHDRAW) return m.withdraw;
  if (isBindLike(k)) {
    const rows = k === ACTION.BIND ? BIND_ROWS : k === ACTION.UNBIND ? UNBIND_ROWS : RELEASE_ROWS;
    let g = a.bindRow !== undefined ? m[a.bindRow] : Math.max(...rows.map((r) => m[r]));
    for (const [level, n] of Object.entries(a.levels ?? {}))
      g += m.tagLevel[level as TagLevel] * (n ?? 0);
    return g;
  }
  // an unknown kind: priced high, never zero
  return Math.max(m.create, ...BIND_ROWS.map((r) => m[r]), ...UNBIND_ROWS.map((r) => m[r]));
}

/** The model's execution estimate of one publication (gas-plan.mjs `estimate`), without intrinsic or calldata gas. */
export function modelGas(
  actions: readonly PlannedAction[],
  m: GasConstants,
  firstWrite = false,
): number {
  let gas = m.fixed + (firstWrite ? m.firstWriteSurcharge : 0);
  for (const a of actions) gas += actionGas(a, m);
  return Math.round(gas);
}

/**
 * The planning estimate shown to people: the model plus intrinsic gas and the calldata of the encoded call (every
 * byte priced as non-zero), plus the first-write surcharge when `firstWrite`.
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

/** The kernel's own quote of a publication's floor (LedgerIngress.indexFloor's four numbers). */
export interface KernelQuote {
  prefixFloor: number;
  finalReserve: number;
  freshSlots: number;
  rewrites: number;
}

/** Whether a bind-kind action is a first statement (the author's head at the position is UNSET). */
function firstStatement(a: PlannedAction, everyBindFirst: boolean): boolean {
  const k = a.action.kind;
  if (k === ACTION.RELEASE) return false; // a release always follows a statement
  if (everyBindFirst) return true;
  if (a.firstStatement !== undefined) return a.firstStatement;
  return k === ACTION.BIND && !(a.bindRow !== undefined && LATER_ROWS.has(a.bindRow));
}

/** The refs and specs the quote charges a record of this action's Type (the dearest when the Type is unknown). */
function typeTerms(
  a: PlannedAction,
  f: FloorModel,
  typeNames?: Readonly<Record<string, string>>,
): { refs: number; specs: number } {
  const name = a.shape?.split(" ")[0] ?? typeNames?.[a.action.typeId.toLowerCase()];
  const known = name !== undefined ? f.types[name] : undefined;
  if (known) return known;
  const all = Object.values(f.types);
  return {
    refs: Math.max(0, ...all.map((t) => t.refs)),
    specs: Math.max(0, ...all.map((t) => t.specs)),
  };
}

/**
 * The kernel's quote (LedgerIngress._foldAndQuote, formula 2), exactly as gas-plan.mjs computes it: fresh slots for
 * each first statement and each new record (with its references and digest specs), rewrites per publish and per bind
 * (more for a later statement), and the prefix floor and final reserve they price. `everyBindFirst` prices every BIND
 * and UNBIND as a first statement, as the kernel's own indexFloor helper does (an upper bound: never plan from it).
 */
export function kernelQuote(
  actions: readonly (ActionData | PlannedAction)[],
  f: FloorModel,
  o: { everyBindFirst?: boolean; typeNames?: Readonly<Record<string, string>> } = {},
): KernelQuote {
  const w = f.workModel;
  let fresh10 = w.freshPerPublication;
  let rw10 = w.rwPerPublication;
  let compute = w.computeBase + w.computePerAction * actions.length;
  let binds = 0;
  let publishes = 0;
  for (const x of actions) {
    const a: PlannedAction = "action" in x ? x : { action: x, body: "0x" };
    const k = a.action.kind;
    if (k === ACTION.PUBLISH || k === ACTION.REUSE) {
      const t = typeTerms(a, f, o.typeNames);
      // a REUSE always names an existing record
      if (k === ACTION.PUBLISH && a.exists !== true)
        fresh10 += w.freshPerPublishFresh + w.freshPerDigestSpec * t.specs;
      else fresh10 += w.freshPerPublishExisting;
      rw10 += w.rwPerPublish;
      fresh10 += w.freshPerRef * t.refs;
      publishes++;
    } else if (isBindLike(k)) {
      binds++;
      if (firstStatement(a, o.everyBindFirst === true)) fresh10 += w.freshPerBindFresh;
      else rw10 += w.rwPerBindLater;
      rw10 += w.rwPerBind;
      compute += w.computePerHookEffect;
    }
  }
  const freshSlots = ceilDiv(fresh10, 10);
  const rewrites = ceilDiv(rw10, 10);
  return {
    prefixFloor:
      compute + freshSlots * f.limits.floorFreshGas + rewrites * f.limits.floorRewriteGas,
    finalReserve:
      w.finalComputeBase + w.finalComputePerBind * binds + w.finalComputePerPublish * publishes,
    freshSlots,
    rewrites,
  };
}

/** Visible gas needed at a callback so that `remaining` prefix floor passes both 63/64 steps. */
export function prefixNeed(remaining: number, f: FloorModel): number {
  const { numerator: num, denominator: den } = f.callGasRetained;
  return ceilDiv((ceilDiv(remaining * den, num) + f.dispatchOverhead) * den, num);
}

/** V from E, K and the kernel's quote (gas-plan.mjs `visible`). */
export function visibleGas(E: number, K: number, q: KernelQuote, f: FloorModel): number {
  const { numerator: num, denominator: den } = f.callGasRetained;
  return (
    Math.max(K + prefixNeed(q.prefixFloor, f), E) +
    ceilDiv(q.finalReserve * den, num) +
    f.limits.kernelTail
  );
}

/** E, K, V and the quote of one publication under `m` (no floor: K = V = E). */
export function ruleGas(
  actions: readonly PlannedAction[],
  m: GasModel,
  firstWrite = false,
  typeNames?: Readonly<Record<string, string>>,
): RuleGas {
  const E = modelGas(actions, m, firstWrite);
  if (!m.floor) return { E, K: E, V: E, quote: null };
  const K = modelGas(actions, m.floor.kernel, firstWrite);
  const quote = kernelQuote(actions, m.floor, typeNames ? { typeNames } : {});
  return { E, K, V: visibleGas(E, K, quote, m.floor), quote };
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
  const budget = budgetOf(o.txGasCap, o.headroom);
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
    const r = ruleGas(list, m, first && o.firstWrite === true, o.typeNames);
    if (Math.max(r.E, r.V) > budget)
      return reason(
        "OVER_TX_GAS_CAP",
        "after-replan",
        `~${Math.max(r.E, r.V)} gas (E ${r.E}, V ${r.V}); the budget is ${budget} (cap ${o.txGasCap})`,
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
  const partOf = (list: PlannedAction[], first: boolean): SplitPart => ({
    actions: list,
    gas: publicationGas(list, m, first && o.firstWrite === true),
    rule: ruleGas(list, m, first && o.firstWrite === true, o.typeNames),
    ...(m.total ? { total: publicationGas(list, m.total, first && o.firstWrite === true) } : {}),
  });
  for (const u of units(actions)) {
    const alone = fits(u.list, parts.length === 0 && current.length === 0);
    if (alone !== true) return { ok: false, reason: alone, at: u.start };
    if (current.length && fits([...current, ...u.list], parts.length === 0) !== true) {
      parts.push(partOf(current, parts.length === 0));
      current = [];
    }
    current.push(...u.list);
  }
  if (current.length) parts.push(partOf(current, parts.length === 0));
  return { ok: true, parts, budget };
}

/** A part as a sequence keeps it: its actions and their bodies, and the planner's own batching estimate. */
export interface PartBody {
  actions: readonly ActionData[];
  bodies: readonly Hex[];
  /** The planner's estimate of the part in a batch (batchGasOf), when a planner made it. */
  gas?: number;
  /** With an amsterdam model: the planner's whole-gas estimate. */
  total?: number;
}

/** The planning rule's budget: ⌊txGasCap × (100 − headroomPercent) / 100⌋ (headroom as a fraction). */
export function budgetOf(txGasCap: bigint, headroom = 0.15): number {
  const percent = Math.round(headroom * 100);
  return Number((txGasCap * BigInt(100 - percent)) / 100n);
}

/** `tagLists.priceAsNew`: whether a roll-up list holding `entries` entries is priced as a new list. */
export function priceAsNew(entries: number): boolean {
  const r = GAS_TAG_LISTS.priceAsNew;
  return (r.entries as readonly number[]).includes(entries) || entries % r.entriesMultipleOf === 0;
}

/**
 * A conservative planning estimate of one part from its actions and bodies alone: new records at the dearest shape,
 * binds at the dearest row of their kind and taken as first statements, and the first-write surcharge always
 * included. With a floor, max(E, V) of that; plus intrinsic and calldata gas, as a batch of parts carries them.
 */
export function partGas(
  part: PartBody,
  m: GasModel | GasConstants,
  typeNames?: Readonly<Record<string, string>>,
): number {
  // A planner's own estimate is the authority for batching: it priced rows and per-level terms bare actions lack.
  const total = (m as GasModel).schedule === undefined;
  if (!total && part.gas !== undefined) return part.gas;
  if (total && part.total !== undefined) return part.total;
  // Without one, a TAG statement's per-level terms (its topic's depth) can't be known: it is never batched.
  if (part.actions.some((a) => a.purpose.toLowerCase() === PURPOSES.tag && isBindLike(a.kind)))
    return Number.POSITIVE_INFINITY;
  const list: PlannedAction[] = part.actions.map((action, i) => ({
    action,
    body: part.bodies[i] ?? "0x",
    ...(action.kind === ACTION.UNBIND ? { firstStatement: true } : {}),
  }));
  const shown = publicationGas(list, m, true);
  const floor = (m as GasModel).floor;
  if (!floor) return shown;
  const r = ruleGas(list, m as GasModel, true, typeNames);
  return shown + Math.max(r.E, r.V) - r.E;
}

/**
 * Consecutive parts packed into atomic EIP-5792 batches, as lists of part indexes in order. An atomic batch may run
 * as ONE transaction (EIP-7702 and ERC-4337 accounts run it that way), so it is under the same per-transaction cap
 * as one part, and each call in it must still find its own floor. Each batch's summed `partGas` fits the budget.
 * Where the cap counts only execution gas (`model.total`), the summed whole gas must also fit the block budget, and
 * with no block gas limit known nothing is batched. At most `maxParts` per batch. A part that fits with no neighbour
 * goes alone.
 */
export function packBatches(
  parts: readonly PartBody[],
  g: {
    model: GasModel;
    txGasCap: bigint;
    headroom?: number;
    blockGasLimit?: bigint;
    typeNames?: Readonly<Record<string, string>>;
  },
  maxParts: number = Number.POSITIVE_INFINITY,
): number[][] {
  const keep = 1 - (g.headroom ?? 0.15);
  const budget = budgetOf(g.txGasCap, g.headroom);
  const total = g.model.total;
  const blockBudget =
    total && g.blockGasLimit !== undefined ? Math.floor(Number(g.blockGasLimit) * keep) : undefined;
  const alone = total !== undefined && blockBudget === undefined;
  const out: number[][] = [];
  let batch: number[] = [];
  let gas = 0;
  let all = 0;
  parts.forEach((p, i) => {
    const pg = partGas(p, g.model, g.typeNames);
    const pa = total ? partGas(p, total) : 0;
    const fits =
      batch.length > 0 &&
      !alone &&
      batch.length < maxParts &&
      gas + pg <= budget &&
      (blockBudget === undefined || all + pa <= blockBudget);
    if (!fits && batch.length) {
      out.push(batch);
      batch = [];
      gas = 0;
      all = 0;
    }
    batch.push(i);
    gas += pg;
    all += pa;
  });
  if (batch.length) out.push(batch);
  return out;
}

/** EIP-7825's per-transaction gas cap (2^24): the default when the deployment document states none. */
export const TX_GAS_CAP: bigint = BigInt(GAS_PLANNING.txGasCap);
/** The cap of this deployment's chain (efs-deployment.chain.txGasCap). Always enforced. */
export const txGasCapOf = (d: DeploymentInfo): bigint => d.chain?.txGasCap ?? TX_GAS_CAP;

export type GasPlan =
  | {
      ok: true;
      model: GasModel;
      txGasCap: bigint;
      /** The contracts' planning headroom (planning.headroomPercent / 100). */
      headroom: number;
      blockGasLimit?: bigint;
      /** Type names by Type id (lowercase), from the deployment. */
      typeNames: Readonly<Record<string, string>>;
    }
  | { ok: false; reason: Reason };

/** The work-model formula the planner implements (gas/model.json floor, formula 2). */
export const FLOOR_FORMULA = 2;

/** Type names by Type id (lowercase), from a deployment's typeIds. */
export const typeNamesOf = (d: DeploymentInfo): Record<string, string> =>
  Object.fromEntries(Object.entries(d.typeIds ?? {}).map(([name, id]) => [id.toLowerCase(), name]));

/**
 * A refusal when the chain's kernel prices its floor differently from the model this SDK plans with, else null: the
 * formula must be the one implemented here, and the deployment's work model and floor limits must equal the model's
 * field by field (the fixture's `verify` checks the same on chain).
 */
export function floorMismatch(d: DeploymentInfo, m: GasModel): Reason | null {
  const f = m.floor;
  if (f && f.workModel.formulaVersion !== FLOOR_FORMULA)
    return reason(
      "UNSUPPORTED_PROFILE",
      "never",
      `the gas model's work model is formula ${f.workModel.formulaVersion}; this SDK plans with formula ${FLOOR_FORMULA}`,
    );
  const k = d.kernelFloor;
  if (!k) return null;
  if (!f)
    return reason(
      "UNSUPPORTED_PROFILE",
      "never",
      "the deployment's kernel reserves an index floor, and this gas model has none: pass a model with `floor`",
    );
  const differs = [
    ...Object.entries(k.workModel)
      .filter(([key, v]) => (f.workModel as unknown as Record<string, number>)[key] !== v)
      .map(([key]) => `workModel.${key}`),
    ...(["floorFreshGas", "floorRewriteGas", "kernelTail"] as const)
      .filter((key) => k[key] !== f.limits[key])
      .map((key) => `limits.${key}`),
  ];
  if (differs.length)
    return reason(
      "UNSUPPORTED_PROFILE",
      "never",
      `the deployment's kernel floor is not this gas model's (${differs.join(", ")})`,
    );
  return null;
}

type Schedule = {
  hardforks: readonly string[];
  constants: GasConstants;
  executionGas?: GasConstants;
  floor?: FloorModel;
};

/**
 * The vendored fee schedule of this deployment's chain: the one `chain.feeSchedule` names, else the one whose
 * hardforks include `chain.hardfork`; undefined when the document has no `chain` block or no schedule matches.
 */
export function feeScheduleOf(d: DeploymentInfo): { name: string; schedule: Schedule } | undefined {
  const chain = d.chain;
  if (!chain) return undefined;
  const all = GAS_SCHEDULES as unknown as Readonly<Record<string, Schedule>>;
  const name =
    chain.feeSchedule ??
    Object.keys(all).find((k) => (all[k] as Schedule).hardforks.includes(chain.hardfork));
  const schedule = name !== undefined ? all[name] : undefined;
  return name !== undefined && schedule ? { name, schedule } : undefined;
}

/**
 * The gas model and cap to split with on this deployment's chain: the schedule `chain.feeSchedule` names, else the
 * one whose hardforks include `chain.hardfork`. Refused, never guessed, when the document has no `chain` block, names a
 * schedule this SDK was not generated with, or records a kernel floor the model does not price.
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
  const all = GAS_SCHEDULES as unknown as Readonly<Record<string, Schedule>>;
  const found = feeScheduleOf(d);
  const name = found?.name;
  const sch = found?.schedule;
  if (!name || !sch)
    return {
      ok: false,
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        `no gas model for ${chain.feeSchedule ? `fee schedule ${chain.feeSchedule}` : `hardfork ${chain.hardfork}`} in this SDK (it has ${Object.keys(all).join(", ")})`,
      ),
    };
  const base = sch.executionGas
    ? { ...sch.executionGas, schedule: name, total: sch.constants }
    : { ...sch.constants, schedule: name };
  const model: GasModel = sch.floor ? { ...base, floor: sch.floor } : base;
  const mismatch = floorMismatch(d, model);
  if (mismatch) return { ok: false, reason: mismatch };
  return {
    ok: true,
    model,
    txGasCap: chain.txGasCap,
    headroom: GAS_PLANNING.headroomPercent / 100,
    ...(chain.blockGasLimit !== null ? { blockGasLimit: chain.blockGasLimit } : {}),
    typeNames: typeNamesOf(d),
  };
}
