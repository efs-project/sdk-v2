// SPDX-License-Identifier: MIT
// A save split into several publications, made resumable. The sequence record (efs-sdk-sequence/1) holds every
// part's inputs and, once planned, its plan id, so a reload after part 2 of 5 continues with parts 3–5.
//
//   - Settling a sequence never needs the wallet: every in-flight part is decided from the ledger (reconcile).
//   - Atomic EIP-5792 wallets get consecutive remaining parts in one wallet_sendCalls request (one approval) while
//     their summed gas fits one transaction, since an atomic batch may run as a single transaction: only a batch's
//     parts are planned ahead with consecutive native nonces. A failed batch lowers the save's batchMax, so the
//     same batch is never sent again. Everything else is just in time: a part is planned right before it is sent,
//     and sent only after the previous part committed, so a nonce gap cannot happen.
//   - The only success is COMPLETE. PARTIAL means some parts committed and the save stopped; the parts already on
//     chain stay there whatever happens next (an abandoned upload leaves chunks that never appear as a file).
import { keccak256 } from "viem";
import { getBlock } from "../chain/basis.js";
import { onEndpoint } from "../chain/pool.js";
import type { Efs } from "../client.js";
import {
  type CallOpts,
  EfsFault,
  type Reason,
  type RevertInfo,
  reason,
  type SequenceFault,
} from "../core/errors.js";
import { type Address, type Hex, isWord, lower } from "../core/hex.js";
import { toJson } from "../core/json.js";
import { setTimer, utf8Encode } from "../core/platform.js";
import {
  atomicBatchSupport,
  type BatchSendResult,
  sendPlansAsBatch,
  waitForBatch,
} from "./batch.js";
import { EMPTY_GUARD, encodeGuard } from "./guard.js";
import {
  type AttemptStage,
  type Journal,
  lockKey,
  type PartUnit,
  type SequenceEffect,
  type SequencePart,
  type SequenceRecord,
  type SequenceState,
} from "./journal.js";
import { actionsHash, type PlanInput } from "./plan.js";
import { waitForReceipt } from "./receipt.js";
import { reconcileAttempt } from "./reconcile.js";
import { type Authorizer, fundsResendable, notify, type SendOpts, sendPlan } from "./send.js";
import { gasPlanFor, packBatches } from "./split.js";
import type { EffectView, Plan, PlanResult, PlanSequenceResult } from "./types.js";

export interface SequenceOpts extends SendOpts {
  /**
   * "auto" (default): with a wallet that runs calls atomically (EIP-5792), consecutive parts share one request while
   * their summed gas fits one transaction; "never": part by part.
   */
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
  /**
   * A part found too large for one transaction is cut into smaller ones before anything is sent for it. When that
   * needs more wallet approvals than the review said: "ask" (default) stops before any of them, returning RESPLIT with
   * the counts (the person continues with resume); "continue" goes on, for an app that told the person up front.
   */
  resplit?: "ask" | "continue";
}

export type SequenceEvent =
  /** The wallet is being asked to approve these parts (0-based indexes; several in one EIP-5792 request). */
  | { kind: "wallet-request"; parts: readonly number[] }
  /** The ledger decided this part (0-based): committed. */
  | { kind: "committed"; index: number }
  /**
   * The wallet or its node answered these parts' send (0-based indexes) with a named reason, and it may have gone out
   * (the send is AMBIGUOUS): emitted at once, before the save checks the ledger for its settle window. Above all
   * INSUFFICIENT_FUNDS, so a page can say "Your wallet needs enough to cover the gas limit" while the save keeps
   * checking; also WALLET_DISCONNECTED, WALLET_CHAIN_DISCONNECTED and RESPONSE_LOST.
   */
  | { kind: "wallet-answer"; parts: readonly number[]; reason: WalletAnswerReason };

/** The reasons a "wallet-answer" event carries: exactly these, the ones meaning the wallet or its node answered. */
export const WALLET_ANSWER_CODES = [
  "INSUFFICIENT_FUNDS",
  "WALLET_DISCONNECTED",
  "WALLET_CHAIN_DISCONNECTED",
  "RESPONSE_LOST",
] as const;
export type WalletAnswerCode = (typeof WALLET_ANSWER_CODES)[number];
export type WalletAnswerReason = Reason & { code: WalletAnswerCode };

/**
 * @internal The reason a send's "wallet-answer" event carries, or null: an AMBIGUOUS send whose reason is one of
 * WALLET_ANSWER_CODES. An allow-list, so a new AMBIGUOUS code reports nothing until someone decides it should.
 */
