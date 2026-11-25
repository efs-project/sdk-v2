// SPDX-License-Identifier: MIT
// @internal Shared by the Files planners (edit, create, move, remove, restore): the action builders, the gas setup
// and the content records, so every planner encodes content and prices it the same way.
import { keccak256, sha256 } from "viem";
import { type GasModel, gasPlanFor, type PlannedAction, txGasCapOf } from "../actions/split.js";
import type { ActionData } from "../actions/types.js";
import { CARRIER, CHUNK_PAYLOAD, chunkTree, encode } from "../content/codec.js";
import { EfsFault, type Reason, reason } from "../core/errors.js";
import { bytesToHex, type Hex, lower, ZERO_WORD } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ACTION } from "../generated/constants.js";
import { recordId } from "../protocol/keys.js";
import { normalizeMediaType } from "./media.js";

/** Content stored elsewhere: the revision names a files-external/1 locator and its sha256. */
export interface ExternalContent {
  kind: "external";
  length: bigint;
  sha256: Hex;
  /** Printable ASCII, e.g. "ipfs://…", "ar://…", "https://…", "web3://…". */
  locator: string;
}

export const blank: ActionData = {
  kind: 0,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  salt: ZERO_WORD,
};

export const publish = (
  typeId: Hex,
  body: Uint8Array,
  shape: string,
  group?: number,
): PlannedAction => ({
  action: { ...blank, kind: ACTION.PUBLISH, typeId, bodyHashOrRecordId: keccak256(body) },
  body: bytesToHex(body),
  shape,
  ...(group !== undefined ? { group } : {}),
});

/** A body-less action (CREATE, BIND, UNBIND, RELEASE). */
export const plain = (
  a: Partial<ActionData>,
  extra: Pick<PlannedAction, "bindRow" | "group"> = {},
): PlannedAction => ({ action: { ...blank, ...a }, body: "0x", ...extra });

export interface GasSetup {
  model: GasModel;
  txGasCap: bigint;
  headroom: number;
  blockGasLimit?: bigint;
}
export interface GasOpts {
  gasModel?: GasModel;
  txGasCap?: bigint;
  headroom?: number;
}

/** The gas model and cap a plan splits with: the caller's, else the contracts' fitted model for this deployment. */
export function gasSetup(
  d: DeploymentInfo,
  o: GasOpts,
): { ok: true; gas: GasSetup } | { ok: false; reason: Reason } {
  if (o.gasModel)
    return {
      ok: true,
      gas: {
        model: o.gasModel,
        txGasCap: o.txGasCap ?? txGasCapOf(d),
        headroom: o.headroom ?? 0.15,
      },
    };
  const g = gasPlanFor(d);
  if (!g.ok) return { ok: false, reason: g.reason };
  return {
    ok: true,
    gas: {
      model: g.model,
      txGasCap: o.txGasCap ?? g.txGasCap,
      headroom: o.headroom ?? g.headroom,
      ...(g.blockGasLimit !== undefined ? { blockGasLimit: g.blockGasLimit } : {}),
    },
  };
}

const printableAscii = (s: string): boolean => /^[\x20-\x7e]+$/.test(s);

/** Throws MISUSE for an external content description the chain would refuse. */
export function checkContent(content: Uint8Array | ExternalContent): void {
  if (content instanceof Uint8Array) return;
  if (!printableAscii(content.locator))
    throw new EfsFault("MISUSE", "an external locator must be printable ASCII");
  if (!/^0x[0-9a-fA-F]{64}$/.test(content.sha256))
    throw new EfsFault("MISUSE", "sha256 must be 32 bytes of hex");
  if (content.length < 0n || content.length >= 1n << 256n)
    throw new EfsFault("MISUSE", "length must be a uint256");
}

/** A caller's media type, normalized, or MISUSE (with the chain's refusal code). Undefined stays undefined. */
export function askedMediaType(mediaType: string | undefined): string | undefined {
  if (mediaType === undefined) return undefined;
  const m = normalizeMediaType(mediaType);
  if (!m.ok)
    throw new EfsFault("MISUSE", `invalid media type: ${m.reason}`, {
      details: { mediaType, code: m.code },
    });
  return m.mediaType;
}

