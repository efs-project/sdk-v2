// SPDX-License-Identifier: MIT
// Files content bodies (contracts docs/LARGE-FILES.md, src/lib/EfsFiles.sol): pure decoders and encoders, plus the
// canonical chunker (efs2/chunking/1). Every body is ABI words, optionally followed by raw bytes.
import { sha256 } from "viem";
import { bytesToHex, type Hex, hexToBytes } from "../core/hex.js";
import { FILES } from "../generated/constants.js";
import { recordId } from "../protocol/keys.js";

// All from the contracts release (generated/constants.ts), never typed here.
export const FORM: { readonly inline: bigint; readonly content: bigint } = {
  inline: BigInt(FILES.form.INLINE),
  content: BigInt(FILES.form.CONTENT),
};
export const CARRIER: {
  readonly inlineChunk: bigint;
  readonly remote: bigint;
  readonly span: bigint;
  readonly location: bigint;
} = {
  inlineChunk: BigInt(FILES.contentCarrier.INLINE),
  remote: BigInt(FILES.contentCarrier.REMOTE),
  span: BigInt(FILES.contentCarrier.SPAN),
  location: BigInt(FILES.externalCarrier.LOCATION),
};
export const HASH_SHA256: bigint = BigInt(FILES.hashAlg.SHA256);
const CONTENT_VERSION = BigInt(FILES.contentVersion);
const EXTERNAL_VERSION = BigInt(FILES.externalVersion);
/** Canonical chunk payload (efs2/chunking/1): a 8,192-byte body minus the 32-byte sha256. */
export const CHUNK_PAYLOAD: number = FILES.chunkPayload;

const word = (b: Uint8Array, i: number): Hex => bytesToHex(b.subarray(i * 32, i * 32 + 32));
const uint = (b: Uint8Array, i: number): bigint => BigInt(word(b, i));
const enc = (...words: (Hex | bigint)[]): Uint8Array => {
  const out = new Uint8Array(words.length * 32);
  words.forEach((w, i) => {
    const hex =
      typeof w === "bigint" ? w.toString(16).padStart(64, "0") : w.slice(2).padStart(64, "0");
    out.set(hexToBytes(`0x${hex}`), i * 32);
  });
  return out;
};
const cat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export type Revision =
  | { file: Hex; parent?: Hex; form: "inline"; bytes: Uint8Array }
  | { file: Hex; parent?: Hex; form: "content"; descriptor: Hex };

/** files-root/1 ([file, form, …]) or files-child/1 ([parent, file, form, …]). Null when malformed. */
export function decodeRevision(body: Uint8Array, kind: "root" | "child"): Revision | null {
  const head = kind === "root" ? 2 : 3;
  if (body.length < head * 32) return null;
  const file = word(body, kind === "root" ? 0 : 1);
  const parent = kind === "child" ? { parent: word(body, 0) } : {};
  const form = uint(body, head - 1);
  if (form === FORM.inline)
    return { file, ...parent, form: "inline", bytes: body.slice(head * 32) };
  if (form === FORM.content && body.length === (head + 1) * 32)
    return { file, ...parent, form: "content", descriptor: word(body, head) };
  return null;
}

export interface ContentDescriptor {
  kind: "content";
  bytesRef: Hex;
  version: bigint;
  carrier: bigint;
  hashAlg: bigint;
  length: bigint;
  sha256: Hex;
  media: bigint;
  cipher: bigint;
}
export function decodeContent(body: Uint8Array): ContentDescriptor | null {
  if (body.length !== 11 * 32) return null;
  return {
    kind: "content",
    bytesRef: word(body, 0),
    version: uint(body, 1),
    carrier: uint(body, 2),
    hashAlg: uint(body, 3),
    length: uint(body, 4),
    sha256: word(body, 5),
    media: uint(body, 6),
    cipher: uint(body, 7),
  };
}

export interface ExternalDescriptor {
  kind: "external";
  length: bigint;
  sha256: Hex;
  locator: string;
}
export function decodeExternal(body: Uint8Array): ExternalDescriptor | null {
  if (body.length < 7 * 32) return null;
  const n = Number(uint(body, 6));
  if (
    body.length !== 7 * 32 + n ||
    uint(body, 1) !== EXTERNAL_VERSION ||
    uint(body, 2) !== CARRIER.location ||
    uint(body, 3) !== HASH_SHA256
  )
    return null;
  let locator = "";
  for (const b of body.subarray(7 * 32)) locator += String.fromCharCode(b); // printable ASCII by rule
  return { kind: "external", length: uint(body, 4), sha256: word(body, 5), locator };
}