export function walletAnswer(sent: { status: string; reason?: Reason }): WalletAnswerReason | null {
  const why = sent.reason;
  return sent.status === "AMBIGUOUS" &&
    why !== undefined &&
    (WALLET_ANSWER_CODES as readonly string[]).includes(why.code)
    ? (why as WalletAnswerReason)
    : null;
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
  /** How the last step went out: one wallet request for several parts, or one part by itself. */
  mode?: "batch" | "sequential";
  /** Why the save stopped (when it did not reach COMPLETE). */
  reason?: Reason;
  /**
   * COMPLETE: a read at or after this block sees the whole save (the highest block reconcile saw a part committed
   * at). Pass it as `atLeast` from another tab or a worker; on this client, and on any client reading this journal
   * on the same chain, the read floor already holds it.
   */
  visibleAt?: { blockNumber: bigint; blockHash: Hex };
  /**
   * What the save is for, e.g. { kind: "files.edit", file, revision }: name it ("readme.txt: Partially saved") and
   * hold new saves of that file. Display only, never what resume sends. Absent on saves started before 0.1 had it.
   */
  effect?: SequenceEffect;
}

/**
 * A part as a planner made it: PlanInput.gas and .total carry its batching estimate and its whole gas, and `units`
 * where it may be re-split (SequencePart.units).
 */
export type SequencePartInput = Omit<PlanInput, "account" | "nonce"> & {
  units?: readonly PartUnit[];
};

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

/**
 * @internal The hash a sequence records of its parts' content: what decides what each part signs, its gas limit and
 * batching, and what the person is shown (never the per-attempt fields: plan id, deadline, commit and reconcile
 * state). It detects a journal corrupted or written by another version; it is no secret, so it can't stop a party
 * who can write the journal (that party could recompute it).
 */
export function partsHashOf(parts: readonly SequencePart[]): Hex {
  return keccak256(
    utf8Encode(
      toJson(
        parts.map((p) => ({
          actions: p.actions,
          bodies: p.bodies,
          effects: p.effects,
          units: p.units ?? null,
          splitDepth: p.splitDepth ?? 0,
          deadlineSeconds: p.deadlineSeconds ?? null,
          gas: p.gas ?? null,
          total: p.total ?? null,
          // only when present: a part without a guard hashes exactly as before the guard (older journals resume)
          ...(p.guard ? { guard: p.guard } : {}),
        })),
      ),
    ),
  );
}

/** The wallet-free part: settle sequences from the ledger and describe them. Needs no account. */
const WORD = /^0x[0-9a-fA-F]{64}$/;

/**
 * What a save is for, from its parts' effects: one file edit (every `files.edit` effect names the same file and
 * revision), one created file or folder, or the entries a move, remove, restore, hide or unhide touches (each listed
 * once). Else undefined: no Files effect, a malformed one, or effects of different kinds (nothing single to name).
 */
