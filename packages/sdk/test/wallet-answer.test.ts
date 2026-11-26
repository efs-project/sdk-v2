// SPDX-License-Identifier: MIT
// Which sends a "wallet-answer" progress event reports (walletAnswer, src/actions/sequence.ts): an AMBIGUOUS send whose
// reason is one of exactly four codes, those that mean the wallet or its node answered. Any other reason, a future
// AMBIGUOUS code included, emits nothing until someone decides it should.
import { describe, expect, it } from "vitest";
import { WALLET_ANSWER_CODES, walletAnswer } from "../src/actions/sequence.ts";
import { reason } from "../src/core/errors.ts";

describe("walletAnswer", () => {
  it("the four codes, on an AMBIGUOUS send, and only those", () => {
    expect([...WALLET_ANSWER_CODES]).toEqual([
      "INSUFFICIENT_FUNDS",
      "WALLET_DISCONNECTED",
      "WALLET_CHAIN_DISCONNECTED",
      "RESPONSE_LOST",
    ]);
    for (const code of WALLET_ANSWER_CODES) {
      const why = reason(code, "after-reconcile", "x");
      expect(walletAnswer({ status: "AMBIGUOUS", reason: why }), code).toBe(why);
    }
  });

  it("any other AMBIGUOUS reason emits nothing, a future code included", () => {
    for (const code of ["ALREADY_ATTEMPTED", "JOURNAL_UNAVAILABLE", "BEHIND", "SOMETHING_NEW"])
      expect(
        walletAnswer({ status: "AMBIGUOUS", reason: reason(code, "after-reconcile") }),
        code,
      ).toBeNull();
  });

  it("not AMBIGUOUS, or no reason: nothing", () => {
    const funds = reason("INSUFFICIENT_FUNDS", "after-reconcile");
    for (const status of ["SUBMITTED", "NOT_SENT", "STALE", "BUSY"])
      expect(walletAnswer({ status, reason: funds }), status).toBeNull();
    expect(walletAnswer({ status: "AMBIGUOUS" })).toBeNull();
  });
});
