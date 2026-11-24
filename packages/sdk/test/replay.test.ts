// SPDX-License-Identifier: MIT
// The shipped RPC transcripts replay the real SDK with no chain: every call is answered, every outcome reproduces.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEfs } from "../src/client.ts";
import type { SubjectId } from "../src/core/hex.ts";
import { openFile, readBytes, readRange } from "../src/files/bytes.ts";
import { createRpcReplay, type RpcTranscript, replayFetch } from "../src/testing/index.ts";

const DIR = join(import.meta.dirname, "../fixtures/rpc");
const load = (n: string) =>
  JSON.parse(readFileSync(join(DIR, `${n}.json`), "utf8")) as RpcTranscript;
const deployment = JSON.parse(readFileSync(join(DIR, "deployment.json"), "utf8")) as unknown;
const RPC = "https://rpc.example.net/";

const client = (t: RpcTranscript) => {
  const f = replayFetch(t);
  return { efs: createEfs({ rpcs: [RPC], deployment, fetch: f }), replay: f.replay };
};

describe("RPC transcript replay", () => {
  it("ships the five cases and the deployment document", () => {
    expect(readdirSync(DIR).sort()).toEqual(
      [
        "deployment",
        "open-absent",
        "open-external-https",
        "open-inline",
        "open-span",
        "pin-verified",
      ].map((n) => `${n}.json`),
    );
  });

  it("pin-verified", async () => {
    const { efs, replay } = client(load("pin-verified"));
    expect((await efs.pin()).status).toBe("VERIFIED");
    expect(replay.misses).toEqual([]);
  });

  it("open-inline → readBytes", async () => {
    const t = load("open-inline");
    const { efs, replay } = client(t);
    const o = await openFile(efs, { kind: "file", subject: t.ids["file"] as SubjectId });
    expect(o.status).toBe("PRESENT");
    if (o.status !== "PRESENT") return;
    const b = await readBytes(efs, o.file);
    expect(b.grade).toBe("VERIFIED");
    expect(b.bytes?.length).toBe(Number(o.file.size));
    expect(replay.misses).toEqual([]);
  });

  it("open-absent", async () => {
    const t = load("open-absent");
    const { efs, replay } = client(t);
    expect(
      (await openFile(efs, { kind: "file", subject: t.ids["file"] as SubjectId })).status,
    ).toBe("ABSENT_PROVEN");
    expect(replay.misses).toEqual([]);
  });

  it("open-span → readRange across a chunk edge → readBytes", async () => {
    const t = load("open-span");
    const { efs, replay } = client(t);
    const o = await openFile(efs, { kind: "file", subject: t.ids["file"] as SubjectId });
    if (o.status !== "PRESENT") throw new Error(o.status);
    expect(o.file.size).toBe(20_000n);
    const r = await readRange(efs, o.file, { offset: 8150n, length: 20n });
    expect(r.grade).toBe("VERIFIED");
    expect(r.bytes?.length).toBe(20);
    expect((await readBytes(efs, o.file)).grade).toBe("VERIFIED");
    expect(replay.misses).toEqual([]);
  });

  it("open-external-https: blocked by default, then allowed for one origin (the https half routed)", async () => {
    const t = load("open-external-https");
    const text = new TextEncoder().encode(t.ids["httpsText"] as string);
    const rpc = replayFetch(t);
    const fetch = (async (url: string, init: { method: string; body?: string }) =>
      url === t.ids["httpsUrl"]
        ? {
            ok: true,
            status: 200,
            headers: { get: (n: string) => (n === "content-length" ? String(text.length) : null) },
            text: async () => "",
            arrayBuffer: async () => text.slice().buffer,
          }
        : rpc(url, init as never)) as never;
    const efs = createEfs({ rpcs: [RPC], deployment, fetch });
    const o = await openFile(efs, { kind: "file", subject: t.ids["file"] as SubjectId });
    if (o.status !== "PRESENT") throw new Error(o.status);
    const blocked = await readBytes(efs, o.file);
    expect(blocked.grade).toBe("POLICY_BLOCKED");
    expect(blocked.blockedOrigins).toEqual(["https://files.example"]);
    expect((await readBytes(efs, o.file, { allowOrigins: ["https://files.example"] })).grade).toBe(
      "VERIFIED",
    );
    expect(rpc.replay.misses).toEqual([]);
  });

  it("a call outside the transcript is a visible miss, answered with a JSON-RPC error and the caller's id", () => {
    const r = createRpcReplay(load("pin-verified"));
    const out = r.answer([
      { jsonrpc: "2.0", id: 41, method: "eth_chainId", params: [] },
      { jsonrpc: "2.0", id: 42, method: "eth_unrecorded", params: [] },
    ]) as { id: number; result?: string; error?: { code: number } }[];
    expect(out.map((x) => x.id)).toEqual([41, 42]);
    expect(out[0]?.result).toMatch(/^0x/);
    expect(out[1]?.error?.code).toBe(-32601);
    expect(r.misses).toEqual(["eth_unrecorded []"]);
  });
});
