// SPDX-License-Identifier: MIT
// A headsAt reply is used only when its own selection is what the Lens law gives for the heads it returned, so an
// endpoint cannot name a different author (or hide a mask) than its own heads say.
import { describe, expect, it } from "vitest";
import { selectionAgrees } from "../src/files/folders.ts";

describe("selectionAgrees (the Lens law over a headsAt reply)", () => {
  it("accepts the first BOUND or MASKED head in Lens order, with the matching status", () => {
    expect(selectionAgrees("PRESENT", 0, ["BOUND", "BOUND"])).toBe(true);
    expect(selectionAgrees("PRESENT", 1, ["RELEASED", "BOUND"])).toBe(true); // released falls through
    expect(selectionAgrees("PRESENT", 2, ["UNSET", "RELEASED", "BOUND"])).toBe(true);
    expect(selectionAgrees("MASKED", 0, ["MASKED", "BOUND"])).toBe(true); // a mask beats fall-through
    expect(selectionAgrees("ABSENT_PROVEN", 0, ["UNSET", "RELEASED"])).toBe(true);
  });

  it("refuses a selection that skips an earlier head, mislabels it, or invents one", () => {
    expect(selectionAgrees("PRESENT", 1, ["BOUND", "BOUND"])).toBe(false); // picked the second author
    expect(selectionAgrees("PRESENT", 1, ["MASKED", "BOUND"])).toBe(false); // hid a mask
    expect(selectionAgrees("PRESENT", 0, ["MASKED", "BOUND"])).toBe(false); // a mask called PRESENT
    expect(selectionAgrees("MASKED", 0, ["BOUND"])).toBe(false);
    expect(selectionAgrees("ABSENT_PROVEN", 0, ["BOUND"])).toBe(false); // absence despite a bound head
    expect(selectionAgrees("PRESENT", 0, ["UNSET"])).toBe(false);
  });
});
