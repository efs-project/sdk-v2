// SPDX-License-Identifier: MIT
// The shipped RPC transcripts replay the real SDK with no chain: every call is answered, every outcome reproduces.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWriter, memoryJournal } from "../src/actions/index.ts";
import { createEfs } from "../src/client.ts";
import type { RecordId, SubjectId } from "../src/core/hex.ts";
import { openFile, readBytes, readRange } from "../src/files/bytes.ts";
import { planEditFile } from "../src/files/edit.ts";
import {
  createRpcReplay,
  type RpcTranscript,
  replayFetch,
  replayProvider,
} from "../src/testing/index.ts";

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
  it("ships the read and edit-flow cases and the deployment document", () => {
    expect(readdirSync(DIR).sort()).toEqual(
      [
        "deployment",
        "edit-confirming-final",
        "edit-one-approval",
        "edit-reload-resume",
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

/**
 * The edit flows, replayed exactly as their `steps` say: both halves chain-free (replayFetch for the RPC half,
 * replayProvider as the wallet), with a journal that outlives the "page reload". This is the client's e2e in small.
 */
describe("edit-flow transcript replay (RPC and wallet halves)", () => {
  const session = (fetch: ReturnType<typeof replayFetch>) =>
    createEfs({ rpcs: [RPC], deployment, fetch });
  const edit = async (
    t: RpcTranscript,
    efs: ReturnType<typeof createEfs>,
    writer: Parameters<typeof planEditFile>[1],
  ) => {
    const file = { kind: "file" as const, subject: t.ids["file"] as SubjectId };
    const opened = await openFile(efs, file);
    if (opened.status !== "PRESENT") throw new Error(opened.status);
    expect(opened.file.revision).toBe(t.ids["base"]);
    const r = await planEditFile(efs, writer, {
      file,
      base: { kind: "revision", recordId: opened.file.revision as RecordId },
      content: new TextEncoder().encode(t.ids["text"]),
    });
    if (r.status !== "PLANNED") throw new Error(r.status);
    expect(r.review.revision).toBe(t.ids["revision"]);
    return r;
  };

  it("edit-one-approval: one approval, COMPLETE (confirming), and the new HEAD reads back", async () => {
    const t = load("edit-one-approval");
    const fetch = replayFetch(t);
    const wallet = replayProvider(t);
    const efs = session(fetch);
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
      journal: memoryJournal(),
    });
    const r = await edit(t, efs, writer);
    expect(await writer.runSequence(r.parts)).toMatchObject({ state: "COMPLETE", final: false });
    const after = await openFile(efs, { kind: "file", subject: t.ids["file"] as SubjectId });
    if (after.status !== "PRESENT") throw new Error(after.status);
    expect(after.file.revision).toBe(t.ids["revision"]);
    const bytes = await readBytes(efs, after.file);
    expect(new TextDecoder().decode(bytes.bytes)).toBe(t.ids["text"]);
    expect([fetch.replay.misses, wallet.misses]).toEqual([[], []]);
  });

  it("edit-reload-resume: a lost response and a reload settle from the ledger, never sent twice", async () => {
    const t = load("edit-reload-resume");
    const fetch = replayFetch(t);
    const wallet = replayProvider(t);
    const journal = memoryJournal(); // survives the reload, like the client's IndexedDB journal
    const efs1 = session(fetch); // page load 1
    const w1 = await createWriter(efs1, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
      journal,
    });
    const r = await edit(t, efs1, w1);
    expect(await w1.runSequence(r.parts, { settleMs: 0 })).toMatchObject({
      state: "IN_FLIGHT",
      committed: 0,
    });
    // page load 2: a new client and writer over the same journal
    const w2 = await createWriter(session(fetch), {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
      journal,
    });
    const [open] = await w2.pendingSequences();
    expect(open).toMatchObject({ state: "IN_FLIGHT", committed: 0, total: 1 });
    if (!open) return;
    expect(await w2.resume(open.sequenceId)).toMatchObject({ state: "COMPLETE", final: false });
    const sends = t.wallet?.filter((c) => c.method === "eth_sendTransaction") ?? [];
    expect(sends).toHaveLength(1);
    expect([fetch.replay.misses, wallet.misses]).toEqual([[], []]);
  });

  it("edit-confirming-final: COMPLETE turns final once its block is finalized", async () => {
    const t = load("edit-confirming-final");
    const fetch = replayFetch(t);
    const wallet = replayProvider(t);
    const efs = session(fetch);
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
      journal: memoryJournal(),
    });
    const r = await edit(t, efs, writer);
    const saved = await writer.runSequence(r.parts);
    expect(saved).toMatchObject({ state: "COMPLETE", final: false });
    expect(await writer.reconcileSequence(saved.sequenceId)).toMatchObject({
      state: "COMPLETE",
      final: true,
    });
    expect(await writer.pendingSequences()).toEqual([]);
    expect([fetch.replay.misses, wallet.misses]).toEqual([[], []]);
  });
});
