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
