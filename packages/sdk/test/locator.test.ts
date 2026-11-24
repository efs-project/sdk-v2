// SPDX-License-Identifier: MIT
// Locators are untrusted input: strict ids, encoded paths, an enforced scheme allowlist, no private hosts.
import { describe, expect, it } from "vitest";
import {
  checkHttpUrl,
  DEFAULT_GATEWAYS,
  isPrivateHost,
  planLocator,
} from "../src/content/locator.ts";

const P = DEFAULT_GATEWAYS;
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

describe("locator planning", () => {
  it("builds gateway URLs for strict ids with encoded paths", () => {
    const r = planLocator(`ipfs://${CID}/a%20b/c.txt`, P);
    expect(r.ok && "urls" in r && r.urls[0]).toBe(`https://ipfs.io/ipfs/${CID}/a%20b/c.txt`);
    const ar = planLocator("ar://Z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u", P);
    expect(ar.ok && "urls" in ar && ar.urls[0]).toBe(
      "https://arweave.net/Z1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u",
    );
  });
  it("refuses traversal, query injection and bad ids", () => {
    for (const bad of [
      `ipfs://${CID}/../x`,
      `ipfs://${CID}/%2e%2e/x`,
      `ipfs://${CID}?x=1`,
      `ipfs://${CID}#f`,
      "ipfs://../etc",
      "ipfs://not-a-cid",
      "ar://short",
    ]) {
      expect(planLocator(bad, P).ok, bad).toBe(false);
    }
  });
  it("enforces the scheme allowlist and https-only by default", () => {
    expect(planLocator("http://example.com/x", P)).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
    });
    expect(planLocator("bzz://abc", P)).toMatchObject({ ok: false, why: "UNSUPPORTED_LOCATOR" });
    expect(planLocator(`ipfs://${CID}`, { ...P, allowSchemes: ["https"] })).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
    });
    expect(
      planLocator("web3://0x0000000000000000000000000000000000000000:31337/x", P),
    ).toMatchObject({ ok: false });
  });
  it("blocks private, loopback, link-local and metadata hosts unless allowed", () => {
    // Every spelling the WHATWG parser (and so fetch) canonicalizes to a private address is refused.
    const spellings = [
      "localhost",
      "localhost.",
      "127.0.0.1",
      "127.1",
      "0177.0.0.1",
      "0x7f.0.0.1",
      "2130706433",
      "0x7f000001",
      "10.1.2.3",
      "192.168.0.1",
      "172.20.0.1",
      "169.254.169.254",
      "[::1]",
      "[0:0:0:0:0:0:0:1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[fd00::1]",
      "[fe80::1]",
      "[64:ff9b::a9fe:a9fe]",
      "db.internal",
    ];
    for (const host of spellings)
      expect(checkHttpUrl(`https://${host}/x`, P), host).toBe("POLICY_BLOCKED");
    expect(isPrivateHost("[2606:4700::1111]")).toBe(false);
    expect(checkHttpUrl("https://example.com\\@127.0.0.1/x", P)).toBe("MALFORMED");
    expect(checkHttpUrl("https://169.254.169.254/latest", { ...P, allowPrivateHosts: true })).toBe(
      "ok",
    );
    expect(checkHttpUrl("https://example.com/x", P)).toBe("ok");
    expect(checkHttpUrl("https://user:pw@example.com/x", P)).toBe("POLICY_BLOCKED");
  });
  it("decodes data: locators", () => {
    const r = planLocator("data:text/plain,hello%20world", P);
    expect(r.ok && "inline" in r && new TextDecoder().decode(r.inline)).toBe("hello world");
  });
});