export function sequenceEffect(parts: readonly SequencePartInput[]): SequenceEffect | undefined {
  const all = parts
    .flatMap((p) => p.effects)
    .filter((e) => e.code.startsWith("files.") || e.code.startsWith("tags."));
  // A tag save's registration-only parts (tags.register) fold into its statements' kind.
  const statements = all.filter((e) => e.code !== "tags.register");
  const effects = statements.length ? statements : all;
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
  const int = (e: EffectView, k: string): number | undefined => {
    const v = e.args[k];
    return v !== undefined && /^-?[0-9]{1,6}$/.test(v) ? Number(v) : undefined;
  };
  const flag = (e: EffectView, k: string): boolean | undefined =>
    e.args[k] === "true" ? true : e.args[k] === "false" ? false : undefined;
  /** One word per effect, each listed once in order. */
  const things = (pick: (e: EffectView) => Hex | undefined): Hex[] | undefined => {
    const out: Hex[] = [];
    for (const e of effects) {
      const v = pick(e);
      if (v === undefined) return undefined;
      if (!out.includes(v)) out.push(v);
    }
    return out;
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
    case "files.unhide": {
      const entries = each(place);
      return entries ? { kind: "files.unhide", entries } : undefined;
    }
    case "files.hide": {
      const entries = each((e) => {
        const p = place(e);
        if (!p || e.args["author"] === undefined) return p;
        const author = word(e, "author");
        return author ? { ...p, author } : undefined; // a malformed author is a malformed effect
      });
      return entries ? { kind: "files.hide", entries } : undefined;
    }
    case "tags.tag":
    case "tags.deny":
    case "tags.untag": {
      const topic = same((e) => word(e, "topic"));
      const targets = things((e) => word(e, "thing"));
      if (!topic || !targets) return undefined;
      if (code === "tags.untag") return { kind: "tags.untag", topic, targets };
      const number = same((e) => int(e, "number"));
      return number === undefined ? undefined : { kind: code, topic, number, targets };
    }
    case "tags.register": {
      const topics = things((e) => word(e, "topic"));
      return topics ? { kind: "tags.register", topics } : undefined;
    }
    case "tags.label": {
      const v = same((e) => {
        const subject = word(e, "subject");
        const lang = text(e, "lang");
        const remove = flag(e, "remove");
        return subject && lang && remove !== undefined ? { subject, lang, remove } : undefined;
      });
      return v ? { kind: "tags.label", ...v } : undefined;
    }
    case "tags.same":
    case "tags.broader": {
      const v = same((e) => {
        const subject = word(e, "subject");
        const other = word(e, "other");
        const remove = flag(e, "remove");
        return subject && other && remove !== undefined ? { subject, other, remove } : undefined;
      });
      return v ? { kind: code, ...v } : undefined;
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

/** A stored block that can be a floor: a 32-byte hash and a block number from 0 to 2^53 - 1 (anything else is damage). */
const MAX_BLOCK = BigInt(Number.MAX_SAFE_INTEGER);
const plausibleBlock = (b: unknown): b is { blockNumber: bigint; blockHash: Hex } => {
  const x = b as { blockNumber?: unknown; blockHash?: unknown } | null | undefined;
  return (
    typeof x?.blockNumber === "bigint" &&
    x.blockNumber >= 0n &&
    x.blockNumber <= MAX_BLOCK &&
    isWord(x.blockHash)
  );
};

/** The highest well-formed block a committed part of `r` was seen committed at, or undefined. */
function lastCommittedAt(r: SequenceRecord): { blockNumber: bigint; blockHash: Hex } | undefined {
  let best: { blockNumber: bigint; blockHash: Hex } | undefined;
  for (const p of r.parts)
    if (
      p.committed &&
      plausibleBlock(p.committedAt) &&
      (!best || p.committedAt.blockNumber > best.blockNumber)
    )
      best = { blockNumber: p.committedAt.blockNumber, blockHash: lower(p.committedAt.blockHash) };
  return best;
}

/** This chain's genesis block hash, read once per client (the read floor keeps it); undefined when no endpoint says. */
async function genesisOf(efs: Efs, o: CallOpts): Promise<Hex | undefined> {
  const floor = efs._internal.pool.floor;
  if (floor.genesis) return floor.genesis;
  const g = await onEndpoint(efs._internal.pool, (s) => getBlock(s, 0n), o);
  if (g.ok) floor.genesis = g.value.hash;
  return floor.genesis;
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
    // Parts are admitted in nonce order, so once the last part's block is known, the highest block seen covers all.
    const visible =
      r.state === "COMPLETE" && r.parts[r.parts.length - 1]?.committedAt
        ? lastCommittedAt(r)
        : undefined;
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
      ...(visible ? { visibleAt: visible } : {}),
    };
  };

  /** The outcome: the snapshot, with the first open part's attempt stage read from the journal. */
  const progress = async (
    r: SequenceRecord,
    extra: { mode?: "batch" | "sequential"; reason?: Reason } = {},
  ): Promise<SequenceProgress> => {
    // A save read back from the journal (another tab, a reload) is a read floor on this client, on its own chain
    // only: same chain id and ledger here, the genesis hash when a pin would read below it (chain/floor.ts).
    // The record is stored data: only well-formed parts count (lastCommittedAt), with a well-formed genesis.
    const seen = lastCommittedAt(r);
    const d = efs.deployment;
    if (
      seen &&
      isWord(r.genesisHash) &&
      r.chainId === d.chainId &&
      typeof r.ledger === "string" &&
      lower(r.ledger) === lower(d.ledger)
    )
      efs._internal.pool.floor.seed({
        key: r.sequenceId,
        ...seen,
        genesisHash: lower(r.genesisHash),
      });
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
          delete p.committedAt;
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
          // The first block seen committed at: reconcile's basis, at or after the inclusion block.
          if (!p.committedAt && rec.basis)
            p.committedAt = { blockNumber: rec.basis.blockNumber, blockHash: rec.basis.blockHash };
        } else if (rec.outcome === "NOT_COMMITTED_PROVEN") {
          // A part that was committed here, or already seen reorged, is proven dropped (REORGED_DROPPED): sending it
          // again is the person's call.
          if (p.committed) p.reorged = true;
          else if (!p.reorged) p.expired = true; // sent, never committed, past its deadline
          delete p.planId;
          delete p.committed;
          delete p.committedAt;
        } else {
          // Not decided, or reorged out after a COMMITTED: in flight again (sending it again is the user's
          // choice, never automatic). A reorg is remembered on the part, so every later progress says REORGED.
          if (rec.reason?.code === "REORGED") p.reorged = true;
          delete p.committed;
          delete p.committedAt;
          p.final = false;
          open = true;
        }
      }
      if (!open || Date.now() >= until) break;
      await sleep(o.pollMs ?? 1000);
    }
    // The chain a part's block belongs to, recorded with the first one (a floor for other clients on this chain only).
    const genesisHash =
      r.genesisHash ?? (parts.some((p) => p.committedAt) ? await genesisOf(efs, o) : undefined);
    return save({ ...r, parts, ...(genesisHash ? { genesisHash } : {}) });
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

  /** Report a send that came back AMBIGUOUS after the wallet or node answered (a "wallet-answer"), before the settle wait. */
  const answered = (
    o: SequenceOpts,
    r: SequenceRecord,
    parts: readonly number[],
    mode: "batch" | "sequential",
    sent: { status: string; reason?: Reason },
  ): void => {
    const why = walletAnswer(sent);
    if (!o.onProgress || !why) return;
    tell(o, () => snapshot(r, { mode, reason: why }, "SUBMISSION_POSSIBLE"), {
      kind: "wallet-answer",
      parts,
      reason: why,
    });
  };

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

  /**
   * The remaining parts in send order, grouped: a group of two or more goes out as one atomic EIP-5792 request, a
   * group of one by itself. Batches only for an atomic wallet, and only parts whose summed gas fits one
   * transaction (packBatches), at most the save's batchMax.
   */
  const groupsFor = async (
    r: SequenceRecord,
    remaining: readonly number[],
    o: SequenceOpts,
  ): Promise<number[][]> => {
    const one = remaining.map((i) => [i]);
    const a = d.authorizer;
    if (
      a.kind !== "eip1193" ||
      (o.batch ?? "auto") !== "auto" ||
      remaining.length < 2 ||
      r.batchMax === 1
    )
      return one;
    const g = gasPlanFor(efs.deployment);
    if (!g.ok) return one; // no gas model for this chain: nothing to judge a batch's size by
    if (!(await atomicBatchSupport(a.provider, d.account, efs.deployment.chainId))) return one;
    return packBatches(
      remaining.map((i) => r.parts[i] as SequencePart),
      g,
      r.batchMax,
    ).map((b) => b.map((k) => remaining[k] as number));
  };

  /**
   * The wallet approvals a save's parts take, counted as a review counts them (FolderReviewBase.prompts): one per part,
   * or with a wallet that runs calls atomically the batches the parts pack into (packBatches, the planners' gas setup).
   */
  const approvalsOf = async (parts: readonly SequencePart[], o: SequenceOpts): Promise<number> => {
    const a = d.authorizer;
    if (a.kind !== "eip1193" || (o.batch ?? "auto") !== "auto") return parts.length;
    const g = gasPlanFor(efs.deployment);
    if (!g.ok || !(await atomicBatchSupport(a.provider, d.account, efs.deployment.chainId)))
      return parts.length;
    return packBatches(parts, g).length;
  };

  /** Send what is left: gas-packed atomic EIP-5792 batches when the wallet runs calls atomically, else part by part. */
  const advance = async (
    r0: SequenceRecord,
    o: SequenceOpts,
    call: { sent: boolean },
  ): Promise<SequenceProgress> => {
    const settleMs = o.settleMs ?? 60_000;
    const sendJournal = watchWriteAhead(journal, () => {
      call.sent = true;
    });
    // The parts sent are the parts this save recorded (a journal altered or written by another version is refused).
    if (r0.partsHash !== undefined && partsHashOf(r0.parts) !== r0.partsHash)
      throw new EfsFault(
        "RECORD_DAMAGED",
        "this save's parts in the journal are not the parts it recorded (altered, or written by another version): nothing was sent",
        { details: { sequenceId: r0.sequenceId } },
      );
    let r = await reconcileParts(r0, o, 0);
    committedSince(o, r0, r);
    const a = d.authorizer;
    // A part in flight because its send was refused for funds goes again as the same plan (the person's click: only
    // resume reaches here with an attempt already made), through sendPlan's lock, twin guard and estimate; if the
    // original landed meanwhile, the estimate fails, nothing is sent, and reconcile finds it committed. Every other
    // part in flight waits for reconcile.
    if (r.state === "IN_FLIGHT") {
      for (let i = 0; i < r.parts.length; i++) {
        const part = r.parts[i] as SequencePart;
        if (part.committed || !part.planId) continue;
        const attempt = await journal.get(part.planId);
        if (!attempt || !fundsResendable(attempt)) continue;
        // The stored plan goes again only if it is this part's publication, the plan this part recorded (its deadline)
        // with this part's effects; sendPlan then re-derives its calldata.
        if (
          actionsHash(attempt.plan.actions) !== actionsHash(part.actions) ||
          attempt.plan.bodies.map(lower).join(",") !== part.bodies.map(lower).join(",") ||
          (part.deadline !== undefined && attempt.plan.deadline !== part.deadline) ||
          toJson(attempt.plan.effects) !== toJson(part.effects) ||
          !sameGuard(attempt.plan.guard, part.guard)
        )
          throw new EfsFault(
            "RECORD_DAMAGED",
            `the plan stored for part ${i + 1} is not that part's publication: nothing was sent`,
            { details: { sequenceId: r.sequenceId, planId: part.planId } },
          );
        r = await save(r, `sending part ${i + 1} of ${r.parts.length} again after a funds refusal`);
        const sent = await sendPlan(
          efs,
          sendJournal,
          a,
          attempt.plan,
          asking(o, r, [i], "sequential"),
        );
        answered(o, r, [i], "sequential", sent);
        if (sent.status === "SUBMITTED") await waitForReceipt(efs, sent.txHash, o, settleMs);
        const sentAt = r;
        // Wait the settle window only for a send this call may have made. ALREADY_ATTEMPTED (too close to the
        // deadline to send again) and NOT_SENT asked no wallet: settle at once, the original still undecided. Every
        // other AMBIGUOUS from sendPlan comes after its write-ahead (JOURNAL_UNAVAILABLE before it is NOT_SENT).
        const mayHaveSent =
          sent.status === "SUBMITTED" ||
          (sent.status === "AMBIGUOUS" && sent.reason.code !== "ALREADY_ATTEMPTED");
        r = await reconcileParts(r, o, mayHaveSent ? settleMs : 0);
        committedSince(o, sentAt, r, "sequential");
        // Not committed and not settled by a landed original: stop here, saying why (refused again, or not decided).
        if (!(r.parts[i] as SequencePart).committed && sent.status !== "STALE")
          return progress(r, {
            mode: "sequential",
            ...(sent.status === "AMBIGUOUS" || sent.status === "NOT_SENT"
              ? { reason: sent.reason }
              : sent.status === "BUSY"
                ? {
                    reason: reason(
                      "BUSY",
                      "transient",
                      "another submission for this account is in progress",
                    ),
                  }
                : {}),
          });
      }
    }
    if (r.state === "IN_FLIGHT" || r.state === "COMPLETE" || r.state === "ABANDONED")
      return progress(r);
    let mode: "batch" | "sequential" | undefined;

    /** One atomic request for `g`. `again`: nothing went out and a smaller batch (or part by part) can go now. */
    const sendBatch = async (
      g: readonly number[],
    ): Promise<{ done: boolean; reason?: Reason; again?: boolean }> => {
      if (a.kind !== "eip1193") throw new EfsFault("INVARIANT", "a batch needs an EIP-1193 wallet");
      const planned = await d.planSequence(
        g.map((i) => partInput(r.parts[i] as SequencePart)),
        o,
      );
      if (planned.status !== "PLANNED") return { done: false, reason: planned.reason };
      const parts = r.parts.map((p) => ({ ...p }));
      g.forEach((i, k) => {
        (parts[i] as SequencePart).planId = (planned.plans[k] as Plan).id;
        (parts[i] as SequencePart).deadline = (planned.plans[k] as Plan).deadline;
        delete (parts[i] as SequencePart).checkedAt;
        delete (parts[i] as SequencePart).reorged; // sent again: a new attempt, not the reorged one
        delete (parts[i] as SequencePart).expired;
      });
      r = await save(
        { ...r, parts },
        g.length === r.parts.length
          ? "sending the remaining parts as one wallet request"
          : `sending parts ${(g[0] as number) + 1}–${(g[g.length - 1] as number) + 1} of ${r.parts.length} as one wallet request`,
      );
      const sent = await sendPlansAsBatch(
        efs,
        sendJournal,
        a.provider,
        planned.plans,
        asking(o, r, g, "batch"),
      );
      answered(o, r, g, "batch", sent);
      const status =
        sent.status === "SUBMITTED"
          ? await waitForBatch(a.provider, sent.batchId, { timeoutMs: settleMs })
          : undefined;
      const sentAt = r;
      r = await reconcileParts(
        r,
        o,
        sent.status === "SUBMITTED" || sent.status === "AMBIGUOUS" ? settleMs : 0,
      );
      committedSince(o, sentAt, r, "batch");
      const done = g.every((i) => (r.parts[i] as SequencePart).committed);
      const limit = done ? undefined : smallerBatch(g.length, sent, status);
      if (limit !== undefined && limit < (r.batchMax ?? Number.POSITIVE_INFINITY))
        r = await save(
          { ...r, batchMax: limit },
          sent.status === "NOT_SENT" && sent.reason.code === "OVER_TX_GAS_CAP"
            ? `part ${(g[0] as number) + 1} alone is over the per-transaction cap: part by part from here on`
            : limit === 1
              ? "the wallet's batch failed: part by part from here on"
              : `the wallet's batch failed: at most ${limit} parts per request from here on`,
        );
      if (done) return { done };
      const why =
        sent.status === "NOT_SENT" || sent.status === "AMBIGUOUS"
          ? sent.reason
          : sent.status === "STALE"
            ? staleReason(sent)
            : sent.status === "BUSY"
              ? reason("BUSY", "transient", "another submission for this account is in progress")
              : undefined;
      // Refused before anything went out for a reason its size or the wallet explains (not the person): go on.
      const again = sent.status === "NOT_SENT" && limit !== undefined && sent.walletCode !== 5750;
      return { done, ...(why ? { reason: why } : {}), ...(again ? { again } : {}) };
    };

    /**
     * Part `i` was refused as over the per-transaction cap, before anything was sent (NOT_SENT OVER_TX_GAS_CAP): its
     * statements hit lists longer than the planner could see. Cut it between its units and go on, when it has units,
     * no attempt of its plan reached a wallet, and the depth bound allows; else stop, a single unit as "never".
     */
    const overCap = async (
      i: number,
      planId: Hex,
      why: Reason,
    ): Promise<{ done: boolean; reason?: Reason; again?: boolean; resplit?: boolean }> => {
      const attempt = await journal.get(planId);
      const part = r.parts[i] as SequencePart;
      const reached =
        attempt !== undefined && attempt.stage !== "PLANNED" && attempt.stage !== "NOT_SENT";
      const depth = part.splitDepth ?? 0;
      const pieces =
        reached || depth >= MAX_SPLIT_DEPTH ? null : resplit(part, why.gas?.suggestedParts ?? 2);
      if (!pieces) {
        // Not cut: settle the part as any refused send is (a plan that never went out is dropped, so the save is
        // NOT_STARTED or PARTIAL; one that may have reached a wallet stays in flight).
        r = await reconcileParts(r, o, 0);
        const single = validUnits(part) && (part.units as readonly PartUnit[]).length === 1;
        return {
          done: false,
          reason: single
            ? {
                ...why,
                retry: "never",
                detail: `${why.detail ?? "over the per-transaction cap"} (it is one unit, a single statement or entry: it can't be split further)`,
              }
            : why,
        };
      }
      // Each piece's share of the part's measured gas (by actions), so a batch can still be packed with it: the pieces
      // of one part never fit one batch together (their sum is over the cap), but a piece and a neighbour may.
      const estimate = why.gas ? Number(why.gas.estimate) : undefined;
      const share = (n: number, of: number | undefined) =>
        of === undefined ? undefined : Math.ceil((of * n) / part.actions.length);
      const scale = estimate !== undefined && part.gas ? estimate / part.gas : undefined;
      // A guarded piece pays the guard's fixed term once more on its own (the part's estimate holds it once): added
      // to each guarded piece's share, the safe side.
      const plan = gasPlanFor(efs.deployment);
      const fixedOf = (p: SequencePart, all: boolean) =>
        p.guard?.length && plan.ok
          ? ((all ? (plan.model.total ?? plan.model) : plan.model).guard?.guardFixed ?? 0)
          : 0;
      const sized = pieces.map((p) => {
        const g = share(p.actions.length, estimate);
        const gas = g === undefined ? undefined : g + fixedOf(p, false);
        const t =
          part.total !== undefined && scale !== undefined
            ? share(p.actions.length, part.total * scale)
            : undefined;
        const total = t === undefined ? undefined : t + fixedOf(p, true);
        return {
          ...p,
          ...(gas !== undefined ? { gas } : {}),
          ...(total !== undefined ? { total } : {}),
        };
      });
      const parts = renumber([...r.parts.slice(0, i), ...sized, ...r.parts.slice(i + 1)]);
      const before = await approvalsOf(r.parts, o);
      r = await save(
        { ...r, parts, partsHash: partsHashOf(parts) },
        `part ${i + 1} was too large for one transaction: split into ${pieces.length}`,
      );
      const now = await approvalsOf(r.parts, o);
      // More approvals than the review said: the person is told before any of them is asked.
      if (now > before && (o.resplit ?? "ask") === "ask")
        return {
          done: false,
          reason: {
            ...reason(
              "RESPLIT",
              "after-review",
              `part ${i + 1} was too large for one transaction and is now ${pieces.length}: the save needs ${now} approvals (it was ${before}); nothing more was sent`,
            ),
            prompts: { before, now },
          },
        };
      return { done: false, again: true, resplit: true };
    };

    /** Part `i` by itself: planned just in time, sent, and waited for. */
    const sendOne = async (
      i: number,
    ): Promise<{ done: boolean; reason?: Reason; again?: boolean; resplit?: boolean }> => {
      const part = r.parts[i] as SequencePart;
      const planned = await d.plan(partInput(part), o);
      if (planned.status !== "PLANNED") return { done: false, reason: planned.reason };
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
      if (sent.status === "NOT_SENT" && sent.reason.code === "OVER_TX_GAS_CAP")
        return overCap(i, planned.plan.id, sent.reason);
      answered(o, r, [i], "sequential", sent);
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
      if ((r.parts[i] as SequencePart).committed) return { done: true };
      const why =
        sent.status === "NOT_SENT" || sent.status === "AMBIGUOUS"
          ? sent.reason
          : sent.status === "STALE"
            ? staleReason(sent)
            : sent.status === "BUSY"
              ? reason("BUSY", "transient", "another submission for this account is in progress")
              : reason("NOT_YET_DECIDABLE", "after-reconcile", `part ${i + 1} is not decided yet`);
      return { done: false, reason: why };
    };

    // batchMax only falls, and at 1 nothing is batched: that re-groups a few times at most. A re-split adds pieces
    // that are re-split at most MAX_SPLIT_DEPTH levels, so it has its own, larger bound.
    for (let replans = 0, splits = 0; ; ) {
      const remaining = r.parts.flatMap((p, i) => (p.committed ? [] : [i]));
      let again = false;
      for (const g of await groupsFor(r, remaining, o)) {
        mode = g.length > 1 ? "batch" : "sequential";
        const out: { done: boolean; reason?: Reason; again?: boolean; resplit?: boolean } =
          g.length > 1 ? await sendBatch(g) : await sendOne(g[0] as number);
        if (out.done) continue;
        if (out.again && (out.resplit ? splits++ < 512 : replans++ < 32)) {
          again = true;
          break;
        }
        return progress(r, { mode, ...(out.reason ? { reason: out.reason } : {}) });
      }
      if (!again) break;
    }
    return progress(r, mode ? { mode } : {});
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
            ...(p.gas !== undefined ? { gas: p.gas } : {}),
            ...(p.total !== undefined ? { total: p.total } : {}),
            ...(validUnits(p) ? { units: p.units } : {}),
            ...(p.guard?.length ? { guard: p.guard } : {}),
          })),
          state: "NOT_STARTED",
          history: [{ state: "NOT_STARTED", at: Date.now() }],
        };
        r.partsHash = partsHashOf(r.parts);
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

