// SPDX-License-Identifier: MIT
// The attempt journal: durable before its promise resolves. Every write records SUBMISSION_POSSIBLE before the wallet
// call that might broadcast, so a crash or a lost response can never leave an attempt that looks safe to re-send.
import { misuse } from "../core/errors.js";
import type { Address, Hex } from "../core/hex.js";
import { fromJson, toJson } from "../core/json.js";
import { clearTimer, clone, setTimer } from "../core/platform.js";
import type { ActionData, EffectView, Plan } from "./types.js";

export type AttemptStage =
  | "PLANNED"
  | "SUBMISSION_POSSIBLE"
  | "SUBMITTED"
  | "NOT_SENT"
  | "COMMITTED"
  | "NOT_COMMITTED_PROVEN";

export interface AttemptRecord {
  schema: "efs-sdk-attempt/1";
  planId: Hex;
  plan: Plan;
  stage: AttemptStage;
  txHash?: Hex;
  publication?: bigint;
  /**
   * On COMMITTED: false while the admission is not yet at a finalized block (it could still be reorged out);
   * true once it is. Absent on records from older SDKs, which are treated as final.
   */
  final?: boolean;
  history: readonly { stage: AttemptStage; at: number; detail?: string }[];
  /** Unknown fields from newer SDKs are preserved here on rewrite. */
  extensions?: Record<string, unknown>;
}

/** The lock key: one submission at a time per (chain, realm, deployment, account). */
export function lockKey(plan: Pick<Plan, "chainId" | "realmId" | "ledger" | "account">): string {
  return `efs:${plan.chainId}:${plan.realmId}:${plan.ledger}:${plan.account}`.toLowerCase();
}

/**
 * A save split into several publications (writer.runSequence). The only success is COMPLETE (every part
 * committed). PARTIAL: some parts committed, then it stopped; continue with writer.resume. ABANDONED: the caller
 * gave up; parts already committed stay on chain (they cannot be undone).
 */
export type SequenceState = "NOT_STARTED" | "IN_FLIGHT" | "PARTIAL" | "COMPLETE" | "ABANDONED";

export interface SequencePart {
  actions: readonly ActionData[];
  bodies: readonly Hex[];
  effects: readonly EffectView[];
  /** The part's own deadline window (PlanInput.deadlineSeconds), applied each time it is planned. */
  deadlineSeconds?: number;
  /** The plan sent (or about to be sent) for this part; a part is planned just before it is sent. */
  planId?: Hex;
  /** True once the ledger admitted this part's plan. */
  committed?: boolean;
  /** True once that admission is at a finalized block. */
  final?: boolean;
  publication?: bigint;
  /**
   * True while this part is uncommitted because a reorg undid its admission: in flight again while `planId` is
   * set (REORGED), proven dropped once it is not (REORGED_DROPPED). Cleared when it commits or is planned again.
   */
  reorged?: true;
  /**
   * True once a part that was sent (past its write-ahead) and never committed is proven not committed past its
   * deadline, without a reorg (EXPIRED). Cleared when it is planned again.
   */
  expired?: true;
}

/**
 * What a save is for, so a UI can name it and hold new saves per file. Display and blocking data only: it never
 * changes what is planned or sent. Set when runSequence starts; records written before it have none.
 */
export interface SequenceEffect {
  kind: "files.edit";
  /** The file (subject) being edited. */
  file: Hex;
  /** The revision the edit creates. */
  revision: Hex;
}

export interface SequenceRecord {
  schema: "efs-sdk-sequence/1";
  sequenceId: Hex;
  /** What the save is for (see SequenceEffect); absent on records written before it, or when no single file. */
  effect?: SequenceEffect;
  /** The submission lock key of the account (lockKey). */
  lock: string;
  chainId: number;
  realmId: Hex;
  ledger: Address;
  account: Address;
  parts: readonly SequencePart[];
  state: SequenceState;
  /** COMPLETE and every part's admission at a finalized block ("Saved" rather than "Saved · confirming"). */
  final?: boolean;
  history: readonly { state: SequenceState; at: number; detail?: string }[];
  /** Unknown fields from newer SDKs are preserved here on rewrite. */
  extensions?: Record<string, unknown>;
}

/** Open: not abandoned, and not COMPLETE-and-final (a COMPLETE save stays open until it is final). */
export const isOpenSequence = (s: SequenceRecord): boolean =>
  s.state !== "ABANDONED" && !(s.state === "COMPLETE" && s.final !== false);

export interface Journal {
  /** Durable before it resolves. Replaces the record for `planId`. */
  put(record: AttemptRecord): Promise<void>;
  get(planId: Hex): Promise<AttemptRecord | undefined>;
  /** Attempts not yet settled (see isSettled: a COMMITTED attempt not yet final counts), for the lock key. */
  unresolved(lock: string): Promise<AttemptRecord[]>;
  /** Durable before it resolves. Replaces the sequence record for `sequenceId`. */
  putSequence(record: SequenceRecord): Promise<void>;
  getSequence(sequenceId: Hex): Promise<SequenceRecord | undefined>;
  /** Open sequences (isOpenSequence) for the given lock key, or for every lock when it is omitted. */
  openSequences(lock?: string): Promise<SequenceRecord[]>;
  /** Run `fn` holding the submission lock, or return "BUSY" if `wait` is false and it is held. */
  withLock<T>(lock: string, wait: boolean | number, fn: () => Promise<T>): Promise<T | "BUSY">;
  /** True when the store survives a crash. memoryJournal is false: tests only. */
  readonly durable: boolean;
}

