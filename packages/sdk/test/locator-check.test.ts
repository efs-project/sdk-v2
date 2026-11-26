// SPDX-License-Identifier: MIT
// External locations: the SDK names no gateway of its own (an app chooses, and the choice is visible there), a scheme
// with no gateway is blocked by policy rather than "unavailable", and a locator nobody could ever read is refused
// before it is written (checkLocator, and planCreateFile / planEditFile).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAYS, planLocator } from "../src/content/locator.ts";
import type { Hex, PrincipalId, RecordId } from "../src/core/hex.ts";
import { planEditFile } from "../src/files/edit.ts";
import { planCreateFile } from "../src/files/entries.ts";
import { checkLocator, createEfs } from "../src/index.ts";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const AR = "Z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u";

describe("no default gateways", () => {
  it("the SDK ships none: ipfs:// and ar:// are blocked by policy until the app names a gateway", () => {
    expect(DEFAULT_GATEWAYS.ipfs).toEqual([]);
    expect(DEFAULT_GATEWAYS.arweave).toEqual([]);
    expect(planLocator(`ipfs://${CID}`, DEFAULT_GATEWAYS)).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
      rule: "no-gateway",
    });
    expect(planLocator(`ar://${AR}`, DEFAULT_GATEWAYS)).toMatchObject({
      why: "POLICY_BLOCKED",
      rule: "no-gateway",
    });
    // Named: the URLs are built in the app's order.
    const named = planLocator(`ipfs://${CID}`, {
      ...DEFAULT_GATEWAYS,
      ipfs: ["https://gw.example"],
    });
    expect(named).toMatchObject({ ok: true, urls: [`https://gw.example/ipfs/${CID}`] });
  });
});

describe("checkLocator", () => {
  it("accepts every location a reader could fetch, whatever this client's read policy", () => {
    for (const ok of [
      `ipfs://${CID}`,
      `ipfs://${CID}/a/b.txt`,
      `ar://${AR}`,
      "https://example.com/f.bin",
      "http://example.com/f.bin", // a policy choice of each reader (insecure http), so writable
      "https://127.0.0.1/f.bin", // likewise a private host
      "data:text/plain;base64,aGk=",
      "web3://0x5FbDB2315678afecb367f032d93F642f64180aa3:31337/f.bin",
    ])
      expect(checkLocator(ok), ok).toMatchObject({ ok: true });
  });
  it("refuses one nobody could read: malformed, an unknown scheme, or a URL carrying credentials", () => {
    expect(checkLocator("ipfs://not-a-cid")).toMatchObject({ ok: false, why: "MALFORMED" });
    expect(checkLocator(`ipfs://${CID}/../x`)).toMatchObject({ ok: false, why: "MALFORMED" });
    expect(checkLocator("no scheme here")).toMatchObject({ ok: false, why: "MALFORMED" });
    expect(checkLocator("magnet:?xt=urn:btih:abc")).toMatchObject({
      ok: false,
      why: "UNSUPPORTED_LOCATOR",
    });
    expect(checkLocator("https://user:pw@example.com/f.bin")).toMatchObject({
      ok: false,
      why: "MALFORMED",
    });
  });
});

describe("the planners refuse an unreadable locator before anything is read or sent", () => {
  const deployment = JSON.parse(
    readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
  ) as { root: { directoryRecordId: RecordId } };
  const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment }); // never reached
  const writer = { principal: `0x${"0".repeat(24)}${"11".repeat(20)}` as PrincipalId };
  const external = (locator: string) => ({
    kind: "external" as const,
    length: 1n,
    sha256: `0x${"ab".repeat(32)}` as Hex,
    locator,
  });
  const folder = { kind: "folder" as const, directory: deployment.root.directoryRecordId };
  it("planCreateFile", async () => {
    await expect(
      planCreateFile(efs, writer, { folder, name: "x.bin", content: external("ipfs://not-a-cid") }),
    ).rejects.toMatchObject({ code: "MISUSE", details: { why: "MALFORMED" } });
    await expect(
      planCreateFile(efs, writer, {
        folder,
        name: "x.bin",
        content: external("magnet:?xt=urn:btih:abc"),
      }),
    ).rejects.toMatchObject({ code: "MISUSE", details: { why: "UNSUPPORTED_LOCATOR" } });
  });
  it("planEditFile", async () => {
    await expect(
      planEditFile(
        efs,
        writer as never,
        {
          file: { kind: "file", subject: `0x${"cd".repeat(32)}` },
          base: { kind: "revision", recordId: `0x${"ef".repeat(32)}` },
          content: external("ipfs://not-a-cid"),
        } as never,
      ),
    ).rejects.toMatchObject({ code: "MISUSE", details: { why: "MALFORMED" } });
  });
});
