// SPDX-License-Identifier: MIT
// Files content bodies (contracts docs/LARGE-FILES.md, src/lib/EfsFiles.sol): pure decoders and encoders, plus the
// canonical chunker (efs/chunking/1). Every body is ABI words, optionally followed by raw bytes.
import { sha256 } from "viem";
import { EfsFault } from "../core/errors.js";
import { bytesToHex, type Hex, hexToBytes } from "../core/hex.js";
import {
  decodeMediaType,
  MAX_MEDIA_TYPE_BYTES,
  mediaTypeBytes,
  mediaTypeRefusal,
} from "../files/media.js";
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
/** Canonical chunk payload (efs/chunking/1): a 8,192-byte body minus the 32-byte sha256. */
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

/** files-content/1 words before the media tail. */
const CONTENT_WORDS = 10;
/** files-external/1 words before the locator. */
const EXTERNAL_WORDS = 7;

export interface ContentDescriptor {
  kind: "content";
  bytesRef: Hex;
  version: bigint;
  carrier: bigint;
  hashAlg: bigint;
  length: bigint;
  sha256: Hex;
  cipher: bigint;
  /** The declared media type ("" = unknown), the rest of the body after the ten words. */
  mediaType: string;
}
/** files-content/1: ten words, then the media type. Null when malformed (including a tail the chain would refuse). */
export function decodeContent(body: Uint8Array): ContentDescriptor | null {
  const head = CONTENT_WORDS * 32;
  if (body.length < head || body.length > head + MAX_MEDIA_TYPE_BYTES) return null;
  const mediaType = decodeMediaType(body.subarray(head));
  if (mediaType === null) return null;
  return {
    kind: "content",
    bytesRef: word(body, 0),
    version: uint(body, 1),
    carrier: uint(body, 2),
    hashAlg: uint(body, 3),
    length: uint(body, 4),
    sha256: word(body, 5),
    cipher: uint(body, 6),
    mediaType,
  };
}

export interface ExternalDescriptor {
  kind: "external";
  length: bigint;
  sha256: Hex;
  locator: string;
  /** The declared media type ("" = unknown), the rest of the body after the locator. */
  mediaType: string;
}
/** files-external/1: seven words, the locator, then the media type. Null when malformed. */
export function decodeExternal(body: Uint8Array): ExternalDescriptor | null {
  const head = EXTERNAL_WORDS * 32;
  if (body.length < head) return null;
  const n = uint(body, 6);
  if (
    n > BigInt(body.length - head) ||
    body.length - head - Number(n) > MAX_MEDIA_TYPE_BYTES ||
    uint(body, 1) !== EXTERNAL_VERSION ||
    uint(body, 2) !== CARRIER.location ||
    uint(body, 3) !== HASH_SHA256
  )
    return null;
  const mediaType = decodeMediaType(body.subarray(head + Number(n)));
  if (mediaType === null) return null;
  let locator = "";
  for (const b of body.subarray(head, head + Number(n))) locator += String.fromCharCode(b); // printable ASCII by rule
  return { kind: "external", length: uint(body, 4), sha256: word(body, 5), locator, mediaType };
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

// ---- encoders (mirror EfsFiles.sol; tested against the contracts seed and test/vectors/media.json)

/** A media type's tail bytes. An invalid one is a caller bug here: planning normalizes and refuses it first. */
const media = (mediaType: string): Uint8Array => {
  const b = mediaTypeBytes(mediaType);
  if (mediaTypeRefusal(b) !== 0)
    throw new EfsFault("MISUSE", `the chain refuses the media type ${JSON.stringify(mediaType)}`);
  return b;
};

export const encode = {
  rootInline: (file: Hex, bytes: Uint8Array): Uint8Array => cat(enc(file, FORM.inline), bytes),
  rootContent: (file: Hex, descriptor: Hex): Uint8Array => enc(file, FORM.content, descriptor),
  childInline: (parent: Hex, file: Hex, bytes: Uint8Array): Uint8Array =>
    cat(enc(parent, file, FORM.inline), bytes),
  childContent: (parent: Hex, file: Hex, descriptor: Hex): Uint8Array =>
    enc(parent, file, FORM.content, descriptor),
  /** files-directory/1: abi.encode(creatorPrincipal, salt), 64 bytes; only its creator may publish it. */
  directory: (creator: Hex, salt: Hex): Uint8Array => enc(creator, salt),
  chunk: (payload: Uint8Array): Uint8Array => cat(hexToBytes(sha256(payload)), payload),
  span: (left: Hex, right: Hex, length: bigint): Uint8Array => enc(left, right, length),
  /**
   * Plaintext descriptor (version 1, sha256, no cipher): plaintextLength = length, plaintextSha256 = digest, then the
   * media type, already normalized (normalizeMediaType). Throws on a media type the chain would refuse.
   */
  content: (ref: Hex, carrier: bigint, length: bigint, digest: Hex, mediaType = ""): Uint8Array =>
    cat(
      enc(ref, CONTENT_VERSION, carrier, HASH_SHA256, length, digest, 0n, 0n, length, digest),
      media(mediaType),
    ),
  /** Seven words, the locator, then the media type (normalized; throws on one the chain would refuse). */
  external: (
    sentinel: Hex,
    length: bigint,
    digest: Hex,
    locator: string,
    mediaType = "",
  ): Uint8Array => {
    const loc = new Uint8Array([...locator].map((c) => c.charCodeAt(0)));
    return cat(
      cat(
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
      ),
      media(mediaType),
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
