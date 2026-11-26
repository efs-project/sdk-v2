// SPDX-License-Identifier: MIT
// Contracts 6d11858 (formula 3, the registry rule, the kept-index fix; tools/RELEASE.md item 44) adds E_WORK_MODEL, a
// work model the ingress does not implement; E_INDEX_NOT_READY reasons 15 and 16; E_PIN code 13; and E_REPLAY code 10,
// a Type whose descriptor bytes do not hash to its id. Operator, activation and build paths, never a client's own
// send. The vendored catalog names them, decodes their arguments, and classes them as the contracts do ("none").
import { encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { decodeRevert } from "../src/actions/send.ts";
import { errorAbi } from "../src/generated/abis.ts";
import { ERROR_CATALOG } from "../src/generated/errors.ts";

const entry = (name: string) => Object.values(ERROR_CATALOG).find((e) => e.name === name);
const ADDR = "0x1111111111111111111111111111111111111111";
const revert = (errorName: string, args: unknown[]) =>
  decodeRevert(encodeErrorResult({ abi: errorAbi, errorName, args } as never));

describe("formula 3's error codes", () => {
  it("E_WORK_MODEL(code, value): a formula-2 index under a formula-3 ingress is code 2 with 17 words", () => {
    expect(revert("E_WORK_MODEL", [2, 17 * 32])).toMatchObject({
      error: "E_WORK_MODEL",
      args: [2, 544n],
    });
    expect(entry("E_WORK_MODEL")).toMatchObject({ retryClass: "none" });
    expect(entry("E_WORK_MODEL")?.meaning).toMatch(
      /A formula-2 index under a formula-3 ingress is 2/,
    );
  });

  it("E_INDEX_NOT_READY 15 and 16, and reason 2 reworded: the ledger's own publication lock", () => {
    for (const r of [15, 16])
      expect(revert("E_INDEX_NOT_READY", [r])).toMatchObject({
        error: "E_INDEX_NOT_READY",
        args: [r],
      });
    const m = entry("E_INDEX_NOT_READY")?.meaning ?? "";
    expect(m).toMatch(/2 the ledger's own publication lock is not IDLE/);
    expect(m).toMatch(/\b15 /);
    expect(m).toMatch(/\b16 /);
  });

  it("E_PIN 13 and E_REPLAY 10", () => {
    expect(revert("E_PIN", [ADDR, 13])).toMatchObject({ error: "E_PIN", args: [ADDR, 13] });
    expect(entry("E_PIN")?.meaning).toMatch(/\b13 /);
    expect(revert("E_REPLAY", [10])).toMatchObject({ error: "E_REPLAY", args: [10] });
    expect(entry("E_REPLAY")?.meaning).toMatch(/10 a PUBLISH\/REUSE record's Type/);
    expect(entry("E_REPLAY")).toMatchObject({ retryClass: "none" });
  });
});