export function decodeSpan(body: Uint8Array): { left: Hex; right: Hex; length: bigint } | null {
  return body.length === 96
    ? { left: word(body, 0), right: word(body, 1), length: uint(body, 2) }
    : null;
}

/** files-bytes/1: sha256(payload) ‖ payload. Returns the payload only if its sha256 matches. */
export function decodeChunk(body: Uint8Array): { payload: Uint8Array; sha256: Hex } | null {
  if (body.length < 32) return null;
  const claimed = word(body, 0);
  const payload = body.slice(32);
  return sha256(payload) === claimed ? { payload, sha256: claimed } : null;
}

// ---- encoders (mirror EfsFiles.sol; tested against the contracts seed)

export const encode = {
  rootInline: (file: Hex, bytes: Uint8Array): Uint8Array => cat(enc(file, FORM.inline), bytes),
  rootContent: (file: Hex, descriptor: Hex): Uint8Array => enc(file, FORM.content, descriptor),
  childInline: (parent: Hex, file: Hex, bytes: Uint8Array): Uint8Array =>
    cat(enc(parent, file, FORM.inline), bytes),
  childContent: (parent: Hex, file: Hex, descriptor: Hex): Uint8Array =>
    enc(parent, file, FORM.content, descriptor),
  directory: (seed: Hex): Uint8Array => enc(seed),
  chunk: (payload: Uint8Array): Uint8Array => cat(hexToBytes(sha256(payload)), payload),
  span: (left: Hex, right: Hex, length: bigint): Uint8Array => enc(left, right, length),
  /** Plaintext descriptor (version 1, sha256, no cipher): plaintextLength = length, plaintextSha256 = digest. */
  content: (ref: Hex, carrier: bigint, length: bigint, digest: Hex, media = 0n): Uint8Array =>
    enc(ref, CONTENT_VERSION, carrier, HASH_SHA256, length, digest, media, 0n, 0n, length, digest),
  external: (sentinel: Hex, length: bigint, digest: Hex, locator: string): Uint8Array => {
    const loc = new Uint8Array([...locator].map((c) => c.charCodeAt(0)));
    return cat(
      enc(
        sentinel,
        EXTERNAL_VERSION,
        CARRIER.location,
        HASH_SHA256,
        length,
        digest,
        BigInt(loc.length),
      ),
      loc,
    );
  },
} as const;

export interface ChunkTree {
  /** Records in publication order (children before parents). */
  records: { typeId: Hex; body: Uint8Array; id: Hex }[];
  root: Hex;
  isSpan: boolean;
  chunks: number;
  spans: number;
}

/** Canonical chunking: fixed payloads; tree(n) = chunk if n = 1, else span(tree(first k), tree(rest)), k = largest power of two below n. */
export function chunkTree(
  bytesType: Hex,
  spanType: Hex,
  payload: Uint8Array,
  chunkPayload: number = CHUNK_PAYLOAD,
): ChunkTree {
  const n = payload.length === 0 ? 1 : Math.ceil(payload.length / chunkPayload);
  const records: ChunkTree["records"] = [];
  const leaves: { id: Hex; length: bigint }[] = [];
  for (let i = 0; i < n; i++) {
    const body = encode.chunk(
      payload.subarray(i * chunkPayload, Math.min(payload.length, (i + 1) * chunkPayload)),
    );
    const id = recordId(bytesType, body);
    records.push({ typeId: bytesType, body, id });
    leaves.push({ id, length: BigInt(body.length - 32) });
  }
  let spans = 0;
  const build = (lo: number, hi: number): { id: Hex; length: bigint } => {
    const count = hi - lo;
    if (count === 1) return leaves[lo] as { id: Hex; length: bigint };
    let k = 1;
    while (k * 2 < count) k *= 2;
    const left = build(lo, lo + k);
    const right = build(lo + k, hi);
    const body = encode.span(left.id, right.id, left.length + right.length);
    const id = recordId(spanType, body);
    records.push({ typeId: spanType, body, id });
    spans++;
    return { id, length: left.length + right.length };
  };
  const root = build(0, n);
  return { records, root: root.id, isSpan: n > 1, chunks: n, spans };
}
