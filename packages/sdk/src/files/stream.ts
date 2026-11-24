// SPDX-License-Identifier: MIT
// Streaming reads: verified chunks only, pulled on demand.
//
//   inline        one chunk: the bytes the open already verified
//   chunk / span  window by window from the ledger. Each chunk record is verified against its id before any of its
//                 bytes are emitted. A full-file stream also checks the author's whole-file sha256 at the end, so a
//                 stream and readBytes() never disagree
//   external      a single sha256 covers the whole body, so it is fetched (bounded by maxBytes) and verified first,
//                 then emitted in windows. Bytes that fail are never emitted
//
// A stream that cannot continue throws EfsFault("STREAM_FAILED") with details { grade, reason, emitted }: `emitted`
// counts bytes already delivered, so a caller can resume with { offset: offset + emitted }. Cancelling (return() on
// the iterator, cancel() on a ReadableStream, or the caller's AbortSignal) aborts the in-flight requests.
import { sha256 as sha256Hasher } from "@noble/hashes/sha2";
import { onEndpoint } from "../chain/pool.js";
import type { Efs } from "../client.js";
import {
  type AbortSignalLike,
  type CallOpts,
  EfsFault,
  type Reason,
  reason,
  throwIfAborted,
} from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import {
  type ByteGrade,
  type Ctx,
  fetchExternal,
  gatewayPolicyOf,
  type OpenedFile,
  spanRange,
} from "./bytes.js";

export interface StreamOpts extends CallOpts {
  /** First byte to emit (default 0). */
  offset?: bigint;
  /** Bytes to emit (default: to the end of the file). */
  length?: bigint;
  /** Ledger bytes fetched per pull, rounded up to whole 8,160-byte chunks (default 16 chunks, 130,560 bytes). */
  windowBytes?: number;
  /** External files are buffered to be verified: refuse ones larger than this (default 50 MiB, or the client's). */
  maxBytes?: bigint;
  /** Exact origins to allow for this call only (see BytesOpts.allowOrigins). */
  allowOrigins?: readonly string[];
}

export interface StreamFailure {
  grade: ByteGrade;
  reason?: Reason;
  /** Bytes already emitted before the failure. */
  emitted: bigint;
  /** Locations the gateway policy blocked (see ByteRangeResult.blockedOrigins). */
  blockedOrigins?: readonly string[];
}

/** Verified chunks of a file. `return()` cancels and aborts any request in flight. */
export interface FileChunks extends AsyncIterableIterator<Uint8Array> {
  return(): Promise<IteratorResult<Uint8Array, undefined>>;
}

const CHUNK = 8160;

interface ControllerLike {
  signal: AbortSignalLike;
  abort(reason?: unknown): void;
}
const newController = (): ControllerLike | undefined => {
  const Ctl = (globalThis as { AbortController?: new () => ControllerLike }).AbortController;
  return Ctl ? new Ctl() : undefined;
};

const toHex = (bytes: Uint8Array): Hex => {
  let h = "0x";
  for (const b of bytes) h += b.toString(16).padStart(2, "0");
  return h as Hex;
};

/**
 * Verified chunks of an opened file, pulled on demand. Works in every runtime. Browser code usually wants
 * `streamFile` from `@efs/sdk/web`, which wraps this as a ReadableStream.
 */
