// SPDX-License-Identifier: MIT
// Streaming reads against a real fixture chain: verified windows only, the same bytes as readBytes/readRange, a
// lying whole-file claim caught at the end, and cancellation that stops the requests.
import { readFileSync } from "node:fs";
import { sha256 } from "viem";
import { describe, expect, inject, it } from "vitest";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import { EfsFault } from "../../src/core/errors.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { type OpenedFile, openFile, readBytes, readRange } from "../../src/files/bytes.ts";
import { type FileChunks, fileChunks, type StreamFailure } from "../../src/files/stream.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { files: { name: string; subjectId: string }[] };
};
const subject = (name: string) =>
  deployment.seed.files.find((f) => f.name === name)?.subjectId as SubjectId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });

async function opened(name: string): Promise<OpenedFile> {
  const o = await openFile(efs, { kind: "file", subject: subject(name) });
  if (o.status !== "PRESENT") throw new Error(`${name}: ${o.status}`);
  return o.file;
}
async function collect(it: FileChunks): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for await (const p of it) parts.push(p);
  return parts;
}
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function failure(it: FileChunks): Promise<{ parts: Uint8Array[]; failure: StreamFailure }> {
  const parts: Uint8Array[] = [];
  try {
    for await (const p of it) parts.push(p);
  } catch (e) {
    if (e instanceof EfsFault && e.code === "STREAM_FAILED")
      return { parts, failure: e.details as unknown as StreamFailure };
    throw e;
  }
  throw new Error("stream did not fail");
}

describe("fileChunks (fixture)", () => {
  it("streams a span tree in verified windows, byte-identical to readBytes", async () => {
    const file = await opened("big.bin");
    const parts = await collect(fileChunks(efs, file, { windowBytes: 8160 }));
    expect(parts.map((p) => p.length)).toEqual([8160, 8160, 3680]);
    expect(join(parts)).toEqual((await readBytes(efs, file)).bytes);
    expect(join(await collect(fileChunks(efs, file)))).toEqual(join(parts)); // default window: one pull
  });

  it("streams a range across a chunk edge, byte-identical to readRange", async () => {
    const file = await opened("big.bin");
    const r = await readRange(efs, file, { offset: 8150n, length: 20n });
    expect(join(await collect(fileChunks(efs, file, { offset: 8150n, length: 20n })))).toEqual(
      r.bytes,
    );
    expect(await collect(fileChunks(efs, file, { offset: 20_000n }))).toEqual([]);
    expect(await collect(fileChunks(efs, file, { length: 0n }))).toEqual([]);
    expect(() => fileChunks(efs, file, { offset: -1n })).toThrow(/non-negative/);
  });

  it("streams an inline file as its verified bytes", async () => {
    const parts = await collect(fileChunks(efs, await opened("readme.txt")));
    expect(new TextDecoder().decode(join(parts))).toBe("Meeting at 10:00.\n");
  });

  it("a whole-file stream checks the author's sha256 claim at the end, as readBytes does", async () => {
    const file = await opened("big.bin");
    const lying = { ...file, sha256: `0x${"00".repeat(32)}` as Hex };
    const { parts, failure: f } = await failure(fileChunks(efs, lying, { windowBytes: 8160 }));
    expect(join(parts).length).toBe(20_000); // every emitted chunk was itself verified
    expect(f).toMatchObject({ grade: "MISMATCH", emitted: 20_000n });
    expect((await readBytes(efs, lying)).grade).toBe("MISMATCH");
    // A range is not the whole file, so (as with readRange) the claim is not in play.
    expect((await collect(fileChunks(efs, lying, { length: 10n })))[0]?.length).toBe(10);
  });

  it("cancelling stops the requests; the caller's signal aborts the stream", async () => {
    let requests = 0;
    const counted = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      onRequest: () => {
        requests++;
      },
    });
    const file = await opened("big.bin");
    const it = fileChunks(counted, file, { windowBytes: 8160 });
    expect((await it.next()).value?.length).toBe(8160);
    await it.return();
    const after = requests;
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(requests).toBe(after);

    const ctl = new AbortController();
    const aborting = fileChunks(efs, file, { windowBytes: 8160, signal: ctl.signal });
    await aborting.next();
    ctl.abort(new Error("user left the page"));
    await expect(aborting.next()).rejects.toMatchObject({ name: "EfsFault", code: "ABORTED" });
  });

  it("external files: verified before anything is emitted; failures name their grade", async () => {
    const text = new TextEncoder().encode("hello from a gateway\n");
    const file: OpenedFile = {
      file: `0x${"01".repeat(32)}` as SubjectId,
      revision: `0x${"02".repeat(32)}` as RecordId,
      author: null,
      size: BigInt(text.length),
      sha256: sha256(text),
      layout: "external",
      locations: [{ scheme: "https", uri: "https://files.example/hello.txt" }],
    };
    const serving = (body: Uint8Array) =>
      createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: (async () => ({
          ok: true,
          status: 200,
          headers: { get: () => String(body.length) },
          text: async () => "",
          arrayBuffer: async () => body.slice().buffer,
        })) as FetchLike,
      });
    const parts = await collect(fileChunks(serving(text), file, { windowBytes: 8 }));
    expect(join(parts)).toEqual(text);
    const bad = await failure(
      fileChunks(serving(new TextEncoder().encode("tampered bytes here!!\n")), file),
    );
    expect(bad.parts).toEqual([]);
    expect(bad.failure).toMatchObject({ grade: "MISMATCH", emitted: 0n });
    const web3 = await failure(fileChunks(efs, await opened("remote.txt")));
    expect(web3.failure.grade).toBe("UNSUPPORTED_LOCATOR");
  });
});
