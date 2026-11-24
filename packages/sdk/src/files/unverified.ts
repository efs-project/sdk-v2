// SPDX-License-Identifier: MIT
// The explicit opt-in for playing a single-digest (external) file while it downloads: bytes are emitted as they
// arrive, BEFORE they can be verified, and `result` settles with the real grade once the whole body has been read.
//
//   - Ledger layouts (inline, chunk, span) are verified per chunk anyway: this behaves as fileChunks and settles
//     VERIFIED.
//   - External: candidate locations are tried in order. Fail-over happens only BEFORE the first byte is emitted;
//     once bytes are out, a bad digest or length is a final MISMATCH, never a silent switch to another gateway.
//   - A final MISMATCH both settles `result` and errors the stream (EfsFault STREAM_FAILED), so a consumer piping to
//     disk sees the failure instead of keeping bad bytes.
//   - Whole files only. A range of a file cannot be verified against a whole-file sha256. Verified seeking over IPFS
//     is per-block verification against the CID (trustless-gateway raw blocks or a CAR), not unverified range reads.
//   - Nothing is buffered, so maxBytes does not apply; the caller's signal and return()/cancel() abort the download.
//     Timeouts: `gateways.timeoutMs` to the response headers, and the same again as an idle limit between chunks.
import { sha256 as sha256Hasher } from "@noble/hashes/sha2";
import type { FetchLike } from "../chain/rpc.js";
import type { Efs } from "../client.js";
import { planLocator } from "../content/locator.js";
import {
  type AbortSignalLike,
  type CallOpts,
  EfsFault,
  type Reason,
  reason,
  throwIfAborted,
} from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import { clearTimer, setTimer } from "../core/platform.js";
import {
  type ByteGrade,
  type FetchResponse,
  gatewayPolicyOf,
  getChecked,
  type Location,
  type LocationAttempt,
  type OpenedFile,
  originLabel,
} from "./bytes.js";
import { fileChunks, type StreamFailure } from "./stream.js";

export interface UnverifiedOpts extends CallOpts {
  /** Ledger layouts only: bytes fetched per pull (see StreamOpts.windowBytes). */
  windowBytes?: number;
}

export interface UnverifiedResult {
  /** VERIFIED or MISMATCH once the whole body was read; otherwise the grade that stopped it. */
  grade: ByteGrade;
  reason?: Reason;
  /** Bytes emitted (all of them unverified until `grade` says VERIFIED). */
  emitted: bigint;
  location?: Location;
  attempts: readonly LocationAttempt[];
}

/** Chunks emitted before they are verified. `result` never rejects. */
export interface UnverifiedChunks extends AsyncIterableIterator<Uint8Array> {
  readonly result: Promise<UnverifiedResult>;
  return(): Promise<IteratorResult<Uint8Array, undefined>>;
}

interface ControllerLike {
  signal: AbortSignalLike;
  abort(reason?: unknown): void;
}
type BodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};
const toHex = (bytes: Uint8Array): Hex => {
  let h = "0x";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h as Hex;
};