export function fileChunks(efs: Efs, file: OpenedFile, o: StreamOpts = {}): FileChunks {
  const offset = o.offset ?? 0n;
  if (offset < 0n || (o.length !== undefined && o.length < 0n))
    throw new EfsFault("MISUSE", "offset and length must be non-negative");
  const end =
    o.length === undefined || offset + o.length > file.size ? file.size : offset + o.length;
  const total = end > offset ? end - offset : 0n;
  const windowBytes = BigInt(Math.max(1, Math.ceil((o.windowBytes ?? 16 * CHUNK) / CHUNK)) * CHUNK);
  const whole = offset === 0n && total === file.size;
  // Validated now, so a bad allowOrigins entry is MISUSE at the call, not at the first pull.
  if (file.layout === "external") gatewayPolicyOf(efs, o.allowOrigins);

  // Our own controller: cancelling aborts in-flight requests; the caller's signal aborts it too.
  const ctl = newController();
  const forward = (): void => ctl?.abort(o.signal?.reason);
  o.signal?.addEventListener("abort", forward, { once: true });
  const signal = ctl?.signal ?? o.signal;
  const call: CallOpts = signal ? { signal } : {};
  let emitted = 0n;
  let done = false;

  const fail = (grade: ByteGrade, why?: Reason, blockedOrigins?: readonly string[]): never => {
    throw new EfsFault("STREAM_FAILED", `stream stopped after ${emitted} bytes: ${grade}`, {
      details: {
        grade,
        ...(why ? { reason: why } : {}),
        emitted,
        ...(blockedOrigins?.length ? { blockedOrigins } : {}),
      } satisfies StreamFailure,
    });
  };

  async function* ledger(): AsyncGenerator<Uint8Array> {
    const hasher = whole ? sha256Hasher.create() : undefined;
    let pin = await efs.at("latest", call);
    let pos = offset;
    while (pos < end) {
      throwIfAborted(o.signal);
      if (pin.status !== "VERIFIED")
        return fail("UNKNOWN", pin.status === "UNKNOWN" ? pin.reason : undefined);
      const len = end - pos < windowBytes ? end - pos : windowBytes;
      const ctx: Ctx = { efs, requests: 0 };
      const basis = pin.basis;
      let r = await onEndpoint(
        efs._internal.pool,
        (s) => spanRange(ctx, s, basis, file.root as Hex, pos, len),
        call,
      );
      if (!r.ok && r.reason.code !== "DIGEST_MISMATCH") {
        // Records are content-addressed, so a fresh basis cannot change their bytes: re-pin once and retry.
        pin = await efs.at("latest", call);
        if (pin.status === "VERIFIED") {
          const fresh = pin.basis;
          r = await onEndpoint(
            efs._internal.pool,
            (s) => spanRange(ctx, s, fresh, file.root as Hex, pos, len),
            call,
          );
        }
      }
      if (!r.ok)
        return fail(r.reason.code === "DIGEST_MISMATCH" ? "MISMATCH" : "UNKNOWN", r.reason);
      hasher?.update(r.value);
      pos += BigInt(r.value.length);
      yield r.value;
    }
    if (hasher && toHex(hasher.digest()) !== file.sha256.toLowerCase())
      fail(
        "MISMATCH",
        reason("DIGEST_MISMATCH", "never", "whole-file sha256 claim does not match the span tree"),
      );
  }

  async function* buffered(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    for (let p = offset; p < end; p += windowBytes) {
      throwIfAborted(o.signal);
      const stop = p + windowBytes < end ? p + windowBytes : end;
      yield bytes.slice(Number(p), Number(stop));
    }
  }

  async function* source(): AsyncGenerator<Uint8Array> {
    if (total === 0n) return;
    if (file.layout === "inline") {
      yield* buffered(file.inline ?? new Uint8Array());
      return;
    }
    if (file.layout === "chunk" || file.layout === "span") {
      yield* ledger();
      return;
    }
    if (file.layout === "external") {
      const got = await fetchExternal(efs, file, {
        ...call,
        ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
        ...(o.allowOrigins ? { allowOrigins: o.allowOrigins } : {}),
      });
      if (got.grade !== "VERIFIED" || !got.bytes)
        return fail(got.grade, got.reason, got.blockedOrigins);
      yield* buffered(got.bytes);
      return;
    }
    fail(
      "UNAVAILABLE",
      reason("GATEWAY_UNAVAILABLE", "transient", "no location is known for this content yet"),
    );
  }

  const inner = source();
  const finish = (): void => {
    done = true;
    o.signal?.removeEventListener("abort", forward);
  };
  const it: FileChunks = {
    async next() {
      if (done) return { done: true, value: undefined };
      try {
        const r = await inner.next();
        if (r.done) finish();
        else emitted += BigInt(r.value.length);
        return r.done ? { done: true, value: undefined } : r;
      } catch (e) {
        finish();
        throw e;
      }
    },
    async return() {
      if (!done) {
        finish();
        ctl?.abort(new EfsFault("ABORTED", "stream cancelled"));
        await inner.return(undefined).catch(() => {});
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return it;
}
