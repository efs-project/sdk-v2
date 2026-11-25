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
import {
  type CallOpts,
  EfsFault,
  type Reason,
  type RevertInfo,
  reason,
  type SequenceFault,
} from "../core/errors.js";
import type { Address, Hex } from "../core/hex.js";
import { toJson } from "../core/json.js";
import { setTimer, utf8Encode } from "../core/platform.js";
import { atomicBatchSupport, sendPlansAsBatch, waitForBatch } from "./batch.js";
import {
  type AttemptStage,
  type Journal,
  lockKey,
  type SequenceEffect,
  type SequencePart,
  type SequenceRecord,
  type SequenceState,
} from "./journal.js";
import type { PlanInput } from "./plan.js";
import { waitForReceipt } from "./receipt.js";
import { reconcileAttempt } from "./reconcile.js";
import { type Authorizer, notify, type SendOpts, sendPlan } from "./send.js";
import type { EffectView, Plan, PlanResult, PlanSequenceResult } from "./types.js";

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
  /**
   * Live progress for runSequence and resume, e.g. "Approve part 2 of 5 in your wallet": a "wallet-request" event
   * just before each wallet prompt (after the write-ahead record), and a "committed" event as each part commits.
   * Not awaited, and anything it throws is ignored; the returned SequenceProgress stays the outcome.
   */
  onProgress?: (p: SequenceProgress, e: SequenceEvent) => void;
}

export type SequenceEvent =
  /** The wallet is being asked to approve these parts (0-based indexes; several in one EIP-5792 request). */
  | { kind: "wallet-request"; parts: readonly number[] }
  /** The ledger decided this part (0-based): committed. */
  | { kind: "committed"; index: number };

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
  current?: {
    index: number;
    planId?: Hex;
    stage?: AttemptStage | "NOT_PLANNED";
    /** The current plan's deadline (unix seconds); absent until the part is planned. */
    deadline?: bigint;
    /** The latest block the last reconcile of this part read. */
    checkedAt?: { blockNumber: bigint; timestamp: bigint };
    /**
     * True when that block is past `deadline` and the part was not committed there: on this chain it can no longer
     * be admitted. Judged at the latest block, not a finalized one, so a reorg could in principle still bring back
     * an inclusion from before the deadline; EXPIRED (which waits for finality) is the proof. Release a hold on it,
     * never say "not saved".
     */
    pastDeadline?: boolean;
  };
  /** How the last step went out: one wallet request for all remaining parts, or part by part. */
  mode?: "batch" | "sequential";
  /** Why the save stopped (when it did not reach COMPLETE). */
  reason?: Reason;
  /**
   * What the save is for, e.g. { kind: "files.edit", file, revision }: name it ("readme.txt: Partially saved") and
   * hold new saves of that file. Display only, never what resume sends. Absent on saves started before 0.1 had it.
   */
  effect?: SequenceEffect;
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
const WORD = /^0x[0-9a-fA-F]{64}$/;

/**
 * What a save is for, from its parts' effects: one file edit (every `files.edit` effect names the same file and
 * revision), one created file or folder, or the entries a move, remove or restore touches (each listed once). Else
 * undefined: no Files effect, a malformed one, or effects of different kinds (nothing single to name).
 */
