// SPDX-License-Identifier: MIT
// The contracts' final step (3ca53ba) adds kernel reason E_INDEX_NOT_READY(14), E_PIN code 12 and a wider
// E_BUILD(7): operator and activation paths, never a client's. The vendored catalog names them, decodes their
// arguments, and classes them as the contracts do (retry class "none": nothing a client retries).
import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { decodeRevert } from "../src/actions/send.ts";
import { errorAbi } from "../src/generated/abis.ts";
import { ERROR_CATALOG } from "../src/generated/errors.ts";

const entry = (name: string) => Object.values(ERROR_CATALOG).find((e) => e.name === name);
const ADDR = "0x1111111111111111111111111111111111111111";

describe("the final step's error codes", () => {
  it("E_INDEX_NOT_READY reason 14: a stale or altered copy of the live index's manifest", () => {
    const data = encodeErrorResult({
      abi: errorAbi,
      errorName: "E_INDEX_NOT_READY",
      args: [14],
    } as never);
    expect(decodeRevert(data)).toMatchObject({ error: "E_INDEX_NOT_READY", args: [14] });
    expect(entry("E_INDEX_NOT_READY")).toMatchObject({ retryClass: "none" });
    expect(entry("E_INDEX_NOT_READY")?.meaning).toMatch(/14 the candidate carries a store/);
  });

  it("E_PIN code 12: a manifest copy too large to hold", () => {
    const data = encodeErrorResult({
      abi: errorAbi,
      errorName: "E_PIN",
      args: [ADDR, 12],
    } as never);
    expect(decodeRevert(data)).toMatchObject({ error: "E_PIN", args: [ADDR, 12] });
    expect(entry("E_PIN")).toMatchObject({ retryClass: "none" });
    expect(entry("E_PIN")?.meaning).toMatch(
      /12 the reads contract's copy of the live index's manifest/,
    );
  });

  it("E_BUILD(7) now also covers the generation's copy of the live manifest", () => {
    const data = encodeErrorResult({ abi: errorAbi, errorName: "E_BUILD", args: [7] } as never);
    expect(decodeRevert(data)).toMatchObject({ error: "E_BUILD", args: [7] });
    expect(entry("E_BUILD")).toMatchObject({ retryClass: "none" });
    expect(entry("E_BUILD")?.meaning).toMatch(
      /7 the carried check fails .*copy of the live index's manifest/,
    );
  });
});
