// SPDX-License-Identifier: MIT
import type { Basis } from "../chain/pool.js";
import type { Reason } from "../core/errors.js";
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
  salt: Hex;
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
}

export type PlanResult =
  | { kind: "efs.planResult"; status: "PLANNED"; plan: Plan }
  | { kind: "efs.planResult"; status: "REFUSED" | "UNKNOWN"; reason: Reason };

export interface Review {
  kind: "efs.review";
  effects: readonly EffectView[];
  prompts: number;
  gas: { estimate: bigint | null; floor: bigint | null };
  /** The simulated call reverted: the plan would fail as it stands (e.g. a stale precondition). */
  wouldRevert: { error: string; selector: Hex } | null;
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
  | { kind: "efs.send"; status: "STALE"; planId: Hex; reasons: readonly string[] }
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
