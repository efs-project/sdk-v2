// SPDX-License-Identifier: MIT
// The public root entry imports cleanly and exposes the stable surface. The node subpath is still an S0 placeholder.
import { describe, expect, it } from "vitest";
import { checkName, checksumAddress, createEfs, PROTOCOL_INPUTS } from "../src/index.ts";
import { smoke as nodeSmoke } from "../src/node/index.ts";

describe("root entry", () => {
  it("exposes the stable surface", () => {
    expect(checkName("readme.txt").status).toBe("VALID");
    expect(checksumAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
    expect(typeof createEfs).toBe("function");
    expect(PROTOCOL_INPUTS.contractsCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(nodeSmoke).toBe("efs-sdk/node smoke placeholder");
  });
  it("refuses an invalid deployment document as misuse", () => {
    expect(() =>
      createEfs({ rpcs: ["http://127.0.0.1:1"], deployment: { schema: "nope" } }),
    ).toThrow(/invalid deployment document/);
  });
});