export type ContentLayout = "inline" | "chunk" | "span" | "external";
export interface FilesTypes {
  bytes: Hex;
  span: Hex;
  content: Hex;
  external: Hex;
}

export type BuiltContent =
  | {
      ok: true;
      layout: ContentLayout;
      size: bigint;
      sha256: Hex;
      /** Chunks and spans (or the external sentinel), in publication order, each published once. */
      records: PlannedAction[];
      /** For every layout but inline: the descriptor the revision names. */
      descriptor?: { body: Uint8Array; typeId: Hex; shape: string; id: Hex };
      /** For inline: the bytes the revision carries. */
      inline?: Uint8Array;
    }
  | { ok: false; reason: Reason };

/**
 * The records a file's content needs: inline when the bytes fit one record body after `revisionHeaderBytes` and no
 * media type is declared (an inline revision cannot carry one); otherwise canonical chunks (efs/chunking/1) under a
 * files-content/1 descriptor, or a files-external/1 locator. Pure: no chain reads.
 */
export function buildContent(
  types: FilesTypes,
  content: Uint8Array | ExternalContent,
  mediaType: string,
  maxBodyBytes: number,
  revisionHeaderBytes: number,
): BuiltContent {
  if (content instanceof Uint8Array) {
    const size = BigInt(content.length);
    const digest = sha256(content);
    if (mediaType === "" && content.length <= maxBodyBytes - revisionHeaderBytes)
      return { ok: true, layout: "inline", size, sha256: digest, records: [], inline: content };
    const tree = chunkTree(types.bytes, types.span, content, CHUNK_PAYLOAD);
    const records: PlannedAction[] = [];
    const published = new Set<Hex>();
    for (const r of tree.records) {
      if (published.has(r.id)) continue; // a repeated chunk or subtree: the first occurrence already published it
      published.add(r.id);
      records.push(
        publish(r.typeId, r.body, r.typeId === types.span ? "files-span/1" : "files-bytes/1"),
      );
    }
    const carrier = tree.isSpan ? CARRIER.span : CARRIER.inlineChunk;
    const body = encode.content(tree.root, carrier, size, digest, mediaType);
    return {
      ok: true,
      layout: tree.isSpan ? "span" : "chunk",
      size,
      sha256: digest,
      records,
      descriptor: {
        body,
        typeId: types.content,
        shape: `files-content/1 carrier ${carrier}`,
        id: recordId(types.content, body),
      },
    };
  }
  const digest = lower(content.sha256);
  const sentinelBody = encode.chunk(new Uint8Array());
  const sentinel = recordId(types.bytes, sentinelBody);
  const body = encode.external(sentinel, content.length, digest, content.locator, mediaType);
  if (body.length > maxBodyBytes)
    return {
      ok: false,
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `the locator makes a ${body.length}-byte record; the limit is ${maxBodyBytes}`,
      ),
    };
  return {
    ok: true,
    layout: "external",
    size: content.length,
    sha256: digest,
    records: [publish(types.bytes, sentinelBody, "files-bytes/1")],
    descriptor: {
      body,
      typeId: types.external,
      shape: "files-external/1",
      id: recordId(types.external, body),
    },
  };
}

/** Refuse before chunking anything: no publication carries more than maxBodyBytesPerPublication body bytes. */
export function tooManyBytes(
  content: Uint8Array | ExternalContent,
  maxParts: number,
  maxBodyBytesPerPublication: number,
): Reason | null {
  return content instanceof Uint8Array && content.length > maxParts * maxBodyBytesPerPublication
    ? reason(
        "LIMIT_EXCEEDED",
        "never",
        `${content.length} bytes need more than ${maxParts} publications (store large files externally)`,
      )
    : null;
}

/** A fresh 32-byte salt for CREATE (Web Crypto, present in browsers, workers and Node 20+). */
export function randomSalt(): Hex {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (!c) throw new EfsFault("INVARIANT", "no Web Crypto: pass `salt` to the planner");
  const b = new Uint8Array(32);
  c.getRandomValues(b);
  return bytesToHex(b);
}