/**
 * The batch size a failed atomic request of `k` parts leaves for the rest of the save, or undefined to keep it: a
 * wallet that refused the batch as too large (5740) or answered an error it gave no reason for, or reported the
 * batch failed (status 400 or above), halves it; a wallet that can't batch (or whose person declined the account
 * upgrade, 5750) goes part by part. The person's refusal (4001), a locked wallet and a lost connection keep it.
 */
function smallerBatch(
  k: number,
  sent: BatchSendResult,
  status: number | undefined,
): number | undefined {
  const half = Math.max(1, Math.floor(k / 2));
  if (sent.status === "NOT_SENT") {
    // The first part alone is over the per-transaction cap: part by part, where it can be re-split.
    if (sent.reason.code === "OVER_TX_GAS_CAP") return 1;
    if (sent.walletCode === 5740) return half;
    if ([4200, 5700, 5710, 5750, 5760, -32602].includes(sent.walletCode ?? 0)) return 1;
    return undefined;
  }
  if (sent.status === "AMBIGUOUS") return sent.reason.code === "RESPONSE_LOST" ? half : undefined;
  if (sent.status === "SUBMITTED" && status !== undefined && status >= 400) return half;
  return undefined;
}

/** How many times a planned part may be re-split, at most (each level at least doubles its pieces). */
export const MAX_SPLIT_DEPTH = 6;

