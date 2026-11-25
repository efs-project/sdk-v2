// SPDX-License-Identifier: MIT
// The content encoders and the canonical chunker rebuild the contracts seed's record ids exactly.
import { encodeAbiParameters, keccak256, sha256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import deployment from "../../../protocol-inputs/contracts/release/efs-deployment.json" with {
  type: "json",
};
import {
  CARRIER,
  chunkTree,
  decodeChunk,
  decodeContent,
  decodeExternal,
  decodeRevision,
  decodeSpan,
  encode,
} from "../src/content/codec.ts";
import { type Hex, hexToBytes } from "../src/core/hex.ts";
import { recordId } from "../src/protocol/keys.ts";

const t = deployment.typeIds as Record<string, Hex>;
interface SeedFile {
  name: string;
  subjectId: Hex;
  headRecordId: Hex;
  sha256: Hex;
  length: number;
  spanRootId: Hex;
  chunkCount: number;
  spanCount: number;
  contentRecordId: Hex;
  sentinelRecordId: Hex;
  externalRecordId: Hex;
  locator: string;
  media?: string;
}
const files = deployment.seed.files as unknown as SeedFile[];
const byName = (n: string): SeedFile => files.find((f) => f.name === n) as SeedFile;
const T = (n: string): Hex => t[n] as Hex;

/** deploy-plan.mjs fixturePayload: keccak(abi.encode(seed, i)) words, truncated. */
function fixturePayload(n: number, seed: Hex): Uint8Array {
  let hex = "";
  for (let i = 0; i < n; i += 32)
    hex += keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(i)]),
    ).slice(2);
  return hexToBytes(`0x${hex.slice(0, n * 2)}`);
}

describe("content codec vs the contracts seed", () => {
  it("inline readme: files-root/1 form 0", () => {
    const f = byName("readme.txt");
    const bytes = new TextEncoder().encode("Meeting at 10:00.\n");
    const body = encode.rootInline(f.subjectId, bytes);
    expect(recordId(T("files-root/1"), body)).toBe(f.headRecordId);
    expect(sha256(bytes)).toBe(f.sha256);
    const rev = decodeRevision(body, "root");
    expect(rev?.form === "inline" && new TextDecoder().decode(rev.bytes)).toBe(
      "Meeting at 10:00.\n",
    );
  });
  it("big.bin: canonical chunk tree, carrier-2 descriptor and form-1 revision", () => {
    const f = byName("big.bin");
    const payload = fixturePayload(20_000, keccak256(stringToHex("efs-fixture/big.bin")));
    expect(sha256(payload)).toBe(f.sha256);
    const tree = chunkTree(T("files-bytes/1"), T("files-span/1"), payload);
    expect(tree.root).toBe(f.spanRootId);
    expect([tree.chunks, tree.spans]).toEqual([f.chunkCount, f.spanCount]);
    expect(f.media).toBe("application/octet-stream");
    const content = encode.content(tree.root, CARRIER.span, 20_000n, f.sha256, f.media);
    expect(recordId(T("files-content/1"), content)).toBe(f.contentRecordId);
    const rev = encode.rootContent(f.subjectId, f.contentRecordId);
    expect(recordId(T("files-root/1"), rev)).toBe(f.headRecordId);
    expect(decodeContent(content)).toMatchObject({ carrier: 2n, mediaType: f.media });
    const root = tree.records.find((r) => r.id === tree.root);
    expect(decodeSpan(root?.body ?? new Uint8Array())?.length).toBe(20_000n);
    const firstChunk = tree.records[0];
    expect(decodeChunk(firstChunk?.body ?? new Uint8Array())?.payload.length).toBe(8160);
  });
  it("remote.txt: files-external/1 with its locator", () => {
    const f = byName("remote.txt");
    const sentinel = recordId(T("files-bytes/1"), encode.chunk(new Uint8Array()));
    expect(sentinel).toBe(f.sentinelRecordId);
    expect(f.media).toBe("text/plain; charset=utf-8");
    const body = encode.external(sentinel, BigInt(f.length), f.sha256, f.locator, f.media);
    expect(recordId(T("files-external/1"), body)).toBe(f.externalRecordId);
    expect(decodeExternal(body)).toMatchObject({ locator: f.locator, mediaType: f.media });
  });
  it("refuses tampered chunks and malformed bodies", () => {
    const body = encode.chunk(new Uint8Array([1, 2, 3]));
    body[33] = 9;
    expect(decodeChunk(body)).toBeNull();
    expect(decodeRevision(new Uint8Array(40), "root")).toBeNull();
    expect(decodeContent(new Uint8Array(64))).toBeNull();
  });
});
