// SPDX-License-Identifier: MIT
// The on-chain status vocabulary (contracts src/interfaces/Results.sol, generated from the release). The pin checks
// describe().statusVocabularyId against STATUS_VOCABULARY_ID, so this mapping is never applied to a deployment that
// uses another vocabulary.
import { STATUS_CODES } from "../generated/constants.js";

export { STATUS_CODES };
export type ChainStatus = (typeof STATUS_CODES)[keyof typeof STATUS_CODES];

/** Map a reader's numeric status. 0 is never returned by a reader; it means the call itself failed. */
export function chainStatus(
  code: number | bigint,
): ChainStatus | "TRANSPORT_FAULT" | "UNRECOGNIZED" {
  const n = Number(code);
  if (n === 0) return "TRANSPORT_FAULT";
  return (STATUS_CODES as Record<number, ChainStatus>)[n] ?? "UNRECOGNIZED";
}

/** Head (binding) states (LedgerApply.sol). */
export const HEAD_STATES = { 0: "UNSET", 1: "BOUND", 2: "MASKED", 3: "RELEASED" } as const;
export type HeadState = (typeof HEAD_STATES)[keyof typeof HEAD_STATES];
export function headState(code: number | bigint): HeadState | "UNRECOGNIZED" {
  return (HEAD_STATES as Record<number, HeadState>)[Number(code)] ?? "UNRECOGNIZED";
}

/**
 * A head with statements that never bound: not UNSET, and `targetKind` 0 (the Head's targetKind is served as stored,
 * 0 only for a head no BIND ever touched, while its `target` is canonical, 0 unless BOUND; LedgerApply sets targetKind
 * only in a BIND). A lone no, or a no then a release or another no. A BIND there writes head.target fresh in the
 * kernel, and the planners price it by bind<Purpose>AfterNo (gas/model.json laterRows.rule; contracts 04526b1), whose
 * row carries that slot; its position in the binding (the history word) is corrected from its expected revision.
 */
export function neverBoundHead(h: {
  state: number | bigint;
  targetKind: number | bigint;
}): boolean {
  return headState(h.state) !== "UNSET" && Number(h.targetKind) === 0;
}

/**
 * Whether a LedgerViews.headsAt reply's status is one it serves (PRESENT: a head decides; MASKED; ABSENT_PROVEN: none
 * does). Anything else (UNKNOWN, a reserved state, a refusal) is the endpoint's fault: every headsAt read fails over.
 */
export function headsAtServed(status: number | bigint): boolean {
  const cs = chainStatus(status);
  return cs === "PRESENT" || cs === "MASKED" || cs === "ABSENT_PROVEN";
}
