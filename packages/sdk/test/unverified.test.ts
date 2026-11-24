// SPDX-License-Identifier: MIT
// The unverified opt-in for external files: bytes as they arrive, the grade at the end, fail-over only before the
// first byte, and a final MISMATCH that is loud. No chain needed: an external read makes no RPC calls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "viem";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain/rpc.ts";
import { createEfs } from "../src/client.ts";
import { EfsFault } from "../src/core/errors.ts";
import type { Hex, RecordId, SubjectId } from "../src/core/hex.ts";
import type { OpenedFile } from "../src/files/bytes.ts";
import { type UnverifiedChunks, unverifiedChunks } from "../src/files/unverified.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const enc = (s: string) => new TextEncoder().encode(s);
const CONTENT = [enc("frame-1 "), enc("frame-2 "), enc("frame-3\n")];
const ALL = enc("frame-1 frame-2 frame-3\n");

const external = (...uris: string[]): OpenedFile => ({
  file: `0x${"01".repeat(32)}` as SubjectId,
  revision: `0x${"02".repeat(32)}` as RecordId,
  author: null,
  size: BigInt(ALL.length),
  sha256: sha256(ALL) as Hex,
  layout: "external",
  locations: uris.map((uri) => ({ scheme: "https", uri })),
});

interface Serve {
  status?: number;
  parts?: Uint8Array[];
  length?: number;
  breakAfter?: number;
  hang?: boolean;
}
/** A fake gateway: per URL, a status and a body that arrives in parts. Records what was fetched and cancelled. */
function gateway(routes: Record<string, Serve>) {
  const log = { fetched: [] as string[], cancelled: 0 };
  const fetch: FetchLike = async (url) => {
    log.fetched.push(url);
    const r = routes[url] ?? { status: 404 };
    const parts = r.parts ?? CONTENT;
    const length = r.length ?? parts.reduce((n, p) => n + p.length, 0);
    let i = 0;
    return {
      ok: (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (n: string) => (n === "content-length" ? String(length) : null) },
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
      body: {
        getReader: () => ({
          async read() {
            if (r.hang) return new Promise<never>(() => {});
            if (r.breakAfter !== undefined && i === r.breakAfter)
              throw new Error("connection reset");
            return i < parts.length ? { done: false, value: parts[i++] } : { done: true };
          },
          async cancel() {
            log.cancelled++;
          },
        }),
      },
    };
  };
  return { fetch, log };
}
// Publisher https:// locations are off by default (privacy); these tests opt in as an app's "always" setting would.
const HTTPS = ["https", "ipfs", "ar", "data"];
const client = (fetch: FetchLike, timeoutMs?: number) =>
  createEfs({
    rpcs: ["http://127.0.0.1:1"],
    deployment,
    fetch,
    gateways: { allowSchemes: HTTPS, ...(timeoutMs ? { timeoutMs } : {}) },
  });

async function drain(it: UnverifiedChunks): Promise<{ parts: Uint8Array[]; error?: EfsFault }> {
  const parts: Uint8Array[] = [];
  try {
    for await (const p of it) parts.push(p);
    return { parts };
  } catch (e) {
    if (e instanceof EfsFault) return { parts, error: e };
    throw e;
  }
}

describe("unverifiedChunks (external)", () => {
  it("emits bytes as they arrive and settles VERIFIED once the whole body is read", async () => {
    const g = gateway({ "https://a.example/f": {} });
    const it = unverifiedChunks(client(g.fetch), external("https://a.example/f"));
    const { parts, error } = await drain(it);
    expect(error).toBeUndefined();
    expect(parts.map((p) => new TextDecoder().decode(p))).toEqual([
      "frame-1 ",
      "frame-2 ",
      "frame-3\n",
    ]);
    expect(await it.result).toMatchObject({ grade: "VERIFIED", emitted: BigInt(ALL.length) });
  });

  it("a bad digest after the bytes are out is a final MISMATCH: the stream errors and result says so", async () => {
    const g = gateway({
      "https://a.example/f": { parts: [enc("frame-1 "), enc("frame-X "), enc("frame-3\n")] },
      "https://b.example/f": {},
    });
    const it = unverifiedChunks(
      client(g.fetch),
      external("https://a.example/f", "https://b.example/f"),
    );
    const { parts, error } = await drain(it);
    expect(parts.length).toBe(3);
    expect(error?.code).toBe("STREAM_FAILED");
    expect((await it.result).grade).toBe("MISMATCH");
    expect(g.log.fetched).toEqual(["https://a.example/f"]); // never a silent switch after bytes went out
  });

  it("fails over before the first byte: HTTP errors and a wrong declared length", async () => {
    const g = gateway({
      "https://a.example/f": { status: 502 },
      "https://b.example/f": { length: 3 },
      "https://c.example/f": {},
    });
    const it = unverifiedChunks(
      client(g.fetch),
      external("https://a.example/f", "https://b.example/f", "https://c.example/f"),
    );
    expect((await drain(it)).error).toBeUndefined();
    const r = await it.result;
    expect(r.grade).toBe("VERIFIED");
    expect(r.attempts.map((a) => a.outcome)).toEqual(["FAILED", "MISMATCH", "VERIFIED"]);
  });

  it("a download that breaks mid-body is UNAVAILABLE with the bytes emitted, and is not retried elsewhere", async () => {
    const g = gateway({ "https://a.example/f": { breakAfter: 1 }, "https://b.example/f": {} });
    const it = unverifiedChunks(
      client(g.fetch),
      external("https://a.example/f", "https://b.example/f"),
    );
    const { parts, error } = await drain(it);
    expect(parts.length).toBe(1);
    expect(error?.details).toMatchObject({ grade: "UNAVAILABLE", emitted: 8n });
    expect(g.log.fetched).toEqual(["https://a.example/f"]);
  });

  it("stops as soon as a body runs longer than the file", async () => {
    const g = gateway({
      "https://a.example/f": { parts: [...CONTENT, enc("extra")], length: ALL.length },
    });
    const it = unverifiedChunks(client(g.fetch), external("https://a.example/f"));
    const { parts, error } = await drain(it);
    expect(parts.length).toBe(3);
    expect(error?.details).toMatchObject({ grade: "MISMATCH" });
  });

  it("an idle download times out; return() cancels the body", async () => {
    const hang = gateway({ "https://a.example/f": { hang: true } });
    const slow = unverifiedChunks(client(hang.fetch, 50), external("https://a.example/f"));
    expect((await drain(slow)).error?.details).toMatchObject({ grade: "UNAVAILABLE" });

    const g = gateway({ "https://a.example/f": {} });
    const it = unverifiedChunks(client(g.fetch), external("https://a.example/f"));
    await it.next();
    await it.return();
    expect(g.log.cancelled).toBe(1);
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect((await it.result).reason?.code).toBe("CANCELLED");
  });

  it("policy still applies: a private-host locator is never fetched", async () => {
    const g = gateway({});
    const it = unverifiedChunks(client(g.fetch), external("https://127.0.0.1/f"));
    expect((await drain(it)).error?.details).toMatchObject({ grade: "POLICY_BLOCKED" });
    expect(g.log.fetched).toEqual([]);
  });

  it("ledger layouts are verified per chunk and settle VERIFIED", async () => {
    const inline: OpenedFile = { ...external(), layout: "inline", inline: ALL, locations: [] };
    const it = unverifiedChunks(client(gateway({}).fetch), inline);
    expect((await drain(it)).parts).toEqual([ALL]);
    expect((await it.result).grade).toBe("VERIFIED");
  });
});
