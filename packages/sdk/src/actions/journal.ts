// SPDX-License-Identifier: MIT
// The attempt journal: durable before its promise resolves. Every write records SUBMISSION_POSSIBLE before the wallet
// call that might broadcast, so a crash or a lost response can never leave an attempt that looks safe to re-send.
import type { Hex } from "../core/hex.js";
import { clone } from "../core/platform.js";
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

/** In-memory journal with an in-process lock. NOT durable: for tests and scripts that accept losing attempts. */
export function memoryJournal(): Journal {
  const records = new Map<string, AttemptRecord>();
  const locks = new Map<string, Promise<void>>();
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
    async withLock(lock, wait, fn) {
      const held = locks.get(lock);
      if (held && wait === false) return "BUSY";
      if (held) await held;
      let release = (): void => {};
      const mine = new Promise<void>((r) => {
        release = r;
      });
      locks.set(lock, mine);
      try {
        return await fn();
      } finally {
        locks.delete(lock);
        release();
      }
    },
  };
}

export const isResolved = (stage: AttemptStage): boolean => RESOLVED.has(stage);
