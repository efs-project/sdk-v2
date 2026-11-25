// SPDX-License-Identifier: MIT
// Structured send reasons: a revert is decoded only as far as the vendored tables allow (never a guessed name), and a
// wallet that moved off the plan's chain or account says exactly what it should be on.
import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { decodeRevert } from "../src/actions/index.ts";
import { walletMismatch } from "../src/actions/send.ts";
import type { Hex } from "../src/core/hex.ts";
import { errorAbi } from "../src/generated/abis.ts";
import { ERROR_CATALOG } from "../src/generated/errors.ts";

const casSelector = Object.entries(ERROR_CATALOG).find(([, e]) => e.name === "E_CAS")?.[0] as Hex;
const KEY = `0x${"ab".repeat(32)}` as Hex;

describe("decodeRevert", () => {
  it("names a vendored error and decodes its arguments", () => {
    const data = encodeErrorResult({ abi: errorAbi, errorName: "E_CAS", args: [KEY, 3n, 4n] });
    expect(decodeRevert(data)).toEqual({
      selector: casSelector,
      error: "E_CAS",
      args: [KEY, 3n, 4n],
    });
  });

  it("keeps the vendored name but drops arguments that do not decode", () => {
    expect(decodeRevert(`${casSelector}00`)).toEqual({ selector: casSelector, error: "E_CAS" });
  });

  it("reports an unknown selector without a name", () => {
    expect(decodeRevert("0xdeadbeef")).toEqual({ selector: "0xdeadbeef" });
    expect(decodeRevert("0xDEADBEEF00")).toEqual({ selector: "0xdeadbeef" });
  });

  it("is null for anything that is not revert data", () => {
    for (const d of [undefined, 7, "0x", "0x1234", "deadbeef00", "0xzzzzzzzz"])
      expect(decodeRevert(d)).toBeNull();
  });
});

describe("walletMismatch", () => {
  const plan = { chainId: 31337, account: "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Hex };

  it("is null when the wallet is on the plan's chain and account", () => {
    expect(
      walletMismatch(plan, 31337, ["0x0000000000000000000000000000000000000001", plan.account]),
    ).toBeNull();
  });

  it("says what the plan needs and what the wallet is on", () => {
    expect(walletMismatch(plan, 1, [plan.account])).toEqual({
      code: "WALLET_MISMATCH",
      retry: "transient",
      detail: `wallet is on chain 1, plan is for 31337`,
      wallet: { expected: plan, actual: { chainId: 1, account: plan.account } },
    });
    const other = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Hex;
    expect(walletMismatch(plan, 31337, [other])?.wallet).toEqual({
      expected: plan,
      actual: { chainId: 31337, account: other },
    });
    // Only the chain is wrong: the plan's account is still connected, so `actual` does not read as an account change.
    expect(walletMismatch(plan, 1, [other, plan.account])?.wallet?.actual).toEqual({
      chainId: 1,
      account: plan.account,
    });
    expect(walletMismatch(plan, 31337, [])?.wallet?.actual).toEqual({
      chainId: 31337,
      account: null,
    });
  });
});
