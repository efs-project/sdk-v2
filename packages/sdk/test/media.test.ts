// SPDX-License-Identifier: MIT
// Media types (files-content/1 and files-external/1 tails), against the contracts' generated vectors, which are the
// authority: the grammar's refusal codes byte for byte, the encodings and record ids, the decoders' refusals, and the
// planning normalizer (lowercase the type and subtype, refuse everything else the chain refuses).
import { describe, expect, it } from "vitest";
import deployment from "../../../protocol-inputs/contracts/release/efs-deployment.json" with {
  type: "json",
};
import vectors from "../../../protocol-inputs/contracts/test/vectors/media.json" with {
  type: "json",
};
import { decodeContent, decodeExternal, encode } from "../src/content/codec.ts";
import { EfsFault } from "../src/core/errors.ts";
import { bytesToHex, type Hex, hexToBytes } from "../src/core/hex.ts";
import {
  decodeMediaType,
  MAX_MEDIA_TYPE_BYTES,
  mediaTypeBytes,
  mediaTypeRefusal,
  normalizeMediaType,
} from "../src/files/media.ts";
import { recordId } from "../src/protocol/keys.ts";

interface RuleVector {
  label: string;
  mediaHex: Hex;
  length: number;
  accepted: boolean;
  grammarCode: number;
  media?: string;
}
interface EncodingVector {
  label: string;
  type: "files-content/1" | "files-external/1";
  inputs: {
    bytesRef?: Hex;
    carrier?: number;
    sentinel?: Hex;
    length: number;
    sha256: Hex;
    locator?: string;
    media: string;
    mediaHex: Hex;
  };
  body: Hex;
  bodyLength: number;
  typeId: Hex;
  recordId: Hex;
}
const rules = vectors.rules as RuleVector[];
const encodings = vectors.encoding as EncodingVector[];
const typeIds = deployment.typeIds as Record<string, Hex>;

describe("media-type vectors (contracts test/vectors/media.json)", () => {
  it("are for this deployment's Types, and the limit comes from the release", () => {
    expect(vectors.schema).toBe("efs/vectors/media/1");
    for (const [name, id] of Object.entries(vectors.typeIds)) expect(typeIds[name]).toBe(id);
    expect(MAX_MEDIA_TYPE_BYTES).toBe(255);
    expect(rules.length).toBeGreaterThan(30);
    expect(encodings.length).toBeGreaterThan(5);
  });

  it.each(rules)("grammar: $label", (v) => {
    const b = hexToBytes(v.mediaHex);
    expect(b.length).toBe(v.length);
    expect(mediaTypeRefusal(b)).toBe(v.grammarCode);
    expect(v.accepted).toBe(v.grammarCode === 0);
    // A reader hands back exactly the admitted string, and never a refused one.
    expect(decodeMediaType(b)).toBe(v.accepted ? (v.media ?? null) : null);
    if (v.media !== undefined) expect(bytesToHex(mediaTypeBytes(v.media))).toBe(v.mediaHex);
  });

  it.each(rules.filter((v) => v.media !== undefined))("planning: $label", (v) => {
    const media = v.media as string;
    const got = normalizeMediaType(media);
    if (v.accepted) {
      expect(got).toEqual({ ok: true, mediaType: media }); // admitted strings pass through unchanged
      return;
    }
    // The chain never lowercases; planning does, for the type and subtype only. Everything else stays refused, with
    // the chain's own code.
    const lowered = media.replace(/^[^;]*/, (h) => h.replace(/[A-Z]/g, (c) => c.toLowerCase()));
    if (lowered !== media && mediaTypeRefusal(mediaTypeBytes(lowered)) === 0) {
      expect(got).toEqual({ ok: true, mediaType: lowered });
      return;
    }
    expect(got.ok).toBe(false);
    expect(got.ok === false && got.code).toBe(v.grammarCode);
    expect(got.ok === false && got.reason.length > 0).toBe(true);
  });

  it.each(encodings)("encoding: $label ($type)", (v) => {
    const i = v.inputs;
    const body =
      v.type === "files-content/1"
        ? encode.content(
            i.bytesRef as Hex,
            BigInt(i.carrier as number),
            BigInt(i.length),
            i.sha256,
            i.media,
          )
        : encode.external(
            i.sentinel as Hex,
            BigInt(i.length),
            i.sha256,
            i.locator as string,
            i.media,
          );
    expect(bytesToHex(body)).toBe(v.body);
    expect(body.length).toBe(v.bodyLength);
    expect(recordId(v.typeId, body)).toBe(v.recordId);
    if (v.type === "files-content/1")
      expect(decodeContent(body)).toMatchObject({
        bytesRef: i.bytesRef,
        length: BigInt(i.length),
        sha256: i.sha256,
        cipher: 0n,
        mediaType: i.media,
      });
    else
      expect(decodeExternal(body)).toMatchObject({
        length: BigInt(i.length),
        sha256: i.sha256,
        locator: i.locator,
        mediaType: i.media,
      });
  });
});

describe("media-type decoding and encoding refusals", () => {
  const content = encodings.find((v) => v.type === "files-content/1" && v.inputs.media === "");
  const external = encodings.find((v) => v.type === "files-external/1" && v.inputs.media === "");
  const withTail = (body: Hex, tail: Hex) => hexToBytes(`${body}${tail.slice(2)}` as Hex);
  const refused = rules.filter((v) => !v.accepted);

  it("a descriptor whose tail the chain would refuse decodes as malformed, never as a media type", () => {
    if (!content || !external) throw new Error("vectors lack the empty-media encodings");
    for (const v of refused) {
      expect(decodeContent(withTail(content.body, v.mediaHex)), v.label).toBeNull();
      expect(decodeExternal(withTail(external.body, v.mediaHex)), v.label).toBeNull();
    }
    expect(decodeContent(hexToBytes(content.body).subarray(0, 319))).toBeNull(); // shorter than ten words
  });

  it("an external locator length past the body is malformed", () => {
    if (!external) throw new Error("vectors lack the empty-media encodings");
    const b = hexToBytes(external.body);
    b[6 * 32 + 31] = (b[6 * 32 + 31] as number) + 1; // locatorLength one past the end
    expect(decodeExternal(b)).toBeNull();
  });

  it("the encoders refuse a media type the chain would refuse (planning normalizes first)", () => {
    const zero = `0x${"00".repeat(32)}` as Hex;
    for (const m of ["Text/plain", "text/plain\r\nx: y", "a".repeat(256)]) {
      expect(() => encode.content(zero, 0n, 0n, zero, m)).toThrow(EfsFault);
      expect(() => encode.external(zero, 0n, zero, "ar://x", m)).toThrow(EfsFault);
    }
  });

  it("non-ASCII text is refused, never folded or truncated", () => {
    expect(normalizeMediaType("téxt/plain")).toMatchObject({ ok: false, code: 3 }); // "t" is a whole type name
    expect(normalizeMediaType("étext/plain")).toMatchObject({ ok: false, code: 2 });
    expect(normalizeMediaType("text/plain; t=é")).toMatchObject({ ok: false, code: 6 });
    expect(normalizeMediaType("text/plain; t=\u{1F600}")).toMatchObject({ ok: false, code: 6 });
    expect(normalizeMediaType("TEXT/PLAIN; Charset=UTF-8")).toEqual({
      ok: true,
      mediaType: "text/plain; Charset=UTF-8",
    });
  });
});