export function sequenceEffect(parts: readonly SequencePartInput[]): SequenceEffect | undefined {
  const effects = parts.flatMap((p) => p.effects).filter((e) => e.code.startsWith("files."));
  if (effects.length === 0) return undefined;
  const code = (effects[0] as EffectView).code;
  if (effects.some((e) => e.code !== code)) return undefined;
  const word = (e: EffectView, k: string): Hex | undefined => {
    const v = e.args[k];
    return v !== undefined && WORD.test(v) ? (v.toLowerCase() as Hex) : undefined;
  };
  const text = (e: EffectView, k: string): string | undefined => {
    const v = e.args[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  /** One value per save: every effect must agree on it. */
  const same = <T>(pick: (e: EffectView) => T | undefined): T | undefined => {
    let found: T | undefined;
    for (const e of effects) {
      const v = pick(e);
      if (v === undefined) return undefined;
      if (found !== undefined && JSON.stringify(found) !== JSON.stringify(v)) return undefined;
      found = v;
    }
    return found;
  };
  /** One value per entry, keyed by (folder, name), each entry once. */
  const each = <T extends { folder: Hex; name: string }>(
    pick: (e: EffectView) => T | undefined,
  ): T[] | undefined => {
    const out = new Map<string, T>();
    for (const e of effects) {
      const v = pick(e);
      if (v === undefined) return undefined;
      const key = `${v.folder}/${v.name}`;
      const prev = out.get(key);
      if (prev && JSON.stringify(prev) !== JSON.stringify(v)) return undefined;
      out.set(key, v);
    }
    return [...out.values()];
  };
  const place = (e: EffectView) => {
    const folder = word(e, "folder");
    const name = text(e, "name");
    return folder && name ? { folder, name } : undefined;
  };
  switch (code) {
    case "files.edit":
      return same((e) => {
        const file = word(e, "file");
        const revision = word(e, "revision");
        return file && revision ? { kind: "files.edit" as const, file, revision } : undefined;
      });
    case "files.create":
      return same((e) => {
        const p = place(e);
        const file = word(e, "file");
        const revision = word(e, "revision");
        return p && file && revision
          ? { kind: "files.create" as const, ...p, file, revision }
          : undefined;
      });
    case "files.createFolder":
      return same((e) => {
        const p = place(e);
        const directory = word(e, "directory");
        return p && directory
          ? { kind: "files.createFolder" as const, ...p, directory }
          : undefined;
      });
    case "files.move": {
      const moves = each((e) => {
        const p = place(e);
        const toFolder = word(e, "toFolder");
        const toName = text(e, "toName");
        const target = word(e, "target");
        return p && toFolder && toName && target ? { ...p, toFolder, toName, target } : undefined;
      });
      return moves ? { kind: "files.move", moves } : undefined;
    }
    case "files.remove": {
      const hide = same((e) =>
        e.args["hide"] === "true" ? true : e.args["hide"] === "false" ? false : undefined,
      );
      const entries = each((e) => {
        const p = place(e);
        const target = word(e, "target");
        return p && target ? { ...p, target } : undefined;
      });
      return entries && hide !== undefined ? { kind: "files.remove", hide, entries } : undefined;
    }
    case "files.restore": {
      const entries = each((e) => {
        const p = place(e);
        const target = word(e, "target");
        return p && target ? { ...p, target } : undefined;
      });
      return entries ? { kind: "files.restore", entries } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Why a save is open, from the record alone: REORGED while a part undone by a reorg is in flight again (it may be
 * re-included; wait), REORGED_DROPPED once that part is proven not committed, and EXPIRED for a part that was sent,
 * never committed, and is proven so past its deadline. For the last two, sending again is the person's choice.
 */
function recordReason(r: SequenceRecord): Reason | undefined {
  const reorged = r.parts.find((x) => x.reorged && !x.committed);
  if (reorged)
    return reorged.planId
      ? reason(
          "REORGED",
          "after-reconcile",
          "a committed part was undone by a reorg; it may be re-included",
        )
      : reason(
          "REORGED_DROPPED",
          "transient",
          "a part undone by a reorg is proven not committed: sending it again is the person's choice",
        );
  if (r.parts.some((x) => x.expired && !x.committed && !x.planId))
    return reason(
      "EXPIRED",
      "transient",
      "a part that was sent is proven not committed (past its deadline, or its nonce went to another plan): sending it again is the person's choice",
    );
  return undefined;
}

/** Some part of the save may be on chain: committed, or planned and past its write-ahead (in flight). */
const recordMayHaveSent = (r: SequenceRecord): boolean =>
  r.parts.some((p) => p.committed === true || p.planId !== undefined);

/** A journal that reports each write-ahead record (SUBMISSION_POSSIBLE) once it is durable. */
function watchWriteAhead(j: Journal, mark: () => void): Journal {
  return {
    durable: j.durable,
    put: async (record) => {
      await j.put(record);
      if (record.stage === "SUBMISSION_POSSIBLE") mark();
    },
    get: (planId) => j.get(planId),
    unresolved: (lock) => j.unresolved(lock),
    putSequence: (record) => j.putSequence(record),
    getSequence: (id) => j.getSequence(id),
    openSequences: (lock) => j.openSequences(lock),
    withLock: (lock, wait, fn) => j.withLock(lock, wait, fn),
  };
}

/** Rethrow out of runSequence/resume as an EfsFault that says whether the save may have gone out. */
function sequenceFault(e: unknown, at: SequenceFault): EfsFault {
  if (e instanceof EfsFault)
    return new EfsFault(e.code, e.message, {
      cause: e,
      sequence: at,
      ...(e.details ? { details: { ...e.details } } : {}),
    });
  const message = e instanceof Error ? e.message : String(e);
  return new EfsFault("INVARIANT", `unexpected error: ${message}`, { cause: e, sequence: at });
}

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

  /**
   * A SequenceProgress from the record alone, with `stage` for the first open part when the caller knows it. No
   * journal read, so it cannot fail: the advisory onProgress events are built from this.
   */
  const snapshot = (
    r: SequenceRecord,
    extra: { mode?: "batch" | "sequential"; reason?: Reason } = {},
    stage?: AttemptStage | "NOT_PLANNED",
  ): SequenceProgress => {
    const index = r.parts.findIndex((p) => !p.committed);
    const part = r.parts[index];
    const known = stage ?? (part && !part.planId ? "NOT_PLANNED" : undefined);
    const why = extra.reason ?? recordReason(r);
    return {
      kind: "efs.sequence",
      sequenceId: r.sequenceId,
      account: r.account,
      state: r.state,
      final: r.state === "COMPLETE" && r.final === true,
      total: r.parts.length,
      committed: r.parts.filter((p) => p.committed).length,
      ...(part
        ? {
            current: {
              index,
              ...(part.planId ? { planId: part.planId } : {}),
              ...(known ? { stage: known } : {}),
              ...(part.planId && part.deadline !== undefined ? { deadline: part.deadline } : {}),
              ...(part.planId && part.checkedAt ? { checkedAt: part.checkedAt } : {}),
              ...(part.planId && part.deadline !== undefined && part.checkedAt
                ? { pastDeadline: part.checkedAt.timestamp > part.deadline }
                : {}),
            },
          }
        : {}),
      ...(extra.mode ? { mode: extra.mode } : {}),
      ...(why ? { reason: why } : {}),
      ...(r.effect ? { effect: r.effect } : {}),
    };
  };

  /** The outcome: the snapshot, with the first open part's attempt stage read from the journal. */
  const progress = async (
    r: SequenceRecord,
    extra: { mode?: "batch" | "sequential"; reason?: Reason } = {},
  ): Promise<SequenceProgress> => {
    const part = r.parts.find((p) => !p.committed);
    const stage = part?.planId
      ? ((await journal.get(part.planId))?.stage ?? "NOT_PLANNED")
      : undefined;
    return snapshot(r, extra, stage);
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
          // Committed here: a reorg dropped it. Sent and never committed: it expired. Either way, never "not sent".
          if (p.committed) p.reorged = true;
          else if (!p.reorged) p.expired = true;
          delete p.planId;
          delete p.committed;
          continue;
        }
        if (attempt.stage === "COMMITTED" && attempt.final !== false) {
          p.committed = true;
          p.final = true;
          delete p.reorged;
          delete p.expired;
          if (attempt.publication !== undefined) p.publication = attempt.publication;
          continue;
        }
        const rec = await reconcileAttempt(efs, journal, p.planId, o);
        // checkedAt (and so pastDeadline) only from a reconcile that read the admission at its basis: a decided
        // outcome, NOT_YET_DECIDABLE or REORGED. A failed read also carries its basis, but proves nothing about that
        // block, so it leaves the last judgement as it was (fail closed: no false "not committed there").
        const readAtBasis =
          rec.outcome !== "UNKNOWN" ||
          rec.reason?.code === "NOT_YET_DECIDABLE" ||
          rec.reason?.code === "REORGED";
        if (readAtBasis && rec.basis?.timestamp !== undefined)
          p.checkedAt = { blockNumber: rec.basis.blockNumber, timestamp: rec.basis.timestamp };
        if (rec.outcome === "COMMITTED") {
          p.committed = true;
          p.final = rec.final === true;
          delete p.reorged;
          delete p.expired;
          if (rec.publication !== undefined) p.publication = rec.publication;
        } else if (rec.outcome === "NOT_COMMITTED_PROVEN") {
          // A part that was committed here, or already seen reorged, is proven dropped (REORGED_DROPPED): sending it
          // again is the person's call.
          if (p.committed) p.reorged = true;
          else if (!p.reorged) p.expired = true; // sent, never committed, past its deadline
          delete p.planId;
          delete p.committed;
        } else {
          // Not decided, or reorged out after a COMMITTED: in flight again (sending it again is the user's
          // choice, never automatic). A reorg is remembered on the part, so every later progress says REORGED.
          if (rec.reason?.code === "REORGED") p.reorged = true;
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

  return { derive, save, progress, snapshot, reconcileParts };
}

/** STALE from a send: the ledger refuses this plan as it stands; `revert` (when known) says why, e.g. E_CAS. */
const staleReason = (sent: { reasons: readonly string[]; revert?: RevertInfo }): Reason => {
  const r = reason("STALE", "after-replan", sent.reasons.join("; "));
  return sent.revert ? { ...r, revert: sent.revert } : r;
};

export function sequenceOps(d: Deps) {
  const { efs, journal } = d;
  const { save, progress, snapshot, reconcileParts } = sequenceCore(efs, journal);

  /**
   * Deliver an advisory event. The progress is built inside the guard from the record alone (no journal read), so
   * neither building nor delivering it can throw, reject, or change what the save does.
   */
  const tell = (o: SequenceOpts, build: () => SequenceProgress, e: SequenceEvent): void => {
    const on = o.onProgress;
    if (on) notify(() => on(build(), e));
  };

  /** Send options whose wallet hook also reports a "wallet-request" for `asked` (the write-ahead is down by then). */
  const asking = (
    o: SequenceOpts,
    r: SequenceRecord,
    asked: readonly number[],
    mode: "batch" | "sequential",
  ): SequenceOpts =>
    o.onProgress
      ? {
          ...o,
          onWalletRequest: () => {
            notify(o.onWalletRequest);
            tell(o, () => snapshot(r, { mode }, "SUBMISSION_POSSIBLE"), {
              kind: "wallet-request",
              parts: asked,
            });
          },
        }
      : o;

  /** Report each part that `after` has committed and `before` had not. */
  const committedSince = (
    o: SequenceOpts,
    before: SequenceRecord,
    after: SequenceRecord,
    mode?: "batch" | "sequential",
  ): void => {
    if (!o.onProgress) return;
    after.parts.forEach((p, index) => {
      if (p.committed && !before.parts[index]?.committed)
        tell(o, () => snapshot(after, mode ? { mode } : {}), { kind: "committed", index });
    });
  };

  /** Send what is left: as one EIP-5792 request when the wallet runs it atomically, else part by part. */
  const advance = async (
    r0: SequenceRecord,
    o: SequenceOpts,
    call: { sent: boolean },
  ): Promise<SequenceProgress> => {
    const settleMs = o.settleMs ?? 60_000;
    const sendJournal = watchWriteAhead(journal, () => {
      call.sent = true;
    });
    let r = await reconcileParts(r0, o, 0);
    committedSince(o, r0, r);
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
        (parts[i] as SequencePart).deadline = (planned.plans[k] as Plan).deadline;
        delete (parts[i] as SequencePart).checkedAt;
        delete (parts[i] as SequencePart).reorged; // sent again: a new attempt, not the reorged one
        delete (parts[i] as SequencePart).expired;
      });
      r = await save({ ...r, parts }, "sending the remaining parts as one wallet request");
      const asked = remaining.map(({ i }) => i);
      const sent = await sendPlansAsBatch(
        efs,
        sendJournal,
        a.provider,
        planned.plans,
        asking(o, r, asked, "batch"),
      );
      if (sent.status === "SUBMITTED")
        await waitForBatch(a.provider, sent.batchId, { timeoutMs: settleMs });
      const sentAt = r;
      r = await reconcileParts(
        r,
        o,
        sent.status === "SUBMITTED" || sent.status === "AMBIGUOUS" ? settleMs : 0,
      );
      committedSince(o, sentAt, r, "batch");
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
      (parts[i] as SequencePart).deadline = planned.plan.deadline;
      delete (parts[i] as SequencePart).checkedAt;
      delete (parts[i] as SequencePart).reorged; // sent again: a new attempt, not the reorged one
      delete (parts[i] as SequencePart).expired;
      r = await save({ ...r, parts }, `sending part ${i + 1} of ${r.parts.length}`);
      const sent = await sendPlan(
        efs,
        sendJournal,
        a,
        planned.plan,
        asking(o, r, [i], "sequential"),
      );
      // Bounded by settleMs, like the batch wait: when it runs out the part stays SUBMITTED (in flight, journaled),
      // never failed; reconcile settles it later from the ledger.
      if (sent.status === "SUBMITTED") await waitForReceipt(efs, sent.txHash, o, settleMs);
      const sentAt = r;
      r = await reconcileParts(
        r,
        o,
        sent.status === "SUBMITTED" || sent.status === "AMBIGUOUS" ? settleMs : 0,
      );
      committedSince(o, sentAt, r, "sequential");
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
      // Every throw from here says where the save stood (EfsFault.mayHaveSent and co.): never "nothing saved".
      const call = { sent: false };
      let stored: Hex | undefined;
      try {
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
          // Each part keeps its own deadline window: it is planned (and re-planned on resume) just before it is sent.
          parts: parts.map((p) => ({
            actions: p.actions,
            bodies: p.bodies,
            effects: p.effects,
            ...(p.deadlineSeconds !== undefined ? { deadlineSeconds: p.deadlineSeconds } : {}),
          })),
          state: "NOT_STARTED",
          history: [{ state: "NOT_STARTED", at: Date.now() }],
        };
        const effect = sequenceEffect(parts);
        if (effect) r.effect = effect;
        await journal.putSequence(r);
        stored = r.sequenceId;
        return await advance(r, o, call);
      } catch (e) {
        throw sequenceFault(e, {
          ...(stored ? { sequenceId: stored } : {}),
          mayHaveSent: call.sent,
          sequenceMayHaveSent: call.sent,
        });
      }
    },
    /** Continue a sequence (settling any in-flight part first). The only call that may prompt. */
    async resume(sequenceId: Hex, o: SequenceOpts = {}): Promise<SequenceProgress> {
      const call = { sent: false };
      // What the record said before this call. Undefined while it has not been read: missing (cleared, or in another
      // journal) or unreadable proves nothing, so the save may have gone out.
      let before: boolean | undefined;
      try {
        const r = await journal.getSequence(sequenceId);
        if (!r) throw new EfsFault("MISUSE", `no sequence ${sequenceId} in this journal`);
        before = recordMayHaveSent(r); // read before the lock check: another account's save may be on chain too
        if (r.lock !== d.lock)
          throw new EfsFault("MISUSE", "that sequence belongs to another account or deployment");
        if (r.state === "COMPLETE" || r.state === "ABANDONED") return await progress(r);
        return await advance(r, o, call);
      } catch (e) {
        throw sequenceFault(e, {
          sequenceId,
          mayHaveSent: call.sent,
          sequenceMayHaveSent: call.sent || (before ?? true),
        });
      }
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
  ...(p.deadlineSeconds !== undefined ? { deadlineSeconds: p.deadlineSeconds } : {}),
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
