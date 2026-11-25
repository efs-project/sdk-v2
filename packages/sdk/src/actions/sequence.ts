// SPDX-License-Identifier: MIT
// A save split into several publications, made resumable. The sequence record (efs-sdk-sequence/1) holds every
// part's inputs and, once planned, its plan id, so a reload after part 2 of 5 continues with parts 3–5.
//
//   - Settling a sequence never needs the wallet: every in-flight part is decided from the ledger (reconcile).
//   - Atomic EIP-5792 wallets get the remaining parts in one wallet_sendCalls request (one approval): only there
//     are parts planned ahead with consecutive native nonces. Everything else is just in time: a part is planned
//     right before it is sent, and sent only after the previous part committed, so a nonce gap cannot happen.
//   - The only success is COMPLETE. PARTIAL means some parts committed and the save stopped; the parts already on
//     chain stay there whatever happens next (an abandoned upload leaves chunks that never appear as a file).
import { keccak256 } from "viem";
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault, type Reason, type RevertInfo, reason } from "../core/errors.js";
import type { Address, Hex } from "../core/hex.js";
import { toJson } from "../core/json.js";
import { setTimer, utf8Encode } from "../core/platform.js";
import { atomicBatchSupport, sendPlansAsBatch, waitForBatch } from "./batch.js";
import {
  type AttemptStage,
  type Journal,
  lockKey,
  type SequencePart,
  type SequenceRecord,
  type SequenceState,
} from "./journal.js";
import type { PlanInput } from "./plan.js";
import { waitForReceipt } from "./receipt.js";
import { reconcileAttempt } from "./reconcile.js";
import { type Authorizer, type SendOpts, sendPlan } from "./send.js";
import type { Plan, PlanResult, PlanSequenceResult } from "./types.js";

export interface SequenceOpts extends SendOpts {
  /** "auto" (default): one EIP-5792 request when the wallet runs calls atomically; "never": part by part. */
  batch?: "auto" | "never";
  /**
   * How long to wait for a sent part's receipt and ledger decision before answering IN_FLIGHT (default 60 s). It
   * bounds the wait only: a part still undecided when it runs out stays SUBMITTED in the journal and the save
   * IN_FLIGHT ("Saved · confirming"), never failed; reconcileSequence or resume settles it from the ledger. With
   * the default, one call carries a part-by-part save through every part; 0 returns right after the first send.
   */
  settleMs?: number;
  pollMs?: number;
}

/** What the client shows: N, how many committed, and where the save is now. */
export interface SequenceProgress {
  kind: "efs.sequence";
  sequenceId: Hex;
  /** The account that started the save: only a writer for this account can resume it. */
  account: Address;
  state: SequenceState;
  /**
   * COMPLETE and every part's admission at a finalized block: "Saved". COMPLETE but not final: "Saved ·
   * confirming" (it stays in pendingSequences; reconcile it until final). False in every other state.
   */
  final: boolean;
  total: number;
  committed: number;
  /** The first part not yet committed: its index, plan and attempt stage (absent when COMPLETE). */
  current?: { index: number; planId?: Hex; stage?: AttemptStage | "NOT_PLANNED" };
  /** How the last step went out: one wallet request for all remaining parts, or part by part. */
  mode?: "batch" | "sequential";
  /** Why the save stopped (when it did not reach COMPLETE). */
  reason?: Reason;
}

export type SequencePartInput = Omit<PlanInput, "account" | "nonce">;

interface Deps {
  efs: Efs;
  journal: Journal;
  authorizer: Authorizer;
  account: Address;
  lock: string;
  plan(input: SequencePartInput, o?: CallOpts): Promise<PlanResult>;
  planSequence(parts: readonly SequencePartInput[], o?: CallOpts): Promise<PlanSequenceResult>;
}

const randomHex = (): string => {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  const b = new Uint8Array(16);
  if (c) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimer(r, ms);
  });

