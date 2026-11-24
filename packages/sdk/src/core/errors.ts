// SPDX-License-Identifier: MIT
/** Why something is unknown, unsupported or failed. Plain data. */
export interface Reason {
  code: ReasonCode;
  retry: "never" | "transient" | "after-reconcile" | "after-replan";
  detail?: string;
}
export type ReasonCode =
  | "RPC_UNAVAILABLE"
  | "RPC_ERROR"
  | "CHAIN_MISMATCH"
  | "BASIS_STALE"
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
  constructor(
    code: FaultCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options?.details;
  }
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
}

/** Throw the caller's own abort reason (an AbortError) if the signal has fired. */
export function throwIfAborted(signal: AbortSignalLike | undefined): void {
  if (signal?.aborted) {
    throw new EfsFault("ABORTED", "aborted by the caller", { cause: signal.reason });
  }
}
