// SPDX-License-Identifier: MIT
// Verified byte reads: open a file (resolve its HEAD revision under a Lens) and read its bytes. Inline bytes and
// on-chain chunks are verified against their record ids; span trees chunk by chunk; external locations against
// the descriptor's sha256. Bytes that fail a check are never handed back.
import { decodeFunctionResult, encodeFunctionData, sha256 } from "viem";
import { callsAt } from "../chain/basis.js";
import { type Attempt, type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { FetchLike } from "../chain/rpc.js";
import type { Efs, Lens } from "../client.js";
import {
  CARRIER,
  decodeChunk,
  decodeContent,
  decodeExternal,
  decodeRevision,
  decodeSpan,
} from "../content/codec.js";
import {
  checkHttpUrl,
  DEFAULT_GATEWAYS,
  type GatewayPolicy,
  planLocator,
} from "../content/locator.js";
import { type LedgerRecord, readRecords } from "../content/records.js";
import { type CallOpts, EfsFault, type Reason, reason, throwIfAborted } from "../core/errors.js";
import {
  type Hex,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
  ZERO_WORD,
} from "../core/hex.js";
import { clearTimer, setTimer } from "../core/platform.js";
import { lensReaderAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/purposes.js";
import { chainStatus } from "../protocol/status.js";

export interface FileRef {
  kind: "file";
  subject: SubjectId;
}
export interface RevisionRef {
  kind: "revision";
  recordId: RecordId;
  file?: SubjectId;
}
export interface Evidence {
  attempts: readonly Attempt[];
  requests: number;
}

export interface Location {
  scheme: string;
  uri?: string;
  descriptor?: RecordId;
}

export interface OpenedFile {
  file: SubjectId;
  revision: RecordId;
  author: PrincipalId | null;
  size: bigint;
  sha256: Hex;
  layout: "inline" | "chunk" | "span" | "external" | "remote";
  /** For inline layout only: the verified bytes (≤ one record body). */
  inline?: Uint8Array;
  /** For chunk/span layouts: the root record id. */
  root?: RecordId;
  locations: readonly Location[];
}

export type OpenResult =
  | { kind: "efs.open"; status: "PRESENT"; file: OpenedFile; basis: Basis; evidence: Evidence }
  | {
      kind: "efs.open";
      status: "ABSENT_PROVEN" | "MASKED" | "CONFLICT" | "UNKNOWN" | "INVALID";
      reason?: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

export type ByteGrade =
  | "VERIFIED"
  | "MISMATCH"
  | "UNAVAILABLE"
  | "UNSUPPORTED_LOCATOR"
  | "POLICY_BLOCKED"
  | "UNKNOWN";

export interface LocationAttempt {
  location: string;
  outcome: "VERIFIED" | "MISMATCH" | "FAILED" | "TOO_LARGE";
  detail?: string;
}

export interface ByteRangeResult {
  kind: "efs.bytes.range";
  grade: ByteGrade;
  offset: bigint;
  length: bigint;
  /** Present only when grade is VERIFIED. */
  bytes?: Uint8Array;
  location?: Location;
  attempts: readonly LocationAttempt[];
  reason?: Reason;
  evidence: Evidence;
}

export interface ReadOpts extends CallOpts {
  lens?: Lens;
}

const EMPTY_BASIS = {
  executionSet: ZERO_WORD,
  revision: 0,
  indexGeneration: 0,
  registryMutations: 0n,
  admissionHighWater: 0n,
  phase: 0,
};

/** @internal */
export type Ctx = { efs: Efs; requests: number };

async function readOne(ctx: Ctx, s: Session, basis: Basis, id: Hex): Promise<Step<LedgerRecord>> {
  ctx.requests += 1;
  const r = await readRecords(s, ctx.efs.deployment, basis.blockHash, [id]);
  return r.ok ? { ok: true, value: r.value[0] as LedgerRecord } : r;
}

const typeName = (efs: Efs, typeId: Hex): string | undefined => {
  for (const [name, id] of Object.entries(efs.deployment.typeIds))
    if (lower(id) === lower(typeId)) return name;
  return undefined;
};

/** Resolve a file's HEAD revision under the Lens, then its content layout. */
export async function openFile(
  efs: Efs,
  target: FileRef | RevisionRef,
  o: ReadOpts = {},
): Promise<OpenResult> {
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED") {
    return {
      kind: "efs.open",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  }
  const basis = pin.basis;
  const lens = o.lens ?? efs.lens.default;
  type Out =
    | { status: "PRESENT"; file: OpenedFile }
    | { status: "ABSENT_PROVEN" | "MASKED" | "CONFLICT" | "UNKNOWN" | "INVALID"; reason?: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s) => {
      let revisionId: Hex;
      let author: PrincipalId | null = null;
      let fileSubject: Hex | undefined;
      if (target.kind === "file") {
        fileSubject = target.subject;
        ctx.requests += 1;
        const data = encodeFunctionData({
          abi: lensReaderAbi,
          functionName: "resolve",
          args: [
            lens.principals,
            { purpose: PURPOSES.head, subject: target.subject, role: ZERO_WORD },
            EMPTY_BASIS,
          ],
        });
        const [out] = await callsAt(s, basis.blockHash, [
          { to: efs.deployment.readers.lens, data },
        ]);
        if (!out?.ok)
          return {
            ok: false,
            retryElsewhere: true,
            reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
          };
        const [q, sel] = decodeFunctionResult({
          abi: lensReaderAbi,
          functionName: "resolve",
          data: out.result as Hex,
        }) as unknown as [
          { status: number },
          { status: number; target: Hex; principalId: Hex; revision: bigint },
        ];
        // LensReader.resolve: q.status equals the selection's status (PRESENT, MASKED, ABSENT_PROVEN, UNKNOWN),
        // or is a refusal (INVALID, LIMIT_EXCEEDED, BASIS_STALE, UNSUPPORTED). Anything else is not guessed at.
        const qs = chainStatus(q.status);
        if (qs === "ABSENT_PROVEN" || qs === "MASKED" || qs === "UNKNOWN")
          return { ok: true, value: { status: qs } };
        if (qs === "BASIS_STALE")
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason("BASIS_STALE", "transient", "the lens reader saw a different basis"),
          };
        if (qs === "INVALID" || qs === "LIMIT_EXCEEDED" || qs === "UNSUPPORTED") {
          return {
            ok: true,
            value: {
              status: "INVALID",
              reason: reason(
                qs === "LIMIT_EXCEEDED" ? "LIMIT_EXCEEDED" : "UNSUPPORTED_PROFILE",
                "never",
                `lens reader refused the query: ${qs}`,
              ),
            },
          };
        }
        if (qs !== "PRESENT" || chainStatus(sel.status) !== "PRESENT") {
          return {
            ok: true,
            value: {
              status: "UNKNOWN",
              reason: reason(
                "RPC_ERROR",
                "never",
                `unexpected lens status ${qs}/${chainStatus(sel.status)}`,
              ),
            },
          };
        }
        revisionId = lower(sel.target);
        author = lower(sel.principalId) as PrincipalId;
      } else {
        revisionId = lower(target.recordId);
        fileSubject = target.file;
      }
      const rev = await readOne(ctx, s, basis, revisionId);
      if (!rev.ok) return rev;
      if (rev.value.status !== "PRESENT" || !rev.value.body) {
        const st = rev.value.status === "ABSENT_PROVEN" ? "ABSENT_PROVEN" : "UNKNOWN";
        return { ok: true, value: { status: st } };
      }
      const kind = typeName(efs, rev.value.typeId);
      if (kind !== "files-root/1" && kind !== "files-child/1") {
        return {
          ok: true,
          value: {
            status: "INVALID",
            reason: reason(
              "UNSUPPORTED_PROFILE",
              "never",
              `record is ${kind ?? "an unknown Type"}, not a file revision`,
            ),
          },
        };
      }
      const decoded = decodeRevision(rev.value.body, kind === "files-root/1" ? "root" : "child");
      if (!decoded)
        return {
          ok: true,
          value: {
            status: "INVALID",
            reason: reason("UNSUPPORTED_PROFILE", "never", "malformed revision body"),
          },
        };
      const base = {
        file: lower((fileSubject ?? decoded.file) as Hex) as SubjectId,
        revision: revisionId as RecordId,
        author,
      };
      if (decoded.form === "inline") {
        return {
          ok: true,
          value: {
            status: "PRESENT",
            file: {
              ...base,
              size: BigInt(decoded.bytes.length),
              sha256: sha256(decoded.bytes),
              layout: "inline",
              inline: decoded.bytes,
              locations: [{ scheme: "ledger" }],
            },
          },
        };
      }
      const desc = await readOne(ctx, s, basis, decoded.descriptor);
      if (!desc.ok) return desc;
      if (desc.value.status !== "PRESENT" || !desc.value.body)
        return {
          ok: true,
          value: {
            status: "UNKNOWN",
            reason: reason("RPC_ERROR", "transient", "descriptor not readable"),
          },
        };
      const dType = typeName(efs, desc.value.typeId);
      const descriptor = lower(decoded.descriptor) as RecordId;
      if (dType === "files-external/1") {
        const ext = decodeExternal(desc.value.body);
        if (!ext)
          return {
            ok: true,
            value: {
              status: "INVALID",
              reason: reason("UNSUPPORTED_PROFILE", "never", "malformed external descriptor"),
            },
          };
        const scheme = ext.locator.slice(0, Math.max(0, ext.locator.indexOf(":"))).toLowerCase();
        return {
          ok: true,
          value: {
            status: "PRESENT",
            file: {
              ...base,
              size: ext.length,
              sha256: ext.sha256,
              layout: "external",
              locations: [{ scheme, uri: ext.locator, descriptor }],
            },
          },
        };
      }
      if (dType === "files-content/1") {
        const c = decodeContent(desc.value.body);
        if (c?.cipher !== 0n)
          return {
            ok: true,
            value: {
              status: "INVALID",
              reason: reason(
                "UNSUPPORTED_PROFILE",
                "never",
                c ? "encrypted content is not supported in 0.1" : "malformed content descriptor",
              ),
            },
          };
        const layout =
          c.carrier === CARRIER.span
            ? "span"
            : c.carrier === CARRIER.inlineChunk
              ? "chunk"
              : "remote";
        return {
          ok: true,
          value: {
            status: "PRESENT",
            file: {
              ...base,
              size: c.length,
              sha256: c.sha256,
              layout,
              ...(layout === "remote" ? {} : { root: lower(c.bytesRef) as RecordId }),
              locations: layout === "remote" ? [] : [{ scheme: "ledger", descriptor }],
            },
          },
        };
      }
      return {
        ok: true,
        value: {
          status: "INVALID",
          reason: reason(
            "UNSUPPORTED_PROFILE",
            "never",
            `descriptor is ${dType ?? "an unknown Type"}`,
          ),
        },
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { kind: "efs.open", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const v = r.value;
  return v.status === "PRESENT"
    ? { kind: "efs.open", status: "PRESENT", file: v.file, basis, evidence }
    : {
        kind: "efs.open",
        status: v.status,
        ...(v.reason ? { reason: v.reason } : {}),
        basis,
        evidence,
      };
}

// ---- reading bytes

export interface BytesOpts extends CallOpts {
  /** Refuse files larger than this (default 50 MiB). */
  maxBytes?: bigint;
}

/** Bounds on a span walk, independent of the sizes the tree declares. */
const MAX_SPAN_DEPTH = 64;

/** @internal Collect the verified chunk payloads of a span tree overlapping [offset, offset + length). */
export async function spanRange(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  root: Hex,
  offset: bigint,
  length: bigint,
): Promise<Step<Uint8Array>> {
  const parts: Uint8Array[] = [];
  const end = offset + length;
  // Each requested chunk costs one chunk read plus at most one span read per tree level.
  let budget = Math.ceil(Number(length) / 8160 + 2) * (MAX_SPAN_DEPTH + 1);
  const fail = (code: string, detail: string): Step<never> => ({
    ok: false,
    retryElsewhere: false,
    reason: reason(code, "never", detail),
  });
  const visit = async (id: Hex, start: bigint, depth: number): Promise<Step<bigint>> => {
    if (depth > MAX_SPAN_DEPTH)
      return fail("LIMIT_EXCEEDED", `span tree deeper than ${MAX_SPAN_DEPTH}`);
    budget -= 1;
    if (budget < 0) return fail("LIMIT_EXCEEDED", "span walk exceeded its node budget");
    const rec = await readOne(ctx, s, basis, id);
    if (!rec.ok) return rec;
    if (rec.value.status !== "PRESENT" || !rec.value.body) {
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", `chunk record ${id} not present`),
      };
    }
    const t = typeName(ctx.efs, rec.value.typeId);
    if (t === "files-bytes/1") {
      const chunk = decodeChunk(rec.value.body);
      if (!chunk) return fail("DIGEST_MISMATCH", `chunk ${id} fails its sha256`);
      const len = BigInt(chunk.payload.length);
      const lo = offset > start ? offset - start : 0n;
      const hi = end < start + len ? end - start : len;
      if (hi > lo) parts.push(chunk.payload.slice(Number(lo), Number(hi)));
      return { ok: true, value: len };
    }
    if (t === "files-span/1") {
      const span = decodeSpan(rec.value.body);
      if (!span) return fail("UNSUPPORTED_PROFILE", "malformed span");
      if (start + span.length <= offset || start >= end) return { ok: true, value: span.length }; // outside the range
      const left = await visit(span.left, start, depth + 1);
      if (!left.ok) return left;
      if (left.value > span.length)
        return fail("DIGEST_MISMATCH", `span ${id}: left child longer than the node`);
      if (start + left.value < end) {
        const right = await visit(span.right, start + left.value, depth + 1);
        if (!right.ok) return right;
        if (left.value + right.value !== span.length)
          return fail("DIGEST_MISMATCH", `span ${id}: children do not add up to its length`);
      }
      return { ok: true, value: span.length };
    }
    return fail("UNSUPPORTED_PROFILE", `span child is ${t ?? "an unknown Type"}`);
  };
  const done = await visit(root, 0n, 0);
  if (!done.ok) return done;
  const total = parts.reduce((n, p) => n + p.length, 0);
  if (BigInt(total) !== length)
    return fail("DIGEST_MISMATCH", `span tree yielded ${total} bytes for a ${length}-byte range`);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { ok: true, value: out };
}

type BodyReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

/** Read a response body, refusing more than `max` bytes while reading (never trusting content-length alone). */
async function boundedBody(
  res: { body?: unknown; arrayBuffer(): Promise<ArrayBuffer> },
  max: bigint,
): Promise<Uint8Array | "TOO_LARGE"> {
  const reader = (res.body as { getReader?: () => BodyReader } | undefined)?.getReader?.();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    return BigInt(all.length) > max ? "TOO_LARGE" : all;
  }
  const parts: Uint8Array[] = [];
  let total = 0n;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += BigInt(value.length);
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "TOO_LARGE";
    }
    parts.push(value);
  }
  const out = new Uint8Array(Number(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The global URL constructor, typed structurally (the portable core has no DOM types). */
const resolveUrl = (target: string, base: string): string | null => {
  const U = (globalThis as unknown as { URL?: new (u: string, b?: string) => { href: string } })
    .URL;
  try {
    return U ? new U(target, base).href : null;
  } catch {
    return null;
  }
};

interface Origin {
  protocol: string;
  hostname: string;
  port: string;
}
/** Scheme, hostname and effective port of an absolute URL via the WHATWG parser, or null. */
const originOf = (url: string): Origin | null => {
  const U = (globalThis as unknown as { URL?: new (u: string) => Origin }).URL;
  try {
    if (!U) return null;
    const u = new U(url);
    const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return { protocol: u.protocol, hostname: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
};

/**
 * A redirect hop stays within a configured gateway iff it keeps the gateway's exact scheme and port and lands on
 * the gateway's host or a subdomain of it (a subdomain gateway such as `<cid>.ipfs.localhost:8080`).
 */
export const withinGateway = (gateway: Origin | null, target: Origin | null): boolean =>
  gateway !== null &&
  target !== null &&
  target.protocol === gateway.protocol &&
  target.port === gateway.port &&
  (target.hostname === gateway.hostname || target.hostname.endsWith(`.${gateway.hostname}`));

/** In browsers the page's own network policy applies and redirects are followed; elsewhere each hop is re-checked. */
const inBrowser = (): boolean =>
  typeof (globalThis as { document?: unknown }).document !== "undefined";

/** @internal */
export async function fetchExternal(
  efs: Efs,
  file: OpenedFile,
  o: BytesOpts,
): Promise<{
  grade: ByteGrade;
  bytes?: Uint8Array;
  location?: Location;
  attempts: LocationAttempt[];
  reason?: Reason;
}> {
  const attempts: LocationAttempt[] = [];
  const policy: GatewayPolicy = {
    ipfs: efs.gateways.ipfs ?? DEFAULT_GATEWAYS.ipfs,
    arweave: efs.gateways.arweave ?? DEFAULT_GATEWAYS.arweave,
    allowSchemes: efs.gateways.allowSchemes ?? DEFAULT_GATEWAYS.allowSchemes,
    allowInsecureHttp: efs.gateways.allowInsecureHttp ?? false,
    allowPrivateHosts: efs.gateways.allowPrivateHosts ?? false,
  };
  const max = o.maxBytes ?? efs.gateways.maxBytes ?? 50n * 1024n * 1024n;
  if (file.size > max)
    return {
      grade: "UNAVAILABLE",
      attempts,
      reason: reason("TOO_LARGE", "never", `file is ${file.size} bytes; limit ${max}`),
    };
  const fetchImpl = efs._internal.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
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
      if (sha256(plan.inline) === file.sha256 && BigInt(plan.inline.length) === file.size) {
        attempts.push({ location: "data", outcome: "VERIFIED" });
        return { grade: "VERIFIED", bytes: plan.inline, location: loc, attempts };
      }
      attempts.push({ location: "data", outcome: "MISMATCH" });
      continue;
    }
    for (const url of plan.urls) {
      throwIfAborted(o.signal);
      const origin = /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? plan.scheme;
      if (!fetchImpl) {
        attempts.push({ location: origin, outcome: "FAILED", detail: "no fetch implementation" });
        continue;
      }
      let timer: unknown;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimer(() => reject(new Error("timeout")), efs.gateways.timeoutMs ?? 10_000);
        });
        const follow = inBrowser();
        const get = (u: string) =>
          Promise.race([
            fetchImpl(u, {
              method: "GET",
              headers: {},
              redirect: follow ? "follow" : "manual",
              ...(o.signal ? { signal: o.signal } : {}),
            }),
            timeout,
          ]);
        let res = await get(url);
        // Outside browsers, follow at most 5 redirects, checking every target against the policy. A gateway the
        // user configured (even a local, plain-http one) keeps that trust for hops on its own scheme and port and
        // its host or a subdomain (a subdomain gateway); every other target is checked as untrusted.
        const gateway = plan.scheme === "ipfs" || plan.scheme === "ar" ? originOf(url) : null;
        const gatewayPolicy: GatewayPolicy = {
          ...policy,
          allowInsecureHttp: true,
          allowPrivateHosts: true,
        };
        for (let hop = 0; !follow && res.status >= 300 && res.status < 400 && hop < 5; hop++) {
          const next = res.headers.get("location");
          const target = next ? resolveUrl(next, url) : null;
          if (!target) break;
          const trusted = withinGateway(gateway, originOf(target));
          if (checkHttpUrl(target, trusted ? gatewayPolicy : policy) !== "ok") break;
          res = await get(target);
        }
        if (!res.ok) {
          attempts.push({ location: origin, outcome: "FAILED", detail: `HTTP ${res.status}` });
          continue;
        }
        const declared = res.headers.get("content-length");
        if (declared && /^\d+$/.test(declared) && BigInt(declared) > max) {
          attempts.push({ location: origin, outcome: "TOO_LARGE" });
          continue;
        }
        const bytes = await Promise.race([boundedBody(res, max), timeout]);
        if (bytes === "TOO_LARGE") {
          attempts.push({ location: origin, outcome: "TOO_LARGE" });
          continue;
        }
        if (BigInt(bytes.length) === file.size && sha256(bytes) === file.sha256) {
          attempts.push({ location: origin, outcome: "VERIFIED" });
          return { grade: "VERIFIED", bytes, location: loc, attempts };
        }
        attempts.push({ location: origin, outcome: "MISMATCH" }); // fail over: a hostile first gateway never wins
      } catch (e) {
        if (o.signal?.aborted)
          throw new EfsFault("ABORTED", "aborted by the caller", { cause: o.signal.reason });
        attempts.push({
          location: origin,
          outcome: "FAILED",
          detail: e instanceof Error ? e.message : "fetch failed",
        });
      } finally {
        clearTimer(timer);
      }
    }
  }
  if (!sawSupported) return { grade: lastBlocked, attempts };
  const anyMismatch = attempts.some((a) => a.outcome === "MISMATCH");
  return {
    grade: anyMismatch ? "MISMATCH" : "UNAVAILABLE",
    attempts,
    reason: reason(anyMismatch ? "DIGEST_MISMATCH" : "GATEWAY_UNAVAILABLE", "transient"),
  };
}

/** Read [offset, offset + length) of an opened file, verified. */
export async function readRange(
  efs: Efs,
  file: OpenedFile,
  range: { offset: bigint; length: bigint },
  o: BytesOpts = {},
): Promise<ByteRangeResult> {
  const { offset } = range;
  if (offset < 0n || range.length < 0n)
    throw new EfsFault("MISUSE", "offset and length must be non-negative");
  const length =
    offset >= file.size
      ? 0n
      : range.length > file.size - offset
        ? file.size - offset
        : range.length;
  const base = { kind: "efs.bytes.range" as const, offset, length };
  const cap = o.maxBytes ?? efs.gateways.maxBytes ?? 50n * 1024n * 1024n;
  if (length > cap) {
    return {
      ...base,
      grade: "UNAVAILABLE",
      attempts: [],
      reason: reason("TOO_LARGE", "never", `range is ${length} bytes; limit ${cap}`),
      evidence: { attempts: [], requests: 0 },
    };
  }
  if (file.layout === "inline") {
    const bytes = (file.inline ?? new Uint8Array()).slice(Number(offset), Number(offset + length));
    return {
      ...base,
      grade: "VERIFIED",
      bytes,
      location: { scheme: "ledger" },
      attempts: [{ location: "ledger", outcome: "VERIFIED" }],
      evidence: { attempts: [], requests: 0 },
    };
  }
  if (file.layout === "chunk" || file.layout === "span") {
    const pin = await efs.at("latest", o);
    if (pin.status !== "VERIFIED") {
      return {
        ...base,
        grade: "UNKNOWN",
        attempts: [],
        ...(pin.status === "UNKNOWN" ? { reason: pin.reason } : {}),
        evidence: pin.evidence,
      };
    }
    const ctx: Ctx = { efs, requests: pin.evidence.requests };
    const r = await onEndpoint(
      efs._internal.pool,
      (s) => spanRange(ctx, s, pin.basis, file.root as Hex, offset, length),
      o,
    );
    const evidence = {
      attempts: [...pin.evidence.attempts, ...r.attempts],
      requests: ctx.requests,
    };
    if (!r.ok) {
      const grade: ByteGrade = r.reason.code === "DIGEST_MISMATCH" ? "MISMATCH" : "UNKNOWN";
      return {
        ...base,
        grade,
        attempts: [{ location: "ledger", outcome: grade === "MISMATCH" ? "MISMATCH" : "FAILED" }],
        reason: r.reason,
        evidence,
      };
    }
    // A full read also checks the author's whole-file sha256 claim (a span root id already commits to every chunk).
    if (offset === 0n && length === file.size && sha256(r.value) !== file.sha256) {
      return {
        ...base,
        grade: "MISMATCH",
        attempts: [{ location: "ledger", outcome: "MISMATCH" }],
        reason: reason(
          "DIGEST_MISMATCH",
          "never",
          "whole-file sha256 claim does not match the span tree",
        ),
        evidence,
      };
    }
    return {
      ...base,
      grade: "VERIFIED",
      bytes: r.value,
      location: { scheme: "ledger" },
      attempts: [{ location: "ledger", outcome: "VERIFIED" }],
      evidence,
    };
  }
  if (file.layout === "external") {
    const got = await fetchExternal(efs, file, o);
    const evidence = { attempts: [], requests: 0 };
    if (got.grade !== "VERIFIED" || !got.bytes)
      return {
        ...base,
        grade: got.grade,
        attempts: got.attempts,
        ...(got.reason ? { reason: got.reason } : {}),
        evidence,
      };
    return {
      ...base,
      grade: "VERIFIED",
      bytes: got.bytes.slice(Number(offset), Number(offset + length)),
      ...(got.location ? { location: got.location } : {}),
      attempts: got.attempts,
      evidence,
    };
  }
  return {
    ...base,
    grade: "UNAVAILABLE",
    attempts: [],
    reason: reason(
      "GATEWAY_UNAVAILABLE",
      "transient",
      "no location is known for this content yet (digest-index lookup comes later)",
    ),
    evidence: { attempts: [], requests: 0 },
  };
}

/** Read the whole file, verified, bounded by maxBytes. */
export async function readBytes(
  efs: Efs,
  file: OpenedFile,
  o: BytesOpts = {},
): Promise<ByteRangeResult> {
  const max = o.maxBytes ?? efs.gateways.maxBytes ?? 50n * 1024n * 1024n;
  if (file.size > max) {
    return {
      kind: "efs.bytes.range",
      offset: 0n,
      length: 0n,
      grade: "UNAVAILABLE",
      attempts: [],
      reason: reason("TOO_LARGE", "never", `file is ${file.size} bytes; limit ${max}`),
      evidence: { attempts: [], requests: 0 },
    };
  }
  return readRange(efs, file, { offset: 0n, length: file.size }, o);
}
