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

describe("deployment kernel floor", () => {
  const doc = raw as unknown as {
    index: { workModel?: Record<string, number> };
    limits: Record<string, number>;
    typeIds: Record<string, string>;
  };
  it("reads the work model, the floor limits, and each Type's references and digest specs", () => {
    const f = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment: raw }).deployment.kernelFloor;
    expect(f?.workModel).toEqual(doc.index.workModel);
    expect(f).toMatchObject({
      floorFreshGas: doc.limits["floorFreshGas"],
      floorRewriteGas: doc.limits["floorRewriteGas"],
      kernelTail: doc.limits["kernelTail"],
      maxRefs: doc.limits["maxRefs"],
    });
    const id = (name: string) => (doc.typeIds[name] as string).toLowerCase();
    expect(f?.types[id("files-span/1")]).toEqual({ refs: 2, specs: 0 });
    expect(f?.types[id("files-content/1")]).toEqual({ refs: 1, specs: 1 });
    expect(f?.types[id("files-bytes/1")]).toEqual({ refs: 0, specs: 0 });
  });

  it("is null when the document records no work model, and a malformed one is refused", () => {
    const none = structuredClone(doc);
    delete none.index.workModel;
    expect(
      createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment: none }).deployment.kernelFloor,
    ).toBeNull();
    const bad = structuredClone(doc);
    (bad.index.workModel as Record<string, unknown>)["computeBase"] = "lots";
    expect(() => createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment: bad })).toThrow(
      /index.workModel.computeBase/,
    );
  });
});