const RESOLVED: ReadonlySet<AttemptStage> = new Set([
  "COMMITTED",
  "NOT_COMMITTED_PROVEN",
  "NOT_SENT",
]);

export type WithLock = <T>(
  lock: string,
  wait: boolean | number,
  fn: () => Promise<T>,
) => Promise<T | "BUSY">;

/**
 * Locks for this JavaScript context only: callers queue in order, and `wait` is false (BUSY at once if held), true
 * (queue until free) or a number of milliseconds (BUSY if not acquired in time). The building block of every journal.
 */
export function localLocks(): WithLock {
  const tails = new Map<string, Promise<void>>();
  return async (lock, wait, fn) => {
    const prev = tails.get(lock);
    if (prev && wait === false) return "BUSY";
    let release = (): void => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = (prev ?? Promise.resolve()).then(() => mine);
    tails.set(lock, tail);
    try {
      if (prev && wait !== true) {
        let timer: unknown;
        const acquired = await Promise.race([
          prev.then(() => true),
          new Promise<boolean>((r) => {
            timer = setTimer(() => r(false), wait === false ? 0 : wait);
          }),
        ]);
        clearTimer(timer);
        if (!acquired) return "BUSY"; // `finally` releases our place, so later waiters only wait on `prev`
      } else if (prev) await prev;
      return await fn();
    } finally {
      release();
      if (tails.get(lock) === tail) tails.delete(lock);
    }
  };
}

/** In-memory journal with an in-process lock. NOT durable: for tests and scripts that accept losing attempts. */
export function memoryJournal(): Journal {
  const records = new Map<string, AttemptRecord>();
  const sequences = new Map<string, SequenceRecord>();
  return {
    durable: false,
    async putSequence(record) {
      sequences.set(record.sequenceId.toLowerCase(), clone(record));
    },
    async getSequence(id) {
      const r = sequences.get(id.toLowerCase());
      return r ? clone(r) : undefined;
    },
    async openSequences(lock) {
      return [...sequences.values()]
        .filter((r) => (lock === undefined || r.lock === lock) && isOpenSequence(r))
        .map((r) => clone(r));
    },
    async put(record) {
      records.set(record.planId.toLowerCase(), clone(record));
    },
    async get(planId) {
      const r = records.get(planId.toLowerCase());
      return r ? clone(r) : undefined;
    },
    async unresolved(lock) {
      return [...records.values()]
        .filter((r) => !isSettled(r) && lockKey(r.plan) === lock)
        .map((r) => clone(r));
    },
    withLock: localLocks(),
  };
}

export const isResolved = (stage: AttemptStage): boolean => RESOLVED.has(stage);

/**
 * Nothing left to check for this attempt: NOT_SENT, NOT_COMMITTED_PROVEN, or COMMITTED at a finalized block. A
 * COMMITTED attempt that is not final yet stays unresolved, so reconcile keeps re-checking it until finality and
 * catches a reorg that drops it.
 */
export const isSettled = (r: Pick<AttemptRecord, "stage" | "final">): boolean =>
  RESOLVED.has(r.stage) && !(r.stage === "COMMITTED" && r.final === false);

/** The storage form of a record (see docs/design/journal-storage.md): JSON, bigints as tagged decimal strings. */
export function encodeJournalRecord(record: AttemptRecord): string {
  return toJson(record);
}

/** Parse a stored record. Throws MISUSE for text that is not an `efs-sdk-attempt/1` record. */
export function decodeJournalRecord(text: string): AttemptRecord {
  let r: unknown;
  try {
    r = fromJson(text);
  } catch (e) {
    throw misuse("not a journal record: invalid JSON", { cause: String(e) });
  }
  const o = r as Partial<AttemptRecord> | null;
  if (
    o?.schema !== "efs-sdk-attempt/1" ||
    typeof o.planId !== "string" ||
    typeof o.stage !== "string" ||
    !o.plan ||
    !Array.isArray(o.history)
  )
    throw misuse("not an efs-sdk-attempt/1 journal record");
  return o as AttemptRecord;
}

/** The storage form of a sequence record (the same tagged JSON as encodeJournalRecord). */
export function encodeSequenceRecord(record: SequenceRecord): string {
  return toJson(record);
}

/** Parse a stored sequence. Throws MISUSE for text that is not an `efs-sdk-sequence/1` record. */
export function decodeSequenceRecord(text: string): SequenceRecord {
  let r: unknown;
  try {
    r = fromJson(text);
  } catch (e) {
    throw misuse("not a sequence record: invalid JSON", { cause: String(e) });
  }
  const o = r as Partial<SequenceRecord> | null;
  if (
    o?.schema !== "efs-sdk-sequence/1" ||
    typeof o.sequenceId !== "string" ||
    typeof o.lock !== "string" ||
    !Array.isArray(o.parts) ||
    typeof o.state !== "string"
  )
    throw misuse("not an efs-sdk-sequence/1 record");
  return o as SequenceRecord;
}
