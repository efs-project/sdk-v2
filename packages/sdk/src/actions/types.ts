// SPDX-License-Identifier: MIT
import type { Basis } from "../chain/pool.js";
import type { Reason, RevertInfo } from "../core/errors.js";
import type { Address, Hex, PrincipalId } from "../core/hex.js";

/** One ledger action (contracts src/interfaces/Actions.sol), as plain data. */
export interface ActionData {
  kind: number;
  typeId: Hex;
  bodyHashOrRecordId: Hex;
  purpose: Hex;
  subject: Hex;
  role: Hex;
  target: Hex;
  expectedRevision: bigint;
  /**
   * CREATE: the creator's salt (nonzero). BIND: the binding's unsigned strength (0..65,535); UNBIND: its strength,
   * the number being −1 − strength. Every other kind, RELEASE included: zero. (`Action.saltOrStrength`.)
   */
  saltOrStrength: Hex;
}
export { ACTION } from "../generated/constants.js";

/** Stable codes for the client's message catalog. `text` is English, for logs only. */
export interface EffectView {
  code: string;
  args: Readonly<Record<string, string>>;
  text?: string;
}

/** Plain, journal-safe data. `digest` is the native intent digest: the ledger's retry key for this exact plan. */
export interface Plan {
  kind: "efs.plan";
  v: 1;
  id: Hex;
  digest: Hex;
  chainId: number;
  realmId: Hex;
  ledger: Address;
  principal: PrincipalId;
  account: Address;
  nonce: bigint;
  deadline: bigint;
  executionSet: Hex;
  acceptanceProfile: Hex;
  actions: readonly ActionData[];
  bodies: readonly Hex[];
  calldata: Hex;
  effects: readonly EffectView[];
  basis: Basis;
  /**
   * The planner's gas figures for this publication, when a planner made it (PlanInput.gas and .total): `execution`
   * includes intrinsic and calldata gas, `total` adds the state gas (amsterdam only; total − execution is the state
   * gas). Not part of the digest. On a reservoir profile the send's gas limit is never below them (gasLimitOf).
   */
  plannedGas?: { execution: number; total: number };
}

export type PlanSequenceResult =
  | { kind: "efs.planSequence"; status: "PLANNED"; plans: readonly Plan[] }
  /** `at`: the part that could not be planned. Nothing is sent by planning. */
  | { kind: "efs.planSequence"; status: "REFUSED" | "UNKNOWN"; reason: Reason; at: number };

export type PlanResult =
  | { kind: "efs.planResult"; status: "PLANNED"; plan: Plan }
  | { kind: "efs.planResult"; status: "REFUSED" | "UNKNOWN"; reason: Reason };

export interface Review {
  kind: "efs.review";
  effects: readonly EffectView[];
  prompts: number;
  /**
   * `estimate`: eth_estimateGas on the exact call (null when it failed). `floor`: the visible gas the kernel's floor
   * needs (V of the planning rule), priced from the actions alone with every bind taken as a first statement (an upper
   * bound); null when the deployment's gas model has no floor.
   */
  gas: { estimate: bigint | null; floor: bigint | null };
  /** The simulated call reverted: the plan would fail as it stands (e.g. E_CAS, a stale precondition), else null. */
  wouldRevert: RevertInfo | null;
  stale: boolean;
  atomic: boolean;
}

export type SendResult =
  | { kind: "efs.send"; status: "SUBMITTED"; planId: Hex; txHash: Hex }
  | {
      kind: "efs.send";
      status: "NOT_SENT";
      planId: Hex;
      reason: Reason;
      /**
       * Set when reason.code is OVER_TX_GAS_CAP: the publication is too big for one transaction (not out of date).
       * Split it into about `suggestedParts` publications and send each.
       */
      gas?: { estimate: bigint; cap: bigint; suggestedParts: number };
    }
  | { kind: "efs.send"; status: "AMBIGUOUS"; planId: Hex; reason: Reason }
  /**
   * The ledger refuses this plan as it stands (its simulation reverts; `revert` says with what, e.g. E_CAS when the
   * file's HEAD moved): plan again from fresh state. A wallet on another chain or account is NOT_SENT
   * WALLET_MISMATCH instead, since the same plan can go once the wallet is switched back.
   */
  | {
      kind: "efs.send";
      status: "STALE";
      planId: Hex;
      reasons: readonly string[];
      revert?: RevertInfo;
    }
  | { kind: "efs.send"; status: "BUSY"; planId: Hex };

export interface ReconcileResult {
  kind: "efs.reconcile";
  planId: Hex;
  outcome: "COMMITTED" | "NOT_COMMITTED_PROVEN" | "UNKNOWN";
  /** COMMITTED: also visible at the finalized block. NOT_COMMITTED_PROVEN is always reorg-safe (final). */
  final?: boolean;
  publication?: bigint;
  reason?: Reason;
  basis?: Basis;
}
