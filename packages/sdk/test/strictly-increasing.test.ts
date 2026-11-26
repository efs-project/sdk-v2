// SPDX-License-Identifier: MIT
// strictlyIncreasing (src/protocol/status.ts): every list slice the SDK reads must strictly increase, so a duplicate
// or a reordered entry from an endpoint is refused (the read-validation audit, 2026-11-26).
import { describe, expect, it } from "vitest";
import { strictlyIncreasing } from "../src/protocol/status.ts";

describe("strictlyIncreasing", () => {
  it("accepts empty, one, and rising lists", () => {
    expect(strictlyIncreasing([])).toBe(true);
    expect(strictlyIncreasing([5n])).toBe(true);
    expect(strictlyIncreasing([1n, 2n, 9n, 10n])).toBe(true);
    expect(strictlyIncreasing([1, 2, 3])).toBe(true);
  });
  it("refuses a duplicate and a reordering", () => {
    expect(strictlyIncreasing([1n, 1n])).toBe(false);
    expect(strictlyIncreasing([1n, 3n, 2n])).toBe(false);
    expect(strictlyIncreasing([4n, 3n])).toBe(false);
  });
});
