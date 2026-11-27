// SPDX-License-Identifier: MIT
/** `@efs/sdk/actions`: plan, review, send and reconcile publications, with a durable attempt journal. */

export type { BatchSendResult } from "./batch.js";
export { atomicBatchSupport } from "./batch.js";
export type { GasLimit, GasLimitInput } from "./gaslimit.js";
export { gasLimitOf, reservoirProfile, TX_GAS_HARD_MAX } from "./gaslimit.js";
export type { GuardHead, GuardMode, GuardTerm, GuardTerms, PartGuardHead } from "./guard.js";
export { headSnapshotHash } from "./guard.js";
export type {
  AttemptRecord,
  AttemptStage,
  Journal,
  PartUnit,
  SequenceEffect,
  SequencePart,
  SequenceRecord,
  SequenceState,
  WithLock,
} from "./journal.js";
export {
  decodeJournalRecord,
  decodeSequenceRecord,
  encodeJournalRecord,
  encodeSequenceRecord,
  isResolved,
  isSettled,
  localLocks,
  lockKey,
  memoryJournal,
} from "./journal.js";
export type { PlanInput } from "./plan.js";
export { actionsHash, planPublication } from "./plan.js";
export type { ReconcileOpts } from "./reconcile.js";
export { reconcileAttempt } from "./reconcile.js";
export type { Authorizer, LocalAccountLike, SendOpts } from "./send.js";
export { decodeRevert } from "./send.js";
export type {
  JournalView,
  SequenceEvent,
  SequenceOpts,
  SequencePartInput,
  SequenceProgress,
  WalletAnswerCode,
  WalletAnswerReason,
} from "./sequence.js";
export { MAX_SPLIT_DEPTH, openJournal, WALLET_ANSWER_CODES } from "./sequence.js";
export type {
  BatchLimits,
  BindRow,
  FloorModel,
  GasConstants,
  GasModel,
  GasPlan,
  KernelQuote,
  PlannedAction,
  SplitOptions,
  SplitPart,
  SplitResult,
} from "./split.js";
export {
  actionGas,
  gasPlanFor,
  kernelQuote,
  publicationGas,
  splitPublications,
  TX_GAS_CAP,
  txGasCapOf,
} from "./split.js";
export type {
  ActionData,
  EffectView,
  Plan,
  PlanResult,
  PlanSequenceResult,
  ReconcileResult,
  Review,
  SendResult,
} from "./types.js";
export { ACTION } from "./types.js";
export type { EfsWriter, RunResult, WriterConfig } from "./writer.js";
export { createWriter } from "./writer.js";
