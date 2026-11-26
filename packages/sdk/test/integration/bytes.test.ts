// SPDX-License-Identifier: MIT
// Verified byte reads against the fixture's seed: inline, a 3-chunk span tree, and an external web3:// file
// (more web3:// in web3.test.ts).
import { readFileSync } from "node:fs";
import { encodeAbiParameters, getAbiItem, keccak256, stringToHex, toFunctionSelector } from "viem";
import { describe, expect, inject, it } from "vitest";
import type { Eip1193Like } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, SubjectId } from "../../src/core/hex.ts";
import { openFile, readBytes, readRange } from "../../src/files/bytes.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { files: { name: string; subjectId: string }[] };
};
const subject = (name: string) =>
  deployment.seed.files.find((f) => f.name === name)?.subjectId as SubjectId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });

function fixturePayload(n: number, seed: Hex): Uint8Array {
  let hex = "";
  for (let i = 0; i < n; i += 32)
    hex += keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [seed, BigInt(i)]),
    ).slice(2);
  return Uint8Array.from(Buffer.from(hex.slice(0, n * 2), "hex"));
}

describe("byte reads (fixture)", () => {
  it("opens and reads an inline file", async () => {
    const opened = await openFile(efs, { kind: "file", subject: subject("readme.txt") });
    expect(opened.status).toBe("PRESENT");
    if (opened.status !== "PRESENT") return;
    expect(opened.file.layout).toBe("inline");
    expect(opened.file.size).toBe(18n);
    const all = await readBytes(efs, opened.file);
    expect(all.grade).toBe("VERIFIED");
    expect(new TextDecoder().decode(all.bytes)).toBe("Meeting at 10:00.\n");
  });
  it("reads a span tree whole and in ranges that cross chunk boundaries", async () => {
    const opened = await openFile(efs, { kind: "file", subject: subject("big.bin") });
    expect(opened.status).toBe("PRESENT");
    if (opened.status !== "PRESENT") return;
    expect(opened.file.layout).toBe("span");
    const expected = fixturePayload(20_000, keccak256(stringToHex("efs-fixture/big.bin")));
    const all = await readBytes(efs, opened.file);
    expect(all.grade).toBe("VERIFIED");
    expect(all.bytes).toEqual(expected);
    for (const [offset, length] of [
      [0, 10],
      [8150, 20],
      [8160, 8160],
      [16300, 3700],
      [19990, 50],
    ] as const) {
      const part = await readRange(efs, opened.file, {
        offset: BigInt(offset),
        length: BigInt(length),
      });
      expect(part.grade).toBe("VERIFIED");
      expect(part.bytes).toEqual(expected.slice(offset, Math.min(20_000, offset + length)));
    }
  });
  it("reads an external web3:// location honestly: the seed's points at the zero address, so it is UNAVAILABLE", async () => {
    const opened = await openFile(efs, { kind: "file", subject: subject("remote.txt") });
    expect(opened.status).toBe("PRESENT");
    if (opened.status !== "PRESENT") return;
    expect(opened.file.layout).toBe("external");
    expect(opened.file.locations[0]?.uri).toMatch(/^web3:\/\//);
    const r = await readBytes(efs, opened.file);
    expect(r.grade).toBe("UNAVAILABLE");
    expect(r.bytes).toBeUndefined();
  });
  it("a file nobody created is ABSENT_PROVEN (the lens reader proved it), never UNKNOWN", async () => {
    const r = await openFile(efs, {
      kind: "file",
      subject: keccak256(stringToHex("no such file")) as SubjectId,
    });
    expect(r.status).toBe("ABSENT_PROVEN");
  });
  it("detects a lying endpoint (a forged record body) and fails over to an honest one", async () => {
    // A provider that flips one byte inside every record() result: record bodies no longer hash to their ids. (Only
    // record(): another reply forged this way is caught by its own check first, a decider outside the Lens for one.)
    const recordSelector = toFunctionSelector(
      getAbiItem({ abi: ledgerReadsAbi, name: "record" } as never) as never,
    );
    const liar: Eip1193Like = {
      async request({ method, params }) {
        const res = await fetch(fixture.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const json = (await res.json()) as { result: string };
        const data = String((params as [{ data?: string }] | undefined)?.[0]?.data ?? "");
        if (
          method === "eth_call" &&
          data.startsWith(recordSelector) &&
          typeof json.result === "string" &&
          json.result.length > 600
        ) {
          const i = json.result.length - 70;
          return (
            json.result.slice(0, i) +
            (json.result[i] === "0" ? "1" : "0") +
            json.result.slice(i + 1)
          );
        }
        return json.result;
      },
    };
    const both = createEfs({
      rpcs: [{ provider: liar, label: "liar" }, fixture.rpcUrl],
      deployment,
    });
    const opened = await openFile(both, { kind: "file", subject: subject("readme.txt") });
    expect(opened.status).toBe("PRESENT");
    const outcomes = opened.evidence.attempts.map(
      (a) => `${a.endpoint}:${a.outcome}:${a.reason?.code ?? ""}`,
    );
    expect(outcomes).toContain("liar:FAILED:DIGEST_MISMATCH");
  });
});
