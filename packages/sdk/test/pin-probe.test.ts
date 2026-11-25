// SPDX-License-Identifier: MIT
// The pin's code-hash probe: one deployless eth_call whose returned "code" is the code hashes. EIP-3541 refuses
// returned code that starts with 0xEF, so the hashes follow one zero word (a ledger whose code hash starts with 0xEF,
// as the tag release's does, made every pin UNKNOWN before).
import { describe, expect, it } from "vitest";
import type { Hex } from "../src/core/hex.ts";
import { codehashProbe } from "../src/deployment/pin.ts";

const A = `0x${"aa".repeat(20)}` as Hex;
const B = `0x${"bb".repeat(20)}` as Hex;

describe("the code-hash probe", () => {
  it("stores each hash after a zero word, with 2-byte offsets, and returns them all", () => {
    expect(codehashProbe([A, B])).toBe(
      `0x73${"aa".repeat(20)}3f61002052` + `73${"bb".repeat(20)}3f61004052` + "6100606000f3",
    );
  });
  it("takes the ten contracts the tag release pins in one call", () => {
    const ten = Array.from(
      { length: 10 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex,
    );
    const code = codehashProbe(ten);
    expect(code.endsWith("61016060" + "00f3")).toBe(true); // 11 words: the zero word and ten hashes
    expect(() => codehashProbe(Array.from({ length: 65 }, () => A))).toThrow(RangeError);
  });
});