/** Stream a whole file, emitting external bytes before they can be verified. Read `result` for the grade. */
export function unverifiedChunks(
  efs: Efs,
  file: OpenedFile,
  o: UnverifiedOpts = {},
): UnverifiedChunks {
  let settle = (_r: UnverifiedResult): void => {};
  const result = new Promise<UnverifiedResult>((r) => {
    settle = r;
  });
  let settled = false;
  const finish = (r: UnverifiedResult): void => {
    if (settled) return;
    settled = true;
    settle(r);
  };

  if (file.layout !== "external") {
    // Verified per chunk already: delegate, and translate its outcome into `result`.
    const inner = fileChunks(efs, file, o);
    let emitted = 0n;
    const it: UnverifiedChunks = {
      result,
      async next() {
        try {
          const r = await inner.next();
          if (r.done)
            finish({ grade: "VERIFIED", emitted, location: { scheme: "ledger" }, attempts: [] });
          else emitted += BigInt(r.value.length);
          return r;
        } catch (e) {
          const f =
            e instanceof EfsFault && e.code === "STREAM_FAILED"
              ? (e.details as unknown as StreamFailure)
              : undefined;
          finish({
            grade: f?.grade ?? "UNKNOWN",
            ...(f?.reason ? { reason: f.reason } : {}),
            emitted,
            attempts: [],
          });
          throw e;
        }
      },
      async return() {
        await inner.return();
        finish({
          grade: "UNKNOWN",
          reason: reason("CANCELLED", "never", "cancelled"),
          emitted,
          attempts: [],
        });
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return it;
      },
    };
    return it;
  }

  const Ctl = (globalThis as { AbortController?: new () => ControllerLike }).AbortController;
  const ctl = Ctl ? new Ctl() : undefined;
  const forward = (): void => ctl?.abort(o.signal?.reason);
  o.signal?.addEventListener("abort", forward, { once: true });
  const signal = ctl?.signal ?? o.signal;
  const timeoutMs = efs.gateways.timeoutMs ?? 10_000;
  const fetchImpl = efs._internal.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  const attempts: LocationAttempt[] = [];
  let emitted = 0n;
  let done = false;

  const stop = (grade: ByteGrade, why: Reason | undefined, location?: Location): never => {
    finish({
      grade,
      ...(why ? { reason: why } : {}),
      emitted,
      ...(location ? { location } : {}),
      attempts,
    });
    throw new EfsFault("STREAM_FAILED", `stream stopped after ${emitted} bytes: ${grade}`, {
      details: { grade, ...(why ? { reason: why } : {}), emitted } satisfies StreamFailure,
    });
  };

  /** Race a promise against a fresh timer of `timeoutMs`. */
  const timed = async <T>(p: Promise<T>): Promise<T> => {
    let timer: unknown;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimer(() => reject(new Error(`no data for ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimer(timer);
    }
  };

  async function* body(
    res: FetchResponse,
    loc: Location,
    origin: string,
  ): AsyncGenerator<Uint8Array> {
    const hasher = sha256Hasher.create();
    let total = 0n;
    const reader = (res.body as { getReader?: () => BodyReader } | undefined)?.getReader?.();
    const parts: AsyncGenerator<Uint8Array> = reader
      ? (async function* () {
          try {
            for (;;) {
              const { done: end, value } = await timed(reader.read());
              if (end) return;
              if (value?.length) yield value;
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        })()
      : (async function* () {
          yield new Uint8Array(await timed(res.arrayBuffer()));
        })();
    try {
      for await (const part of parts) {
        throwIfAborted(o.signal);
        total += BigInt(part.length);
        if (total > file.size) {
          attempts.push({ location: origin, outcome: "MISMATCH", detail: "longer than the file" });
          return stop(
            "MISMATCH",
            reason("DIGEST_MISMATCH", "never", `the body is longer than ${file.size} bytes`),
            loc,
          );
        }
        hasher.update(part);
        yield part;
      }
    } catch (e) {
      if (e instanceof EfsFault) throw e;
      if (o.signal?.aborted)
        throw new EfsFault("ABORTED", "aborted by the caller", { cause: o.signal.reason });
      attempts.push({
        location: origin,
        outcome: "FAILED",
        detail: e instanceof Error ? e.message : "read failed",
      });
      return stop(
        "UNAVAILABLE",
        reason("GATEWAY_UNAVAILABLE", "transient", `the download broke after ${emitted} bytes`),
        loc,
      );
    }
    if (total !== file.size || toHex(hasher.digest()) !== file.sha256.toLowerCase()) {
      attempts.push({ location: origin, outcome: "MISMATCH" });
      return stop(
        "MISMATCH",
        reason("DIGEST_MISMATCH", "never", "the downloaded bytes fail the file's sha256"),
        loc,
      );
    }
    attempts.push({ location: origin, outcome: "VERIFIED" });
    finish({ grade: "VERIFIED", emitted: total, location: loc, attempts });
  }

  async function* source(): AsyncGenerator<Uint8Array> {
    const policy = gatewayPolicyOf(efs);
    let sawSupported = false;
    let lastBlocked: ByteGrade = "UNSUPPORTED_LOCATOR";
    for (const loc of file.locations) {
      if (!loc.uri) continue;
      const plan = planLocator(loc.uri, policy);
      if (!plan.ok) {
        attempts.push({ location: loc.scheme, outcome: "FAILED", detail: plan.why });
        if (plan.why === "POLICY_BLOCKED") lastBlocked = "POLICY_BLOCKED";
        continue;
      }
      sawSupported = true;
      if ("inline" in plan) {
        // A data: locator is already in hand: verify before emitting, there is nothing to stream.
        const ok =
          BigInt(plan.inline.length) === file.size &&
          toHex(sha256Hasher(plan.inline)) === file.sha256.toLowerCase();
        attempts.push({ location: "data", outcome: ok ? "VERIFIED" : "MISMATCH" });
        if (!ok) continue;
        yield plan.inline;
        finish({ grade: "VERIFIED", emitted: BigInt(plan.inline.length), location: loc, attempts });
        return;
      }
      for (const url of plan.urls) {
        throwIfAborted(o.signal);
        const origin = originLabel(url, plan.scheme);
        if (!fetchImpl) {
          attempts.push({ location: origin, outcome: "FAILED", detail: "no fetch implementation" });
          continue;
        }
        let res: FetchResponse;
        let timer: unknown;
        try {
          const headers = new Promise<never>((_, reject) => {
            timer = setTimer(() => reject(new Error("timeout")), timeoutMs);
          });
          res = await getChecked(fetchImpl, url, plan.scheme, policy, signal, headers);
        } catch (e) {
          if (o.signal?.aborted)
            throw new EfsFault("ABORTED", "aborted by the caller", { cause: o.signal.reason });
          attempts.push({
            location: origin,
            outcome: "FAILED",
            detail: e instanceof Error ? e.message : "fetch failed",
          });
          continue;
        } finally {
          clearTimer(timer);
        }
        if (!res.ok) {
          attempts.push({ location: origin, outcome: "FAILED", detail: `HTTP ${res.status}` });
          continue;
        }
        const declared = res.headers.get("content-length");
        if (declared && /^\d+$/.test(declared) && BigInt(declared) !== file.size) {
          // Caught before any byte is emitted, so failing over is still honest.
          attempts.push({
            location: origin,
            outcome: "MISMATCH",
            detail: `declares ${declared} bytes`,
          });
          continue;
        }
        yield* body(res, loc, origin); // from the first byte on, this location is final
        return;
      }
    }
    if (!sawSupported) return stop(lastBlocked, undefined);
    const anyMismatch = attempts.some((a) => a.outcome === "MISMATCH");
    return stop(
      anyMismatch ? "MISMATCH" : "UNAVAILABLE",
      reason(anyMismatch ? "DIGEST_MISMATCH" : "GATEWAY_UNAVAILABLE", "transient"),
    );
  }

  const inner = source();
  const end = (): void => {
    done = true;
    o.signal?.removeEventListener("abort", forward);
  };
  const it: UnverifiedChunks = {
    result,
    async next() {
      if (done) return { done: true, value: undefined };
      try {
        const r = await inner.next();
        if (r.done) end();
        else emitted += BigInt(r.value.length);
        return r.done ? { done: true, value: undefined } : r;
      } catch (e) {
        end();
        if (!(e instanceof EfsFault && e.code === "STREAM_FAILED"))
          finish({
            grade: "UNKNOWN",
            reason: reason("ABORTED", "never", String(e)),
            emitted,
            attempts,
          });
        throw e;
      }
    },
    async return() {
      if (!done) {
        end();
        ctl?.abort(new EfsFault("ABORTED", "stream cancelled"));
        await inner.return(undefined).catch(() => {});
        finish({
          grade: "UNKNOWN",
          reason: reason("CANCELLED", "never", "cancelled"),
          emitted,
          attempts,
        });
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return it;
}