/** Units that describe a part exactly: whole runs, at least one action each, covering every action in order. */
function validUnits(p: { actions: readonly unknown[]; units?: readonly PartUnit[] }): boolean {
  const u = p.units;
  if (!u || u.length === 0) return false;
  let n = 0;
  for (const x of u) {
    if (!Number.isSafeInteger(x.actions) || x.actions < 1 || typeof x.effect !== "object")
      return false;
    n += x.actions;
  }
  return n === p.actions.length;
}

/**
 * @internal A part too large for one transaction, cut into at most `pieces` parts of near-equal unit counts, in
 * order, only between units (never inside a folder entry's actions or between a statement and its registration).
 * Each piece carries its units' effects (a registration-only effect only when it carries nothing else) and no gas
 * figures (they are not known per piece). Null when the part can't be cut: no valid units, or a single unit.
 */
export function resplit(part: SequencePart, pieces: number): SequencePart[] | null {
  if (!validUnits(part)) return null;
  const units = part.units as readonly PartUnit[];
  const k = Math.min(Math.max(2, Math.floor(pieces)), units.length);
  if (k < 2) return null;
  const out: SequencePart[] = [];
  let unit = 0;
  let action = 0;
  for (let i = 0; i < k; i++) {
    const take = Math.floor((units.length * (i + 1)) / k) - Math.floor((units.length * i) / k);
    const mine = units.slice(unit, unit + take);
    const n = mine.reduce((t, u) => t + u.actions, 0);
    const effects = mine.map((u) => u.effect);
    const kept = effects.filter((e) => e.args["stage"] !== "register");
    // the piece's own guard: exactly the heads of its own actions, re-indexed to the piece (never the parent's)
    const from = action;
    const guard = (part.guard ?? [])
      .filter((h) => h.action >= from && h.action < from + n)
      .map((h) => ({ ...h, action: h.action - from }));
    out.push({
      actions: part.actions.slice(action, action + n),
      bodies: part.bodies.slice(action, action + n),
      effects: kept.length ? kept : effects.slice(0, 1),
      units: mine,
      ...(part.deadlineSeconds !== undefined ? { deadlineSeconds: part.deadlineSeconds } : {}),
      ...(guard.length ? { guard } : {}),
      splitDepth: (part.splitDepth ?? 0) + 1,
    });
    unit += take;
    action += n;
  }
  return out;
}

