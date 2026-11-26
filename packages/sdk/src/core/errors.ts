// SPDX-License-Identifier: MIT
import type { Address, Hex } from "./hex.js";

/**
 * Why something is unknown, unsupported or failed. Plain data. Branch on `code`, `retry` and the structured fields,
 * never on `detail` (free text for logs and support, not a contract).
 *
 * `retry` says what can move it forward: "transient" (try the same thing again, e.g. Continue), "after-reconcile"
 * (settle from the ledger first, then try again), "after-replan" (this plan cannot proceed as it stands: plan
 * again from fresh state), "never".
 */
export interface Reason {
  code: ReasonCode;
  retry: "never" | "transient" | "after-reconcile" | "after-replan";
  detail?: string;
  /** Set when the ledger refused the call (a simulated revert): which error, as far as the vendored tables know it. */
  revert?: RevertInfo;
  /**
   * Set on BEHIND: the lowest block the read may be served at (the highest this client has already read, or the
   * caller's `atLeast`), and the head each endpoint offered instead.
   */
  floor?: { blockNumber: bigint; blockHash?: Hex };
  served?: readonly { endpoint: string; blockNumber: bigint }[];
  /**
   * Set when the deployment document's fee schedule does not match the chain (UNSUPPORTED_PROFILE): the document's
   * schedule, the one the chain's storage pricing matches (null: none this SDK knows), and the measured price of a
   * fresh storage slot.
   */
  feeSchedule?: { document: string; chain: string | null; freshSlotGas: bigint };
  /** Set on WALLET_MISMATCH: the chain and account the plan needs, and what the wallet is on now. */
  wallet?: WalletMismatch;
  /**
   * Set on ALREADY_ATTEMPTED for a held-back repeat: the earlier attempt of the same publication that is still open,
   * and its save when the journal knows it. Settle that one (reconcileSequence(sequenceId), or reconcile(planId)).
   */
  twin?: {
    planId: Hex;
    stage: "SUBMISSION_POSSIBLE" | "SUBMITTED" | "COMMITTED";
    sequenceId?: Hex;
  };
}

/** A contract revert, decoded only as far as the vendored contracts tables allow. Nothing here is guessed. */
export interface RevertInfo {
  /** The 4-byte error selector. */
  selector: Hex;
  /** The error's name from the vendored errors table (e.g. "E_CAS"); absent when the selector is not in it. */
  error?: string;
  /**
   * The error's arguments, present only when they decode cleanly against the vendored ABI. uints are bigint: plain
   * JSON.stringify throws on them, so serialize reasons with `toJson`.
   */
  args?: readonly unknown[];
}

/** The wallet moved off the plan's chain or account. Nothing was sent; switch back and send again. */
export interface WalletMismatch {
  expected: { chainId: number; account: Address };
  /**
   * `account` is the plan's account when the wallet still offers it (only the chain is wrong), else the wallet's first
   * connected account, or null when it offers none.
   */
  actual: { chainId: number; account: Address | null };
}

export type ReasonCode =
  | "RPC_UNAVAILABLE"
  | "RPC_ERROR"
  | "CHAIN_MISMATCH"
  | "BASIS_STALE"
  /** An admission was undone by a reorg; in a save, the part is in flight again and may be re-included. Wait. */
  | "REORGED"
  | "LIMIT_EXCEEDED"
  | "NOT_VERIFIED_DEPLOYMENT"
  | "UNSUPPORTED_PROFILE"
  | "GATEWAY_UNAVAILABLE"
  | "DIGEST_MISMATCH"
  | "POLICY_BLOCKED"
  | "INVALID_RESUME_TOKEN"
  | "TOO_LARGE"
  | "JOURNAL_UNAVAILABLE"
  | "OVER_TX_GAS_CAP"
  /** The ledger refuses the plan as it stands (see `revert`); plan again from fresh state. */
  | "STALE"
  /** The wallet is on another chain or account than the plan (see `wallet`). Nothing was sent. */
  | "WALLET_MISMATCH"
  /** A part undone by a reorg is now proven not committed. Sending it again (resume) is the person's choice. */
  | "REORGED_DROPPED"
  | "USER_REJECTED"
  /** NOT_SENT: the wallet refused before signing (EIP-1193 4100, 4200; JSON-RPC -32602). */
  | "WALLET_UNAUTHORIZED"
  | "WALLET_UNSUPPORTED"
  | "WALLET_INVALID_PARAMS"
  /** AMBIGUOUS: the wallet lost its connection (4900, 4901), possibly after relaying. Reconcile decides. */
  | "WALLET_DISCONNECTED"
  | "WALLET_CHAIN_DISCONNECTED"
  /** A part that was sent was never committed and is proven so past its deadline. Sending again is the person's call. */
  | "EXPIRED"
  | "BUSY"
  | "NOT_YET_DECIDABLE"
  /**
   * Every endpoint offered a block older than one this client has already read (or than the read's `atLeast`), and
   * none caught up within the short wait: UNKNOWN rather than an older read. Retry; see `floor` and `served`.
   */
  | "BEHIND"
  | (string & Record<never, never>);

