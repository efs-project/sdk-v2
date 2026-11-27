// SPDX-License-Identifier: MIT
// The read-set guard's heads for the Files and Topics planners (contracts 19891fe; the SDK's guard design, G1-G6). Each
// head a plan writes is guarded with the expected snapshot COMPUTED FROM THE HEAD THE PLANNER READ: headSnapshotHash(
// state, revision, admission, target), the target by the contracts' table:
//
//   BOUND                                             its target (the head read)
//   UNSET, or targetKind 0                            0
//   MASKED or RELEASED, purpose TAG, SAME or BROADER  the position's role (the Files validator binds nothing else there)
//   MASKED or RELEASED, any other purpose             the stored last bound target: LedgerViews.headSnapshots `targets`
//
// LedgerViews.headSnapshots is read in the same batch as the heads, at the same basis, for two things only: its
// `targets` supply the stored target the last row needs, and its `snapshots` are a CONSISTENCY CHECK. Each is compared
// with the hash computed here, and a difference fails over to the next endpoint (the endpoint disagrees with itself),
// so a review is never shown for a plan the chain would refuse. A snapshot is NEVER an expected value: an endpoint that
// lied in its head read can serve the true hash there, and a copied hash would then pass while the plan was decided on
// the lie. The kernel compares every guarded head itself; a lie anywhere here can only make the publication revert.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import {
  type GuardHead,
  type GuardMode,
  type GuardTerm,
  guardingOn,
  headSnapshotHash,
  type PartGuardHead,
} from "../actions/guard.js";
import type { PlannedAction } from "../actions/split.js";
import type { CallRequest } from "../chain/basis.js";
import type { Step } from "../chain/pool.js";
import type { RpcOutcome } from "../chain/rpc.js";
import type { Efs } from "../client.js";
import { reason } from "../core/errors.js";
import { type Hex, lower, type PrincipalId, ZERO_WORD } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ledgerViewsAbi } from "../generated/abis.js";
import { ACTION, PURPOSES } from "../generated/constants.js";
import { headState } from "../protocol/status.js";

/** What a guard needs of a head as the planner read it. */
export interface HeadRead {
  state: number;
  revision: bigint;
  admission: bigint;
  targetKind: number;
  target: Hex;
}

/** The purposes whose MASKED or RELEASED heads store the position's role as their target (a Files profile rule). */
const ROLE_STORED: ReadonlySet<string> = new Set([PURPOSES.tag, PURPOSES.same, PURPOSES.broader]);

/**
 * The target a head's snapshot is over, when the head and its position say it; null when it is the stored last bound
 * target, which only a read gives (a MASKED or RELEASED head of FOLDER, HEAD, PROPERTY or an app's own purpose).
 */
export function knownSnapshotTarget(h: HeadRead, purpose: Hex, role: Hex): Hex | null {
  const state = headState(h.state);
  if (state === "BOUND") return lower(h.target);
  if (Number(h.targetKind) === 0) return ZERO_WORD;
  if (ROLE_STORED.has(lower(purpose))) return lower(role);
  return null;
}

/**
 * How a head this publication writes is priced (gas/model.json profiles.<schedule>.guard): `writtenUnread` for an
 * UNBIND or RELEASE of a MASKED or RELEASED head that once bound (apply never reads its kept target, so the guard's read
 * of it is cold), else `written`.
 */
export function writtenTerm(kind: number, h: HeadRead): GuardTerm {
  const state = headState(h.state);
  const removed = state === "MASKED" || state === "RELEASED";
  return (kind === ACTION.UNBIND || kind === ACTION.RELEASE) &&
    removed &&
    Number(h.targetKind) !== 0
    ? "writtenUnread"
    : "written";
}

/** How a head this publication only reads (a decision head) is priced: two words with a target, one without. */
export function readTerm(h: HeadRead): GuardTerm {
  return Number(h.targetKind) !== 0 ? "twoWords" : "oneWord";
}

/** The most heads one headSnapshots call answers (n·m ≤ maxReadCount; one principal per call here). */
export const SNAPSHOT_CHUNK = 256;

/** LedgerViews.headSnapshots(ledger, principals, positions): position-major snapshots and stored targets. */
export function headSnapshotsCall(
  d: DeploymentInfo,
  principals: readonly PrincipalId[],
  positions: readonly Hex[],
): CallRequest {
  return {
    to: d.readers.ledgerViews,
    data: encodeFunctionData({
      abi: ledgerViewsAbi,
      functionName: "headSnapshots",
      args: [d.ledger, principals as Hex[], positions as Hex[]],
    }),
  };
}

/** A headSnapshots reply of `count` heads, or the endpoint's fault (fail over). */
export function decodeHeadSnapshots(
  out: RpcOutcome | undefined,
  count: number,
): Step<{ snapshots: readonly Hex[]; targets: readonly Hex[] }> {
  if (!out?.ok)
    return {
      ok: false,
      retryElsewhere: true,
      reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
    };
  let snapshots: readonly Hex[];
  let targets: readonly Hex[];
  try {
    [snapshots, targets] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "headSnapshots",
      data: out.result as Hex,
    }) as unknown as [Hex[], Hex[]];
  } catch {
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason("RPC_ERROR", "transient", "headSnapshots did not decode"),
    };
  }
  if (snapshots.length !== count || targets.length !== count)
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason("RPC_ERROR", "transient", "headSnapshots (one snapshot and target per head)"),
    };
  return { ok: true, value: { snapshots, targets } };
}

/** A guarded head as computed, before it is tied to an action: its expected snapshot and the target it is over. */
export interface Snapshot {
  expected: Hex;
  /** The stored target the snapshot is over: for a removed head, what a restore of the entry binds again. */
  target: Hex;
}

/**
 * The expected snapshot of a head the planner read, and the consistency check against the endpoint's own snapshot of
 * it. `stored` is the endpoint's stored target for the head (headSnapshots `targets`), used only where the table needs
 * a read. The expected value is always the one computed here; `endpointSnapshot` is only compared with it.
 */
export function consistentSnapshot(
  h: HeadRead,
  purpose: Hex,
  role: Hex,
  endpointSnapshot: Hex,
  stored: Hex,
): Step<Snapshot> {
  const target = knownSnapshotTarget(h, purpose, role) ?? lower(stored);
  const expected = headSnapshotHash(
    Number(h.state),
    BigInt(h.revision),
    BigInt(h.admission),
    target,
  );
  if (lower(endpointSnapshot) !== expected)
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason(
        "RPC_ERROR",
        "transient",
        "the endpoint's head snapshot is not the hash of its own head read (the guard's consistency check)",
      ),
    };
  return { ok: true, value: { expected, target } };
}

/** A guarded head of `principal` at `position`, priced as `term`. */
export const guardHead = (
  principal: PrincipalId,
  position: Hex,
  s: Snapshot,
  term: GuardTerm,
): GuardHead => ({ principal, position: lower(position), expected: s.expected, term });

/** A split part's guarded heads, each tied to its action's index in the part (SequencePart.guard). */
export const partGuardOf = (actions: readonly PlannedAction[]): PartGuardHead[] =>
  actions.flatMap((a, action) => (a.guard ?? []).map((h) => ({ ...h, action })));

/** Whether this writer's plans are guarded (WriterConfig.guard on this deployment), or why it can't plan. */
export const guardingOf = (
  efs: Efs,
  writer: { readonly guard?: GuardMode },
): ReturnType<typeof guardingOn> => guardingOn(writer.guard ?? "auto", efs.deployment.nativeGuard);
