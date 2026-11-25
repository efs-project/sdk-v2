// SPDX-License-Identifier: MIT
// What a link costs on the wire: HTTP requests (round trips) and JSON-RPC calls, cold (a fresh client) and warm (the
// same client again). A file link routed through openObject must cost no more round trips than openFile alone, and a
// folder link no more than the kind read. A regression here is a slower first paint of every link.
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { openObject } from "../../src/files/folders.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex }; files: { name: string; subjectId: SubjectId }[] };
};
const file = deployment.seed.files.find((f) => f.name === "readme.txt")?.subjectId as SubjectId;
const folder = deployment.seed.folder.directoryRecordId;

/** A client whose wire traffic is counted: one request per fetch, one call per JSON-RPC entry in it. */
function counted() {
  const n = { requests: 0, calls: 0 };
  const fetch: FetchLike = async (url, init) => {
    n.requests += 1;
    const body = JSON.parse(init.body ?? "null");
    n.calls += Array.isArray(body) ? body.length : 1;
    return (globalThis.fetch as unknown as FetchLike)(url, init);
  };
  const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch });
  const measure = async (run: () => Promise<unknown>) => {
    const before = { ...n };
    await run();
    return { requests: n.requests - before.requests, calls: n.calls - before.calls };
  };
  return { efs, measure };
}
const cost = async (run: (efs: ReturnType<typeof createEfs>) => Promise<unknown>) => {
  const c = counted();
  const cold = await c.measure(() => run(c.efs));
  const warm = await c.measure(() => run(c.efs));
  return { cold, warm };
};

describe("what a link costs (fixture)", () => {
  it("a file link through openObject costs no more round trips than openFile", async () => {
    const viaFile = await cost(async (efs) => {
      const o = await openFile(efs, { kind: "file", subject: file });
      expect(o.status).toBe("PRESENT");
    });
    const viaObject = await cost(async (efs) => {
      const o = await openObject(efs, file);
      if (o.status !== "FILE") throw new Error(o.status);
      expect(o.open.status).toBe("PRESENT");
    });
    console.info(
      "openFile",
      JSON.stringify(viaFile),
      "openObject(file)",
      JSON.stringify(viaObject),
    );
    expect(viaObject.warm.requests).toBeLessThanOrEqual(viaFile.warm.requests);
    expect(viaObject.cold.requests).toBeLessThanOrEqual(viaFile.cold.requests);
  });

  it("a folder link: openObject alone", async () => {
    const viaObject = await cost(async (efs) => {
      expect((await openObject(efs, folder)).status).toBe("FOLDER");
    });
    console.info("openObject(folder)", JSON.stringify(viaObject));
    expect(viaObject.warm.requests).toBeLessThanOrEqual(2);
  });
});
