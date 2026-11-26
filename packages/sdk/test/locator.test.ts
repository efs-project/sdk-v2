// SPDX-License-Identifier: MIT
// Locators are untrusted input: strict ids, encoded paths, an enforced scheme allowlist, no private hosts.
import { describe, expect, it } from "vitest";
import {
  checkHttpUrl,
  DEFAULT_GATEWAYS,
  isPrivateHost,
  planLocator,
} from "../src/content/locator.ts";
import { header, parsePathQuery } from "../src/content/web3.ts";
import { withinGateway } from "../src/files/bytes.ts";

/** Gateways named by the app: the SDK ships none (PM decision, 2026-11-26). */
const P = {
  ...DEFAULT_GATEWAYS,
  ipfs: ["https://ipfs.io", "https://dweb.link"],
  arweave: ["https://arweave.net"],
};
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
  it("enforces the scheme allowlist; publisher http(s) is off by default", () => {
    expect(planLocator("http://example.com/x", P)).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
    });
    expect(planLocator("bzz://abc", P)).toMatchObject({ ok: false, why: "UNSUPPORTED_LOCATOR" });
    expect(planLocator(`ipfs://${CID}`, { ...P, allowSchemes: ["https"] })).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
    });
    expect(planLocator("https://example.com/x", P)).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
      rule: "scheme",
    });
  });
  it("plans web3:// locations on the client's own chain only, by address", () => {
    const W = { ...P, web3ChainId: 31337 };
    const addr = "0xd658eacb6520528bbc06fda32eb847a3c2ceea81";
    expect(
      planLocator(
        `web3://${addr.toUpperCase().replace("0X", "0x")}:31337/0xab/docs/a%20b.txt?lens=0x1,0x2`,
        W,
      ),
    ).toEqual({
      ok: true,
      scheme: "web3",
      web3: {
        address: addr,
        chainId: 31337,
        resource: ["0xab", "docs", "a b.txt"],
        params: [{ key: "lens", value: "0x1,0x2" }],
      },
    });
    expect(planLocator(`web3://${addr}/x`, W)).toMatchObject({
      ok: false,
      why: "UNSUPPORTED_LOCATOR",
    }); // chain 1
    expect(planLocator("web3://efs.eth:31337/x", W)).toMatchObject({
      ok: false,
      why: "UNSUPPORTED_LOCATOR",
    });
    expect(planLocator(`web3://me@${addr}:31337/x`, W)).toMatchObject({
      ok: false,
      why: "UNSUPPORTED_LOCATOR",
    });
    expect(planLocator(`web3://${addr}:031337/x`, W)).toMatchObject({
      ok: false,
      why: "MALFORMED",
    });
    expect(planLocator(`web3://${addr}:31337/%zz`, W)).toMatchObject({
      ok: false,
      why: "MALFORMED",
    });
    expect(planLocator(`web3://${addr}:31337/x`, { ...W, allowSchemes: ["ipfs"] })).toMatchObject({
      ok: false,
      why: "POLICY_BLOCKED",
    });
  });
  it("parses a gateway's web3-next-chunk exactly as the gateway writes it", () => {
    expect(parsePathQuery("/0x00ab/docs/deep%20tree.bin?offset=8160&lens=0xabc,0xdef")).toEqual({
      resource: ["0x00ab", "docs", "deep tree.bin"],
      params: [
        { key: "offset", value: "8160" },
        { key: "lens", value: "0xabc,0xdef" },
      ],
    });
    expect(parsePathQuery("/")).toEqual({ resource: [], params: [] });
    expect(parsePathQuery("web3://x/y")).toBeNull();
    expect(parsePathQuery("/a?=1")).toBeNull();
    expect(header([{ key: "Web3-Next-Chunk", value: "/a" }], "web3-next-chunk")).toBe("/a");
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

describe("redirects within a configured gateway", () => {
  const o = (url: string) => {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { protocol: u.protocol, hostname: u.hostname, port };
  };
  const local = o("http://localhost:8080/ipfs/x");
  const remote = o("https://gw.example/ipfs/x");
  it("trusts the same origin and its subdomain gateway", () => {
    expect(withinGateway(local, o(`http://${CID}.ipfs.localhost:8080/`))).toBe(true);
    expect(withinGateway(remote, o("https://gw.example:443/ipfs/y"))).toBe(true);
    expect(withinGateway(remote, o(`https://${CID}.ipfs.gw.example/`))).toBe(true);
  });
  it("never trusts another port, a scheme change or a lookalike host", () => {
    expect(withinGateway(local, o("http://localhost:2375/containers/json"))).toBe(false); // port
    expect(withinGateway(remote, o("http://gw.example/ipfs/y"))).toBe(false); // downgrade
    expect(withinGateway(remote, o("https://evilgw.example/"))).toBe(false); // suffix without a dot
    expect(withinGateway(remote, o("https://gw.example.evil.test/"))).toBe(false);
    expect(withinGateway(null, o("https://gw.example/"))).toBe(false);
  });
  it("a trusted hop is still checked for credentials and whitespace", () => {
    const trust = { ...P, allowInsecureHttp: true, allowPrivateHosts: true };
    expect(checkHttpUrl("http://user:pw@localhost:8080/x", trust)).toBe("POLICY_BLOCKED");
    expect(checkHttpUrl("http://localhost:8080/a\\b", trust)).toBe("MALFORMED");
    expect(checkHttpUrl("http://localhost:2375/", P)).toBe("POLICY_BLOCKED"); // untrusted hop: http + private
  });
});