/** The wallet-free part: settle sequences from the ledger and describe them. Needs no account. */
function sequenceCore(efs: Efs, journal: Journal) {
  const derive = (r: SequenceRecord): SequenceState => {
    if (r.state === "ABANDONED") return "ABANDONED";
    const k = r.parts.filter((p) => p.committed).length;
    if (k === r.parts.length) return "COMPLETE";
    if (r.parts.some((p) => p.planId && !p.committed)) return "IN_FLIGHT";
    return k > 0 ? "PARTIAL" : "NOT_STARTED";
  };

  const save = async (r: SequenceRecord, detail?: string): Promise<SequenceRecord> => {
    const state = derive(r);
    const final = state === "COMPLETE" && r.parts.every((p) => p.final !== false);
    const next: SequenceRecord =
      state === r.state && final === (r.final === true) && !detail
        ? r
        : {
            ...r,
            state,
            final,
            history: [...r.history, { state, at: Date.now(), ...(detail ? { detail } : {}) }],
          };
    await journal.putSequence(next);
    return next;
  };

  const progress = async (
    r: SequenceRecord,
    extra: { mode?: "batch" | "sequential"; reason?: Reason } = {},
  ): Promise<SequenceProgress> => {
    const index = r.parts.findIndex((p) => !p.committed);
    let current: SequenceProgress["current"];
    if (index >= 0) {
      const part = r.parts[index] as SequencePart;
      const stage = part.planId ? (await journal.get(part.planId))?.stage : undefined;
      current = {
        index,
        ...(part.planId ? { planId: part.planId } : {}),
        stage: stage ?? "NOT_PLANNED",
      };
    }
    return {
      kind: "efs.sequence",
      sequenceId: r.sequenceId,
      account: r.account,
      state: r.state,
      final: r.state === "COMPLETE" && r.final === true,
      total: r.parts.length,
      committed: r.parts.filter((p) => p.committed).length,
      ...(current ? { current } : {}),
      ...(extra.mode ? { mode: extra.mode } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    };
  };

  /**
   * Decide every in-flight part from the ledger, without the wallet. A part whose plan was never journaled (a crash
   * before its write-ahead) or was refused before broadcast (NOT_SENT) was never sent: it is planned again later.
   * Waits up to `settleMs` for parts that are sent but not yet decided.
   */
  const reconcileParts = async (
    r: SequenceRecord,
    o: SequenceOpts,
    settleMs: number,
  ): Promise<SequenceRecord> => {
    const until = Date.now() + settleMs;
    const parts = r.parts.map((p) => ({ ...p }));
    for (;;) {
      let open = false;
      for (const p of parts) {
        if (!p.planId) continue;
        if (p.committed && p.final !== false) continue; // committed at a finalized block: settled
        const attempt = await journal.get(p.planId);
        if (!attempt || attempt.stage === "PLANNED" || attempt.stage === "NOT_SENT") {
          if (!p.committed) delete p.planId; // never broadcast: safe to plan again
          continue;
        }
        if (attempt.stage === "NOT_COMMITTED_PROVEN") {
          delete p.planId;
          delete p.committed;
          continue;
        }
        if (attempt.stage === "COMMITTED" && attempt.final !== false) {
          p.committed = true;
          p.final = true;
          if (attempt.publication !== undefined) p.publication = attempt.publication;
          continue;
        }
        const rec = await reconcileAttempt(efs, journal, p.planId, o);
        if (rec.outcome === "COMMITTED") {
          p.committed = true;
          p.final = rec.final === true;
          if (rec.publication !== undefined) p.publication = rec.publication;
        } else if (rec.outcome === "NOT_COMMITTED_PROVEN") {
          delete p.planId;
          delete p.committed;
        } else {
          // Not decided, or reorged out after a COMMITTED: in flight again (sending it again is the user's
          // choice, never automatic).
          delete p.committed;
          p.final = false;
          open = true;
        }
      }
      if (!open || Date.now() >= until) break;
      await sleep(o.pollMs ?? 1000);
    }
    return save({ ...r, parts });
  };

  return { derive, save, progress, reconcileParts };
}

/** STALE from a send: the ledger refuses this plan as it stands; `revert` (when known) says why, e.g. E_CAS. */
const staleReason = (sent: { reasons: readonly string[]; revert?: RevertInfo }): Reason => {
  const r = reason("STALE", "after-replan", sent.reasons.join("; "));
  return sent.revert ? { ...r, revert: sent.revert } : r;
};

export function sequenceOps(d: Deps) {
  const { efs, journal } = d;
  const { save, progress, reconcileParts } = sequenceCore(efs, journal);

  /** Send what is left: as one EIP-5792 request when the wallet runs it atomically, else part by part. */
  const advance = async (r0: SequenceRecord, o: SequenceOpts): Promise<SequenceProgress> => {
    const settleMs = o.settleMs ?? 60_000;
    let r = await reconcileParts(r0, o, 0);
    if (r.state === "IN_FLIGHT" || r.state === "COMPLETE" || r.state === "ABANDONED")
      return progress(r);
    const remaining = r.parts.map((p, i) => ({ p, i })).filter(({ p }) => !p.committed);
    const a = d.authorizer;
    if (
      a.kind === "eip1193" &&
      (o.batch ?? "auto") === "auto" &&
      remaining.length >= 2 &&
      (await atomicBatchSupport(a.provider, d.account, efs.deployment.chainId))
    ) {
      const planned = await d.planSequence(
        remaining.map(({ p }) => partInput(p)),
        o,
      );
      if (planned.status !== "PLANNED")
        return progress(r, { mode: "batch", reason: planned.reason });
      const parts = r.parts.map((p) => ({ ...p }));
      remaining.forEach(({ i }, k) => {
        (parts[i] as SequencePart).planId = (planned.plans[k] as Plan).id;
      });
      r = await save({ ...r, parts }, "sending the remaining parts as one wallet request");
      const sent = await sendPlansAsBatch(efs, journal, a.provider, planned.plans, o);
      if (sent.status === "SUBMITTED")
        await waitForBatch(a.provider, sent.batchId, { timeoutMs: settleMs });
      r = await reconcileParts(
        r,
        o,
        sent.status === "SUBMITTED" || sent.status === "AMBIGUOUS" ? settleMs : 0,
      );
      const why =
        sent.status === "NOT_SENT" || sent.status === "AMBIGUOUS"
          ? sent.reason
          : sent.status === "STALE"
            ? staleReason(sent)
            : sent.status === "BUSY"
              ? reason("BUSY", "transient", "another submission for this account is in progress")
              : undefined;
      return progress(r, {
        mode: "batch",
        ...(r.state !== "COMPLETE" && why ? { reason: why } : {}),
      });
    }
    for (const { i } of remaining) {
      const part = r.parts[i] as SequencePart;
      const planned = await d.plan(partInput(part), o);
      if (planned.status !== "PLANNED")
        return progress(r, { mode: "sequential", reason: planned.reason });
      const parts = r.parts.map((p) => ({ ...p }));
      (parts[i] as SequencePart).planId = planned.plan.id;
      r = await save({ ...r, parts }, `sending part ${i + 1} of ${r.parts.length}`);
      const sent = await sendPlan(efs, journal, a, planned.plan, o);
      // Bounded by settleMs, like the batch wait: when it runs out the part stays SUBMITTED (in flight, journaled),
      // never failed; reconcile settles it later from the ledger.
      if (sent.status === "SUBMITTED") await waitForReceipt(efs, sent.txHash, o, settleMs);
      r = await reconcileParts(
        r,
        o,
        sent.status === "SUBMITTED" || sent.status === "AMBIGUOUS" ? settleMs : 0,
      );
      if (!(r.parts[i] as SequencePart).committed) {
        const why =
          sent.status === "NOT_SENT" || sent.status === "AMBIGUOUS"
            ? sent.reason
            : sent.status === "STALE"
              ? staleReason(sent)
              : sent.status === "BUSY"
                ? reason("BUSY", "transient", "another submission for this account is in progress")
                : reason(
                    "NOT_YET_DECIDABLE",
                    "after-reconcile",
                    `part ${i + 1} is not decided yet`,
                  );
        return progress(r, { mode: "sequential", reason: why });
      }
    }
    return progress(r, { mode: "sequential" });
  };

  const load = async (id: Hex): Promise<SequenceRecord> => {
    const r = await journal.getSequence(id);
    if (!r) throw new EfsFault("MISUSE", `no sequence ${id} in this journal`);
    if (r.lock !== d.lock)
      throw new EfsFault("MISUSE", "that sequence belongs to another account or deployment");
    return r;
  };

  return {
    /** Start a split save and carry it as far as it goes. */
    async runSequence(
      parts: readonly SequencePartInput[],
      o: SequenceOpts = {},
    ): Promise<SequenceProgress> {
      if (parts.length === 0) throw new EfsFault("MISUSE", "runSequence needs at least one part");
      const dep = efs.deployment;
      const seed = toJson({
        account: d.account,
        chainId: dep.chainId,
        ledger: dep.ledger,
        at: Date.now(),
        r: randomHex(),
        parts,
      });
      const r: SequenceRecord = {
        schema: "efs-sdk-sequence/1",
        sequenceId: keccak256(utf8Encode(seed)),
        lock: d.lock,
        chainId: dep.chainId,
        realmId: dep.realmId,
        ledger: dep.ledger,
        account: d.account,
        parts: parts.map((p) => ({ actions: p.actions, bodies: p.bodies, effects: p.effects })),
        state: "NOT_STARTED",
        history: [{ state: "NOT_STARTED", at: Date.now() }],
      };
      await journal.putSequence(r);
      return advance(r, o);
    },
    /** Continue a sequence (settling any in-flight part first). The only call that may prompt. */
    async resume(sequenceId: Hex, o: SequenceOpts = {}): Promise<SequenceProgress> {
      const r = await load(sequenceId);
      if (r.state === "COMPLETE" || r.state === "ABANDONED") return progress(r);
      return advance(r, o);
    },
    /** Settle a sequence from the ledger alone. Never prompts; safe on every app start. */
    async reconcileSequence(sequenceId: Hex, o: SequenceOpts = {}): Promise<SequenceProgress> {
      return progress(await reconcileParts(await load(sequenceId), o, 0));
    },
    /** Sequences neither COMPLETE nor ABANDONED, for this account: what to offer to continue. */
    async pendingSequences(): Promise<SequenceProgress[]> {
      return Promise.all((await journal.openSequences(d.lock)).map((r) => progress(r)));
    },
    /**
     * Stop offering to continue. Committed parts stay on chain (nothing is undone). Refused while a part is in
     * flight: settle it first.
     */
    async abandon(sequenceId: Hex, o: SequenceOpts = {}): Promise<SequenceProgress> {
      const r = await reconcileParts(await load(sequenceId), o, 0);
      if (r.state === "IN_FLIGHT")
        return progress(r, {
          reason: reason(
            "IN_FLIGHT",
            "after-reconcile",
            "a part is still in flight; reconcile first",
          ),
        });
      if (r.state === "COMPLETE") return progress(r);
      return progress(await save({ ...r, state: "ABANDONED" }, "abandoned by the caller"));
    },
  };
}

const partInput = (p: SequencePart): SequencePartInput => ({
  actions: p.actions,
  bodies: p.bodies,
  effects: p.effects,
});

/** Sequences without a wallet: settle and list them before anyone connects (resume still needs the writer). */
export interface JournalView {
  /** Open sequences of one account, or of every account on this deployment. Never prompts; creates nothing. */
  pendingSequences(o?: { account?: Address }): Promise<SequenceProgress[]>;
  /** Settle a sequence from the ledger alone. Never prompts. */
  reconcileSequence(sequenceId: Hex, o?: SequenceOpts): Promise<SequenceProgress>;
}

/**
 * Open a journal without a writer: what an app shows after a reload, before the person reconnects ("Partially
 * saved (2 of 5) — Continue"). Continue then connects, creates the writer for `progress.account` and resumes; a
 * writer for another account refuses that sequence (MISUSE), never mixes the two up.
 */
export function openJournal(efs: Efs, config: { journal: Journal }): JournalView {
  const core = sequenceCore(efs, config.journal);
  const d = efs.deployment;
  const prefix = `efs:${d.chainId}:${d.realmId}:${d.ledger}:`.toLowerCase();
  return {
    async pendingSequences(o = {}) {
      const lock = o.account
        ? lockKey({
            chainId: d.chainId,
            realmId: d.realmId,
            ledger: d.ledger,
            account: o.account.toLowerCase() as Address,
          })
        : undefined;
      const open = await config.journal.openSequences(lock);
      return Promise.all(
        open.filter((r) => r.lock.startsWith(prefix)).map((r) => core.progress(r)),
      );
    },
    async reconcileSequence(sequenceId, o = {}) {
      const r = await config.journal.getSequence(sequenceId);
      if (!r || !r.lock.startsWith(prefix))
        throw new EfsFault(
          "MISUSE",
          `no sequence ${sequenceId} for this deployment in this journal`,
        );
      return core.progress(await core.reconcileParts(r, o, 0));
    },
  };
}