export function reason(code: ReasonCode, retry: Reason["retry"], detail?: string): Reason {
  return detail === undefined ? { code, retry } : { code, retry, detail };
}

export type FaultCode =
  | "MISUSE"
  | "ABORTED"
  | "LIMIT"
  | "INVARIANT"
  | "JOURNAL_UNAVAILABLE"
  | "STREAM_FAILED"
  | (string & Record<never, never>);

/**
 * The only thing the SDK throws: caller misuse, the caller's own abort, a bad caller-supplied limit, an attempt
 * journal that cannot be read or written, a byte stream that cannot continue (STREAM_FAILED: a stream has no other
 * way to report), or an internal invariant failure. Expected uncertainty (UNKNOWN, PARTIAL, unavailable bytes, wallet refusals) is
 * always returned as data instead.
 */
export class EfsFault extends Error {
  override readonly name: "EfsFault" = "EfsFault";
  readonly code: FaultCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  /**
   * Set on every fault thrown out of runSequence and resume (see SequenceFault): the save's id, whether this call may
   * have broadcast, and whether any part of the save may be on chain. Undefined on every other fault.
   */
  readonly sequenceId: Hex | undefined;
  readonly mayHaveSent: boolean | undefined;
  readonly sequenceMayHaveSent: boolean | undefined;
  constructor(
    code: FaultCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown; sequence?: SequenceFault },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options?.details;
    this.sequenceId = options?.sequence?.sequenceId;
    this.mayHaveSent = options?.sequence?.mayHaveSent;
    this.sequenceMayHaveSent = options?.sequence?.sequenceMayHaveSent;
  }
}

/**
 * Where a save stood when runSequence or resume threw, set as plain properties on the EfsFault. A throw is never
 * "nothing was saved" by itself: read these, and when either flag is true, reconcile the save by `sequenceId` once the
 * cause is fixed (e.g. on the next start).
 */
export interface SequenceFault {
  /** The save's id once its record exists (always for resume). */
  sequenceId?: Hex;
  /** This call may have broadcast something: it wrote a part's write-ahead record before the throw. */
  mayHaveSent: boolean;
  /**
   * Some part of this save may be on chain, from this call or an earlier one (a part committed, or sent and not
   * yet decided). True when the save's record could not be read.
   */
  sequenceMayHaveSent: boolean;
}

export function misuse(message: string, details?: Record<string, unknown>): EfsFault {
  return new EfsFault("MISUSE", message, details ? { details } : undefined);
}

/** Minimal structural AbortSignal: the DOM and Node signals both satisfy it. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface CallOpts {
  signal?: AbortSignalLike;
  /**
   * Read at this block or a later one: for a block this client can't know about (another tab, a worker, a link that
   * carries a basis, a save's `visibleAt`). Below it the read fails over, waits briefly, then is UNKNOWN BEHIND. With
   * `blockHash`, a basis whose canonical block at that height is another says so in `basis.reorgedSince`.
   */
  atLeast?: { blockNumber: bigint; blockHash?: Hex };
}

/** Throw the caller's own abort reason (an AbortError) if the signal has fired. */
export function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted) {
    throw new EfsFault("ABORTED", "aborted by the caller", { cause: signal.reason });
  }
}
