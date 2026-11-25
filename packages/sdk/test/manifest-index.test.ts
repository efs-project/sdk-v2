// SPDX-License-Identifier: MIT
// The deployment's index families: the backlink family (kind 5 over the TARGET universe) is read from the document,
// and a document that names none gives null, so a count that can't be read is never reported as zero.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEfs } from "../src/client.ts";

const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as {
  index: { families: { kind: number; universe: number; familyId: string }[] };
};

describe("deployment index families", () => {
  it("names the backlink family from the document", () => {
    const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment: raw });
    const want = raw.index.families
      .find((f) => f.kind === 5 && f.universe === 4)
      ?.familyId.toLowerCase();
    expect(want).toMatch(/^0x[0-9a-f]{64}$/);
    expect(efs.deployment.index.backlinkFamily).toBe(want);
  });

  it("is null when the document names no backlink family", () => {
    const doc = structuredClone(raw);
    doc.index.families = doc.index.families.filter((f) => f.kind !== 5);
    expect(
      createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment: doc }).deployment.index.backlinkFamily,
    ).toBeNull();
  });
});
