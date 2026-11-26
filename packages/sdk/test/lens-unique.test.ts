// SPDX-License-Identifier: MIT
// A Lens names each principal once: the reads lowercase and de-duplicate a hand-built Lens before any reader sees it
// (the topic readers' `mine` takes "each principal once" as a precondition), keeping the first place of each.
import { describe, expect, it } from "vitest";
import { type PrincipalId, uniquePrincipals } from "../src/core/hex.ts";

const p = (b: string) => `0x${"0".repeat(24)}${b.repeat(20)}` as PrincipalId;

describe("uniquePrincipals", () => {
  it("keeps each principal once, at its first place, lowercased", () => {
    const a = p("ab");
    const b = p("cd");
    const A = a.replace(/ab/g, "AB") as PrincipalId;
    expect(uniquePrincipals([a, b, A, b, a])).toEqual([a, b]);
    expect(uniquePrincipals([A])).toEqual([a]);
    expect(uniquePrincipals([])).toEqual([]);
  });
});
