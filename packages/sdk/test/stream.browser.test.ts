// SPDX-License-Identifier: MIT
// streamFile in real Chromium, against a recorded RPC transcript (no chain): a ReadableStream of verified bytes.
import { describe, expect, it } from "vitest";
import deployment from "../fixtures/rpc/deployment.json" with { type: "json" };
import span from "../fixtures/rpc/open-span.json" with { type: "json" };
import { createEfs } from "../src/client.ts";
import type { SubjectId } from "../src/core/hex.ts";
import { openFile } from "../src/files/bytes.ts";
import { type RpcTranscript, replayFetch } from "../src/testing/index.ts";
import { streamFile } from "../src/web/stream.ts";

const transcript = span as unknown as RpcTranscript;

describe("streamFile (browser, replayed chain)", () => {
  it("reads a span file through a ReadableStream, verified, with every RPC call answered", async () => {
    const f = replayFetch(transcript);
    const efs = createEfs({ rpcs: ["https://rpc.example.net/"], deployment, fetch: f });
    const o = await openFile(efs, { kind: "file", subject: transcript.ids["file"] as SubjectId });
    if (o.status !== "PRESENT") throw new Error(o.status);
    const reader = streamFile(efs, o.file, { windowBytes: 8160 }).getReader();
    let total = 0;
    let pulls = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      pulls++;
    }
    expect(total).toBe(20_000);
    expect(pulls).toBe(3);
    expect(f.replay.misses).toEqual([]);
  });

  it("cancel() ends the stream", async () => {
    const efs = createEfs({
      rpcs: ["https://rpc.example.net/"],
      deployment,
      fetch: replayFetch(transcript),
    });
    const o = await openFile(efs, { kind: "file", subject: transcript.ids["file"] as SubjectId });
    if (o.status !== "PRESENT") throw new Error(o.status);
    const stream = streamFile(efs, o.file, { windowBytes: 8160 });
    const reader = stream.getReader();
    expect((await reader.read()).value?.length).toBe(8160);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
  });
});
