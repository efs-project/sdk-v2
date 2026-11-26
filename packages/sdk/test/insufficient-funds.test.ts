// SPDX-License-Identifier: MIT
// A wallet's or node's insufficient-funds refusal (classifyWalletError, src/actions/send.ts): named INSUFFICIENT_FUNDS
// so a page can say "the wallet needs enough to cover the gas limit", never "checking whether the save went out". It
// stays AMBIGUOUS, retry after-reconcile: the refusal comes after signing, and a wallet that queued the signed
// transaction could still send it. It is matched on the words "insufficient funds" in the error's message or a nested
// one (data, cause, originalError, details), whatever the numeric code; a refusal before signing (4001 and the other
// NOT_SENT codes) keeps its own reason. `funds.gasLimit` is the limit the send asked for, when there was one.
import { describe, expect, it } from "vitest";
import { classifyWalletError } from "../src/actions/send.ts";

const fail = (message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), extra);

describe("an insufficient-funds refusal", () => {
  it("geth, reth and anvil's words, at any code: AMBIGUOUS INSUFFICIENT_FUNDS with the gas limit", () => {
    for (const [code, message] of [
      [-32000, "insufficient funds for gas * price + value: balance 1, tx cost 3, overshot 2"],
      [-32003, "Insufficient funds for gas * price + value"],
      [-32603, "insufficient funds for gas * price + value: have 1 want 3"],
      [undefined, "INSUFFICIENT FUNDS"],
    ] as const) {
      const how = classifyWalletError(fail(message, { code }), "eth_sendTransaction", 400_000n);
      expect(how, message).toEqual({
        ambiguous: {
          code: "INSUFFICIENT_FUNDS",
          retry: "after-reconcile",
          detail:
            "the wallet needs enough to cover the gas limit of 400000; a save is charged only the gas it uses",
          funds: { gasLimit: 400_000n },
        },
      });
    }
  });

  it("found in a nested error: data, data.originalError, cause, details", () => {
    const words = "insufficient funds for gas * price + value";
    const shapes: unknown[] = [
      { code: -32603, message: "Internal JSON-RPC error.", data: { message: words } },
      {
        code: -32603,
        message: "Internal JSON-RPC error.",
        data: { originalError: { code: -32000, message: words } },
      },
      fail("Transaction failed.", { cause: fail("RPC error", { details: words }) }),
      { code: -32000, message: "execution failed", data: words },
    ];
    for (const e of shapes)
      expect(classifyWalletError(e, "eth_sendTransaction", 1n)).toMatchObject({
        ambiguous: { code: "INSUFFICIENT_FUNDS" },
      });
  });

  it("without a gas limit (a batch: the wallet sets each call's gas) there is no funds field", () => {
    const how = classifyWalletError(
      fail("insufficient funds for gas * price + value", { code: -32000 }),
      "wallet_sendCalls",
    );
    expect(how).toEqual({
      ambiguous: {
        code: "INSUFFICIENT_FUNDS",
        retry: "after-reconcile",
        detail:
          "the wallet needs enough to cover this transaction's gas limit; a save is charged only the gas it uses",
      },
    });
  });

  it("a refusal before signing keeps its own reason, whatever its words", () => {
    expect(
      classifyWalletError(
        fail("insufficient funds: User rejected the request.", { code: 4001 }),
        "eth_sendTransaction",
        1n,
      ),
    ).toMatchObject({ notSent: { code: "USER_REJECTED" } });
  });

  it("other errors stay RESPONSE_LOST; a cyclic or deep error chain ends", () => {
    expect(
      classifyWalletError(fail("nonce too low", { code: -32000 }), "eth_sendTransaction", 1n),
    ).toMatchObject({ ambiguous: { code: "RESPONSE_LOST" } });
    const loop: Record<string, unknown> = { code: -32000, message: "loop" };
    loop["cause"] = loop;
    loop["data"] = { originalError: loop };
    expect(classifyWalletError(loop, "eth_sendTransaction", 1n)).toMatchObject({
      ambiguous: { code: "RESPONSE_LOST" },
    });
    let deep: Record<string, unknown> = { message: "insufficient funds" };
    for (let i = 0; i < 20; i++) deep = { message: "wrapped", cause: deep };
    expect(classifyWalletError(deep, "eth_sendTransaction", 1n)).toMatchObject({
      ambiguous: { code: "RESPONSE_LOST" }, // past the search depth: not claimed
    });
    expect(classifyWalletError(null, "eth_sendTransaction", 1n)).toMatchObject({
      ambiguous: { code: "RESPONSE_LOST" },
    });
  });
});
