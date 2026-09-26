// SPDX-License-Identifier: MIT
// S0 placeholder test: proves the real-browser test runner works. See LIMITATIONS.md.
import { describe, expect, it } from "vitest";
import { smoke } from "../src/web/index.ts";

describe("S0 smoke (browser)", () => {
  it("runs in a real browser with the web placeholder", () => {
    expect(typeof document).toBe("object");
    expect(smoke).toBe("efs-sdk/web smoke placeholder");
  });
});
