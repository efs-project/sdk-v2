// SPDX-License-Identifier: MIT
// The native read-set guard (contracts 19891fe, the guard release; design §5.1). A publication may carry
//   guard = abi.encode(ReadSet{principals[n], positions[m], expectedHeads[n·m]}),  expectedHeads[j·n + i]
// the expected snapshot of principals[i]'s head at positions[j]. Before any action applies, the ingress compares each
// named head's headSnapshotHash(state, revision, admission, stored target) with it and refuses the whole publication
// (E_READSET_STALE) on the first difference. The CAS on an action binds only a head's revision; a guard binds its
// state and target too.
//
// This module holds the guard's shape, its limits and its gas (gas/model.json profiles.<schedule>.guard; the
// reference is the contracts' tools/gas-plan.mjs `guardCost` and `guardBytes`). A guard is a GRID: every principal at
// every position, so each of the n·m heads needs its own expected value. A planner ties each guarded head to the action
// that writes it (or that it decided), so a split carries a head with its action.
import type { Hex, PrincipalId } from "../core/hex.js";

/**
 * How a guarded head is priced, by what the planner read of it before the publication and whether the publication
 * writes it (gas/model.json profiles.<schedule>.guard.note):
 * - `written`: one of the publication's actions writes it (except the next case);
 * - `writtenUnread`: an UNBIND or RELEASE of a head that is MASKED or RELEASED with a kept target (targetKind ≠ 0);
 * - `twoWords`: not written, targetKind ≠ 0 (BOUND, or MASKED or RELEASED with a kept target);
 * - `oneWord`: not written, targetKind 0 (UNSET, or a lone no).
 */
export type GuardTerm = "written" | "writtenUnread" | "twoWords" | "oneWord";

/** One guarded head: whose, where, and the snapshot hash the plan expects it to have before the publication. */
export interface GuardHead {
  principal: PrincipalId;
  /** The position key (Keys.position(purpose, subject, role)). */
  position: Hex;
  /**
   * headSnapshotHash(state, revision, admission, target), computed from the head the plan was decided on: never
   * copied from a read of the hashes (an endpoint that lied in a head read can serve the true hash there).
   */
  expected: Hex;
  term: GuardTerm;
}

/** One schedule's guard terms (gas/model.json profiles.<schedule>.guard: constants, split.executionGas or kernel). */
export interface GuardTerms {
  guardFixed: number;
  guardPrincipal: number;
  guardPosition: number;
  guardHeadWritten: number;
  guardHeadWrittenUnread: number;
  guardHeadTwoWords: number;
  guardHeadOneWord: number;
  guardMemoryQuadratic: number;
}

/** A guard's shape: n principals, m positions, and how its n·m heads are priced (gas-plan.mjs `check`'s `guard`). */
export interface GuardShape {
  principals: number;
  positions: number;
  written: number;
  writtenUnread: number;
  twoWords: number;
  oneWord: number;
}

/** The Realm's read-set limits (Limits: maxReadSetPrincipals, maxReadSetPositions; n·m ≤ maxReadCount). */
export interface GuardLimits {
  maxReadSetPrincipals: number;
  maxReadSetPositions: number;
  maxReadCount: number;
}

/** A guard's principals and positions in first-appearance order, and its shape. */
export interface GuardGrid {
  principals: readonly PrincipalId[];
  positions: readonly Hex[];
  shape: GuardShape;
}

const keyOf = (h: GuardHead): string => `${h.principal.toLowerCase()}:${h.position.toLowerCase()}`;

/**
 * The grid `heads` form, or why they form none: a head named twice (`duplicate`), or a principal and a position with
 * no head between them (`incomplete`: the guard names every principal at every position, so each needs an expected
 * value). Principals and positions keep their first-appearance order, so the bytes are a function of the heads alone.
 */
export function guardGrid(
  heads: readonly GuardHead[],
): { ok: true; grid: GuardGrid } | { ok: false; why: "duplicate" | "incomplete" } {
  const principals = new Map<string, PrincipalId>();
  const positions = new Map<string, Hex>();
  const seen = new Set<string>();
  const shape: GuardShape = {
    principals: 0,
    positions: 0,
    written: 0,
    writtenUnread: 0,
    twoWords: 0,
    oneWord: 0,
  };
  for (const h of heads) {
    const k = keyOf(h);
    if (seen.has(k)) return { ok: false, why: "duplicate" };
    seen.add(k);
    if (!principals.has(h.principal.toLowerCase()))
      principals.set(h.principal.toLowerCase(), h.principal);
    if (!positions.has(h.position.toLowerCase()))
      positions.set(h.position.toLowerCase(), h.position);
    shape[h.term] += 1;
  }
  shape.principals = principals.size;
  shape.positions = positions.size;
  if (seen.size !== shape.principals * shape.positions) return { ok: false, why: "incomplete" };
  return {
    ok: true,
    grid: { principals: [...principals.values()], positions: [...positions.values()], shape },
  };
}

/**
 * The read-set limit a guard of this shape is over (in the kernel's order: principals, positions, then n·m over
 * maxReadCount, E_READSET_SHAPE reasons 1, 2 and 5), or null.
 */
export function guardOver(
  s: GuardShape,
  l: GuardLimits,
): "maxReadSetPrincipals" | "maxReadSetPositions" | "maxReadCount" | null {
  if (s.principals > l.maxReadSetPrincipals) return "maxReadSetPrincipals";
  if (s.positions > l.maxReadSetPositions) return "maxReadSetPositions";
  if (s.principals * s.positions > l.maxReadCount) return "maxReadCount";
  return null;
}

/**
 * The gas of a guard of shape `s` under one schedule's terms (gas-plan.mjs `guardCost`), unrounded: added once per
 * guarded publication to E and, with the kernel's terms, to K, before the estimate is rounded. The terms include the
 * guard's calldata, as every constant includes its action's (contracts item 66); the shown estimate adds the real
 * bytes on top, as it does for actions.
 */
export function guardCost(t: GuardTerms, s: GuardShape): number {
  const x = s.principals + s.positions + 3 * s.principals * s.positions;
  return (
    t.guardFixed +
    (s.principals - 1) * t.guardPrincipal +
    (s.positions - 1) * t.guardPosition +
    s.written * t.guardHeadWritten +
    s.writtenUnread * t.guardHeadWrittenUnread +
    s.twoWords * t.guardHeadTwoWords +
    s.oneWord * t.guardHeadOneWord +
    t.guardMemoryQuadratic * x ** 2
  );
}

/** The guard's encoded length (gas-plan.mjs `guardBytes`): abi.encode(ReadSet) of n principals and m positions. */
export const guardBytes = (s: GuardShape): number =>
  224 + 32 * (s.principals + s.positions + s.principals * s.positions);
