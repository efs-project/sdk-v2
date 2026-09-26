// SPDX-License-Identifier: MIT
// S0 placeholder test: proves the Node test runner works. See LIMITATIONS.md.
import { describe, expect, it } from "vitest";
import { smoke } from "../src/index.ts";
import { smoke as nodeSmoke } from "../src/node/index.ts";

describe("S0 smoke (node)", () => {
  it("runs the portable and node placeholders", () => {
    expect(smoke).toBe("efs-sdk smoke placeholder");
    expect(nodeSmoke).toBe("efs-sdk/node smoke placeholder");
  });
});
