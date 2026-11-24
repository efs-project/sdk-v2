// SPDX-License-Identifier: MIT
// The attempt journal: durable before its promise resolves. Every write records SUBMISSION_POSSIBLE before the wallet
// call that might broadcast, so a crash or a lost response can never leave an attempt that looks safe to re-send.
import { misuse } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import { fromJson, toJson } from "../core/json.js";
import { clearTimer, clone, setTimer } from "../core/platform.js";
import type { Plan } from "./types.js";

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
  history: readonly { stage: AttemptStage; at: number; detail?: string }[];
  /** Unknown fields from newer SDKs are preserved here on rewrite. */
  extensions?: Record<string, unknown>;
}

/** The lock key: one submission at a time per (chain, realm, deployment, account). */
export function lockKey(plan: Pick<Plan, "chainId" | "realmId" | "ledger" | "account">): string {
  return `efs:${plan.chainId}:${plan.realmId}:${plan.ledger}:${plan.account}`.toLowerCase();
}

export interface Journal {
  /** Durable before it resolves. Replaces the record for `planId`. */
  put(record: AttemptRecord): Promise<void>;
  get(planId: Hex): Promise<AttemptRecord | undefined>;
  /** Attempts not yet COMMITTED, NOT_COMMITTED_PROVEN or NOT_SENT, for the given lock key. */
  unresolved(lock: string): Promise<AttemptRecord[]>;
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
  return {
    durable: false,
    async put(record) {
      records.set(record.planId.toLowerCase(), clone(record));
    },
    async get(planId) {
      const r = records.get(planId.toLowerCase());
      return r ? clone(r) : undefined;
    },
    async unresolved(lock) {
      return [...records.values()]
        .filter((r) => !RESOLVED.has(r.stage) && lockKey(r.plan) === lock)
        .map((r) => clone(r));
    },
    withLock: localLocks(),
  };
}

export const isResolved = (stage: AttemptStage): boolean => RESOLVED.has(stage);

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
