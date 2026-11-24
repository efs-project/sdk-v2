// SPDX-License-Identifier: MIT
// files-name/2 and the segment codecs against the naming experiment's 50 vectors (an independent JS oracle whose
// verdicts the Solidity rule was measured against).

import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import vectors from "../../../conformance/vectors/names.json" with { type: "json" };
import { bytesToHex, type Hex, hexToBytes } from "../src/core/hex.ts";
import { checkName, normalizeName } from "../src/names/name.ts";
import { displaySegment, parseSegment, wireSegment } from "../src/names/segment.ts";

describe("files-name/2", () => {
  for (const v of vectors.vectors) {
    it(`${v.note}: ${v.v2 ? "valid" : "invalid"}`, () => {
      const bytes = hexToBytes(v.hex as Hex);
      const r = checkName(bytes);
      expect(r.status === "VALID").toBe(v.v2);
      expect(keccak256(bytes)).toBe(v.role);
      if (r.status === "VALID") expect(r.nfc).toBe(v.nfc);
    });
  }
  it("never normalizes: composed and decomposed are different valid names", () => {
    const composed = checkName("café.txt");
    const decomposed = checkName("café.txt");
    expect(composed.status).toBe("VALID");
    expect(decomposed.status).toBe("VALID");
    if (composed.status === "VALID" && decomposed.status === "VALID") {
      expect(bytesToHex(composed.bytes)).not.toBe(bytesToHex(decomposed.bytes));
      expect(decomposed.nfc).toBe(false);
    }
    expect(normalizeName("café.txt")).toBe("café.txt");
  });
  it("reports the rule that failed", () => {
    expect(checkName("")).toEqual({ status: "INVALID", rule: "empty" });
    expect(checkName("..")).toEqual({ status: "INVALID", rule: "dot-or-dotdot" });
    expect(checkName("~efs-x")).toEqual({ status: "INVALID", rule: "reserved-prefix" });
    expect(checkName(" a")).toEqual({ status: "INVALID", rule: "leading-whitespace" });
    expect(checkName(new Uint8Array([0xc0, 0xaf]))).toEqual({
      status: "INVALID",
      rule: "malformed-utf8",
    });
    expect(checkName("x", "files-name/9")).toEqual({
      status: "UNSUPPORTED_BY_PROFILE",
      profile: "files-name/9",
    });
  });
});

describe("segment codecs", () => {
  for (const v of vectors.vectors.filter((x) => x.v2)) {
    it(`round-trips ${v.note}`, () => {
      const bytes = hexToBytes(v.hex as Hex);
      expect(wireSegment(bytes)).toBe(v.wire);
      expect(displaySegment(v.name)).toBe(v.display);
      for (const form of [v.wire, v.display, encodeURIComponent(v.name)] as string[]) {
        const p = parseSegment(form);
        expect(p.ok && bytesToHex(p.bytes)).toBe(v.hex);
      }
    });
  }
  it("decodes exactly once and refuses malformed input", () => {
    const literal = parseSegment("%252F.txt");
    expect(literal.ok && new TextDecoder().decode(literal.bytes)).toBe("%2F.txt");
    expect(parseSegment("100%")).toEqual({ ok: false, error: "malformed-escape" });
    expect(parseSegment("%C0%AF")).toEqual({ ok: false, error: "malformed-utf8" });
    expect(parseSegment("a/b")).toEqual({ ok: false, error: "slash" });
  });
});
