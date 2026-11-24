// SPDX-License-Identifier: MIT
// web3:// reads (ERC-6860 / ERC-5219 / ERC-7617) against the fixture's real EfsWeb3Gateway: through the client's
// own RPC, chunk by chunk, verified against the file's sha256 like any external location.
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { type OpenedFile, openFile, readBytes } from "../../src/files/bytes.ts";
import { fileChunks } from "../../src/files/stream.ts";
import { unverifiedChunks } from "../../src/files/unverified.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  chainId: number;
  readers: { web3Gateway: { address: string; seedUrl: string } };
  seed: { files: { name: string; subjectId: string; length: number; sha256: string }[] };
};
const seed = (name: string) =>
  deployment.seed.files.find((f) => f.name === name) as {
    subjectId: string;
    length: number;
    sha256: string;
  };
const SEED_URL = deployment.readers.web3Gateway.seedUrl; // web3://<gateway>:<chain>/<seed principal>/

let calls: string[] = [];
// No byte cache: several tests claim the same digest on purpose, and each must reach the gateway.
const noBytes = { get: async () => undefined, put: async () => {} };
const efs = createEfs({
  rpcs: [fixture.rpcUrl],
  deployment,
  cache: { bytes: noBytes },
  onRequest: (e) => {
    calls.push(...e.methods);
  },
});

/** An external file whose only location is `uri`, claiming the seed file's size and digest. */
const at = (uri: string, name: string, over: Partial<OpenedFile> = {}): OpenedFile => ({
  file: seed(name).subjectId as SubjectId,
  revision: `0x${"11".repeat(32)}` as RecordId,
  author: null,
  size: BigInt(seed(name).length),
  sha256: seed(name).sha256 as Hex,
  layout: "external",
  locations: [{ scheme: "web3", uri }],
  ...over,
});

describe("web3:// reads (fixture gateway)", () => {
  it("reads a one-chunk file through the gateway, verified", async () => {
    const r = await readBytes(efs, at(`${SEED_URL}docs/readme.txt`, "readme.txt"));
    expect(r.grade).toBe("VERIFIED");
    expect(new TextDecoder().decode(r.bytes)).toBe("Meeting at 10:00.\n");
    expect(r.attempts).toEqual([
      {
        location: `web3://${deployment.readers.web3Gateway.address.toLowerCase()}:${deployment.chainId}`,
        outcome: "VERIFIED",
      },
    ]);
  });

  it("follows web3-next-chunk across a 3-chunk file, byte-identical to the ledger read, on one endpoint", async () => {
    const ledger = await openFile(efs, {
      kind: "file",
      subject: seed("big.bin").subjectId as SubjectId,
    });
    if (ledger.status !== "PRESENT") throw new Error(ledger.status);
    const want = (await readBytes(efs, ledger.file)).bytes;
    calls = [];
    const r = await readBytes(efs, at(`${SEED_URL}docs/big.bin`, "big.bin"));
    expect(r.grade).toBe("VERIFIED");
    expect(r.bytes).toEqual(want);
    // block + [resolveMode, first chunk] + two more chunks; the chain check was done earlier on this client
    expect(calls).toEqual(["eth_getBlockByNumber", "eth_call", "eth_call", "eth_call", "eth_call"]);
  });

  it("a gateway serving bytes that fail the claim is MISMATCH, never content", async () => {
    const r = await readBytes(
      efs,
      at(`${SEED_URL}docs/readme.txt`, "readme.txt", { sha256: `0x${"00".repeat(32)}` as Hex }),
    );
    expect(r.grade).toBe("MISMATCH");
    expect(r.bytes).toBeUndefined();
    // Content-Length (the whole file) disagreeing with the claimed size stops before reading on.
    const short = await readBytes(efs, at(`${SEED_URL}docs/big.bin`, "big.bin", { size: 19_999n }));
    expect(short.attempts[0]).toMatchObject({
      outcome: "MISMATCH",
      detail: "declares 20000 bytes",
    });
  });

  it("statuses are failures of the location: a missing file is UNAVAILABLE naming the status", async () => {
    const r = await readBytes(efs, at(`${SEED_URL}docs/nope.txt`, "readme.txt"));
    expect(r.grade).toBe("UNAVAILABLE");
    expect(r.attempts[0]).toMatchObject({ outcome: "FAILED", detail: "web3 status 404" });
  });

  it("the seed's remote.txt: a 307 is followed through the policy, and its zero-address target has no contract", async () => {
    const direct = await openFile(efs, {
      kind: "file",
      subject: seed("remote.txt").subjectId as SubjectId,
    });
    if (direct.status !== "PRESENT") throw new Error(direct.status);
    const own = await readBytes(efs, direct.file); // its own locator: web3://0x000…000:31337/remote.txt
    expect(own.grade).toBe("UNAVAILABLE");
    expect(own.attempts[0]?.detail).toMatch(/no contract at 0x0{40}/);
    const viaGateway = await readBytes(efs, at(`${SEED_URL}docs/remote.txt`, "remote.txt"));
    expect(viaGateway.attempts.map((a) => a.outcome)).toEqual(["REDIRECTED", "FAILED"]);
    expect(viaGateway.attempts[0]?.detail).toBe(
      "web3://0x0000000000000000000000000000000000000000:31337/remote.txt",
    );
    expect(viaGateway.grade).toBe("UNAVAILABLE");
  });

  it("web3:// on another chain is unsupported (this client has no RPC there); web3 can be turned off", async () => {
    const other = SEED_URL.replace(`:${deployment.chainId}/`, ":1/");
    expect((await readBytes(efs, at(`${other}docs/readme.txt`, "readme.txt"))).grade).toBe(
      "UNSUPPORTED_LOCATOR",
    );
    const off = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      gateways: { allowSchemes: ["ipfs", "ar", "data"] },
    });
    expect((await readBytes(off, at(`${SEED_URL}docs/readme.txt`, "readme.txt"))).grade).toBe(
      "POLICY_BLOCKED",
    );
  });

  it("streams read web3:// locations too, verified before the first byte", async () => {
    const f = at(`${SEED_URL}docs/big.bin`, "big.bin");
    let n = 0;
    for await (const p of fileChunks(efs, f, { windowBytes: 8160 })) n += p.length;
    expect(n).toBe(20_000);
    const u = unverifiedChunks(efs, f);
    let m = 0;
    for await (const p of u) m += p.length;
    expect(m).toBe(20_000);
    expect((await u.result).grade).toBe("VERIFIED");
  });
});
