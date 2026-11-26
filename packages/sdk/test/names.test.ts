// SPDX-License-Identifier: MIT
// files-name/3 against the contracts' own vectors (test/vectors/names.json, 653 names: every ASCII byte alone and in a
// name, the rulings' examples, and the naming experiment's 50), and the segment codecs against the naming experiment's
// vectors (an independent JS oracle whose verdicts the Solidity rule was first measured against).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import vectors from "../../../conformance/vectors/names.json" with { type: "json" };
import { bytesToHex, type Hex, hexToBytes } from "../src/core/hex.ts";
import { checkName, NAME_PROFILE, type NameRule, normalizeName } from "../src/names/name.ts";
import { displaySegment, parseSegment, wireSegment } from "../src/names/segment.ts";
import { recordId } from "../src/protocol/keys.ts";

const IN = join(import.meta.dirname, "../../../protocol-inputs/contracts/test/vectors");
const chain = JSON.parse(readFileSync(join(IN, "names.json"), "utf8")) as {
  typeIds: Record<string, Hex>;
  grammar: { asciiRefused: string };
  names: {
    label: string;
    hex: Hex;
    valid: boolean;
    ruleCode: number;
    reason?: string;
    role: Hex;
    recordId?: Hex;
  }[];
};
/** The chain's first failed check (names.json `reason`) for each of the SDK's rules. */
const REASON: Record<NameRule, string> = {
  empty: "length",
  "too-long": "length",
  "reserved-prefix": "reserved-prefix",
  "reserved-character": "ascii",
  // a C0 control or DEL is the chain's "ascii" check, a C1 control or another excluded scalar its "excluded"
  "excluded-character": "ascii|excluded",
  "malformed-utf8": "utf8",
  "trailing-dot": "trailing-dot",
  "leading-whitespace": "whitespace",
  "trailing-whitespace": "whitespace",
};

describe("files-name/3 (the chain's vectors)", () => {
  it("is the profile the vectors name", () => {
    expect(Object.keys(chain.typeIds)).toEqual([NAME_PROFILE]);
  });
  it.each(chain.names)("$label: $valid", ({ hex, valid, ruleCode, reason, role, recordId: id }) => {
    const bytes = hexToBytes(hex);
    const r = checkName(bytes);
    expect(r.status === "VALID").toBe(valid);
    expect(ruleCode).toBe(valid ? 0 : 2);
    expect(keccak256(bytes)).toBe(role);
    if (r.status === "VALID" && id)
      expect(recordId(chain.typeIds[NAME_PROFILE] as Hex, bytes)).toBe(id);
    if (r.status === "INVALID") expect(reason).toMatch(new RegExp(`^(${REASON[r.rule]})$`));
  });
  it("every printable ASCII character: refused exactly when the chain reserves it", () => {
    for (let c = 0x20; c < 0x7f; c++) {
      const r = checkName(new Uint8Array([0x61, c, 0x62]));
      const reserved = chain.grammar.asciiRefused.includes(String.fromCharCode(c));
      expect(r.status === "VALID", `0x${c.toString(16)}`).toBe(!reserved);
      if (reserved) expect(r).toEqual({ status: "INVALID", rule: "reserved-character", at: 1 });
    }
  });
});

describe("files-name/3", () => {
  for (const v of vectors.vectors) {
    it(`${v.note}: the same name and role as the experiment`, () => {
      const bytes = hexToBytes(v.hex as Hex);
      expect(keccak256(bytes)).toBe(v.role);
      const r = checkName(bytes);
      if (r.status === "VALID") expect(r.nfc).toBe(v.nfc);
    });
  }
  it("never normalizes: composed and decomposed are different valid names", () => {
    const composed = checkName("caf\u00e9.txt");
    const decomposed = checkName("cafe\u0301.txt");
    expect(composed.status).toBe("VALID");
    expect(decomposed.status).toBe("VALID");
    if (composed.status === "VALID" && decomposed.status === "VALID") {
      expect(bytesToHex(composed.bytes)).not.toBe(bytesToHex(decomposed.bytes));
      expect(decomposed.nfc).toBe(false);
    }
    expect(normalizeName("cafe\u0301.txt")).toBe("caf\u00e9.txt");
  });
  it("reports the rule that failed, in the chain's order", () => {
    expect(checkName("")).toEqual({ status: "INVALID", rule: "empty" });
    expect(checkName("..")).toEqual({ status: "INVALID", rule: "trailing-dot" });
    expect(checkName("inc.")).toEqual({ status: "INVALID", rule: "trailing-dot" });
    expect(checkName("~efs-x")).toEqual({ status: "INVALID", rule: "reserved-prefix" });
    expect(checkName("~efs#.")).toEqual({ status: "INVALID", rule: "reserved-prefix" });
    expect(checkName(" a")).toEqual({ status: "INVALID", rule: "leading-whitespace" });
    expect(checkName(" a.")).toEqual({ status: "INVALID", rule: "trailing-dot" });
    expect(checkName("Q&A #3.pdf")).toEqual({
      status: "INVALID",
      rule: "reserved-character",
      at: 4,
    });
    expect(checkName("a/b")).toEqual({ status: "INVALID", rule: "reserved-character", at: 1 });
    expect(checkName("a\u0001b")).toEqual({ status: "INVALID", rule: "excluded-character", at: 1 });
    // the scan decides in byte order: a reserved character before malformed UTF-8 is reserved-character
    expect(checkName(new Uint8Array([0x23, 0xc0, 0xaf]))).toEqual({
      status: "INVALID",
      rule: "reserved-character",
      at: 0,
    });
    expect(checkName(new Uint8Array([0xc0, 0xaf]))).toEqual({
      status: "INVALID",
      rule: "malformed-utf8",
    });
    for (const ok of [
      "Q&A 3.pdf",
      "logo@2x.png",
      "~$Budget.xlsx",
      "Sale!.png",
      "-notes.txt",
      "con",
      "nul.txt",
    ])
      expect(checkName(ok).status, ok).toBe("VALID");
    expect(checkName("x", "files-name/2")).toEqual({
      status: "UNSUPPORTED_BY_PROFILE",
      profile: "files-name/2",
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