/** Every effect's `part` / `parts` arguments (where it has them) set to its part's place in `parts`. */
function renumber(parts: readonly SequencePart[]): SequencePart[] {
  const total = String(parts.length);
  const fix = (e: EffectView, i: number): EffectView =>
    e.args["part"] !== undefined && e.args["parts"] !== undefined
      ? { ...e, args: { ...e.args, part: String(i + 1), parts: total } }
      : e;
  return parts.map((p, i) => ({
    ...p,
    effects: p.effects.map((e) => fix(e, i)),
    ...(p.units ? { units: p.units.map((u) => ({ ...u, effect: fix(u.effect, i) })) } : {}),
  }));
}

const partInput = (p: SequencePart): SequencePartInput => ({
  actions: p.actions,
  bodies: p.bodies,
  effects: p.effects,
  ...(p.units ? { units: p.units } : {}),
  ...(p.deadlineSeconds !== undefined ? { deadlineSeconds: p.deadlineSeconds } : {}),
  ...(p.gas !== undefined ? { gas: p.gas } : {}),
  ...(p.total !== undefined ? { total: p.total } : {}),
  ...(p.guard?.length ? { guard: p.guard } : {}),
});

/**
 * Whether a stored plan's guard bytes are the ones this part's heads encode (a funds resend signs the stored plan, so
 * its guard must be this part's, byte for byte). A part whose heads form no grid has no such plan.
 */
function sameGuard(planned: Hex | undefined, heads: SequencePart["guard"]): boolean {
  try {
    return lower(planned ?? EMPTY_GUARD) === lower(encodeGuard(heads ?? []));
  } catch {
    return false;
  }
}

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
      if (!r?.lock.startsWith(prefix))
        throw new EfsFault(
          "MISUSE",
          `no sequence ${sequenceId} for this deployment in this journal`,
        );
      return core.progress(await core.reconcileParts(r, o, 0));
    },
  };
}
