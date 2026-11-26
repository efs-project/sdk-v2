// SPDX-License-Identifier: MIT
// Publisher https:// locations are off by default (a publisher's server sees the reader's IP). One call may allow
// exact origins ("Load from example.com"); a fetch allowed that way never follows a redirect to another origin.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "viem";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain/rpc.ts";
import { createEfs } from "../src/client.ts";
import { EfsFault } from "../src/core/errors.ts";
import type { Hex, RecordId, SubjectId } from "../src/core/hex.ts";
import { type OpenedFile, readBytes } from "../src/files/bytes.ts";
import { fileChunks } from "../src/files/stream.ts";
import { unverifiedChunks } from "../src/files/unverified.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const TEXT = new TextEncoder().encode("hosted elsewhere\n");
const file = (...uris: string[]): OpenedFile => ({
  file: `0x${"01".repeat(32)}` as SubjectId,
  revision: `0x${"02".repeat(32)}` as RecordId,
  author: null,
  size: BigInt(TEXT.length),
  sha256: sha256(TEXT) as Hex,
  layout: "external",
  locations: uris.map((uri) => ({ scheme: uri.split(":")[0] as string, uri })),
});

/** A fake network: per URL, a body or a redirect. Records every URL fetched and the redirect mode asked for. */
function net(routes: Record<string, { redirect?: string; status?: number }> = {}) {
  const log: { url: string; redirect?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    log.push({ url, ...(init.redirect ? { redirect: init.redirect } : {}) });
    const r = routes[url] ?? (url.includes("/ipfs/") ? { status: 404 } : undefined);
    if (r?.status)
      return {
        ok: false,
        status: r.status,
        headers: { get: () => null },
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    if (r?.redirect)
      return {
        ok: false,
        status: 302,
        headers: { get: (n: string) => (n === "location" ? (r.redirect as string) : null) },
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n === "content-length" ? String(TEXT.length) : null) },
      text: async () => "",
      arrayBuffer: async () => TEXT.slice().buffer,
    };
  };
  return { fetch, log };
}
const client = (fetch: FetchLike, gateways = {}) =>
  createEfs({ rpcs: ["http://127.0.0.1:1"], deployment, fetch, gateways });

describe("publisher https:// locations", () => {
  it("are blocked by default, naming the origin and the exact option that allows it, with nothing fetched", async () => {
    const n = net();
    const r = await readBytes(
      client(n.fetch),
      file(
        "https://files.example.org/a.txt",
        "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      ),
    );
    // Both blocked by policy: the https one by scheme, the ipfs one because the SDK names no gateway of its own.
    expect(r.grade).toBe("POLICY_BLOCKED");
    expect(r.blockedOrigins).toEqual(["https://files.example.org"]);
    expect(n.log.map((x) => x.url).some((u) => u.startsWith("https://files.example.org"))).toBe(
      false,
    );

    const only = await readBytes(client(n.fetch), file("https://files.example.org/a.txt"));
    expect(only.grade).toBe("POLICY_BLOCKED");
    expect(only.blockedOrigins).toEqual(["https://files.example.org"]);
    expect(only.reason?.detail).toContain('allowOrigins: ["https://files.example.org"]');
    expect(only.reason?.detail).toContain("gateways.allowSchemes");
    expect(only.attempts[0]?.location).toBe("https://files.example.org");
  });

  it("an ipfs location with no gateway named is blocked by policy, never 'unavailable', with the option that allows it", async () => {
    const n = net();
    const cid = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const r = await readBytes(client(n.fetch), file(cid));
    expect(r.grade).toBe("POLICY_BLOCKED");
    expect(r.reason?.detail).toContain("gateways.ipfs");
    expect(n.log).toEqual([]); // nothing was fetched
    // Named by the app: tried.
    const named = await readBytes(client(n.fetch, { ipfs: ["https://gw.example"] }), file(cid));
    expect(named.grade).not.toBe("POLICY_BLOCKED");
    expect(n.log.some((x) => x.url.startsWith("https://gw.example/ipfs/"))).toBe(true);
  });

  it("allowOrigins allows exactly the listed origin, for that call only, and still verifies", async () => {
    const n = net();
    const efs = client(n.fetch);
    const f = file("https://files.example.org/a.txt");
    const r = await readBytes(efs, f, { allowOrigins: ["https://files.example.org"] });
    expect(r.grade).toBe("VERIFIED");
    expect(new TextDecoder().decode(r.bytes)).toBe("hosted elsewhere\n");
    // The permission was for that call only: a client that has not loaded these bytes is back to the policy …
    expect((await readBytes(client(n.fetch), f)).grade).toBe("POLICY_BLOCKED");
    // … while this one serves the bytes it already verified from its cache, contacting nobody.
    const again = await readBytes(efs, f);
    expect(again.grade).toBe("VERIFIED");
    expect(again.attempts).toEqual([{ location: "cache", outcome: "VERIFIED" }]);
    expect(n.log.filter((x) => x.url.startsWith("https://files.example.org")).length).toBe(1);
    for (const other of [
      "https://files.example.org:8443/a.txt",
      "https://cdn.files.example.org/a.txt",
      "https://example.org/a.txt",
    ])
      expect(
        (
          await readBytes(client(n.fetch), file(other), {
            allowOrigins: ["https://files.example.org"],
          })
        ).grade,
      ).toBe("POLICY_BLOCKED"); // fresh clients: this checks origin matching, not the cache
    // A trailing slash and case are normalized; the default port is the same origin.
    expect(
      (
        await readBytes(client(n.fetch), file("https://FILES.example.org:443/a.txt"), {
          allowOrigins: ["https://files.example.org/"],
        })
      ).grade,
    ).toBe("VERIFIED");
  });

  it("a fetch allowed by allowOrigins never follows a redirect to another origin", async () => {
    const n = net({
      "https://files.example.org/a.txt": { redirect: "https://tracker.example.net/a.txt" },
      "https://files.example.org/b.txt": { redirect: "/real/b.txt" },
    });
    const efs = client(n.fetch);
    const away = await readBytes(efs, file("https://files.example.org/a.txt"), {
      allowOrigins: ["https://files.example.org"],
    });
    expect(away.grade).toBe("UNAVAILABLE");
    expect(n.log.map((x) => x.url)).not.toContain("https://tracker.example.net/a.txt");
    const same = await readBytes(efs, file("https://files.example.org/b.txt"), {
      allowOrigins: ["https://files.example.org"],
    });
    expect(same.grade).toBe("VERIFIED");
    expect(n.log.map((x) => x.url)).toContain("https://files.example.org/real/b.txt");
    // With https allowed by the client's policy (the "always" setting), redirects follow the normal checks.
    const always = client(n.fetch, { allowSchemes: ["https", "ipfs", "ar", "data"] });
    expect((await readBytes(always, file("https://files.example.org/a.txt"))).grade).toBe(
      "VERIFIED",
    );
    expect(n.log.map((x) => x.url)).toContain("https://tracker.example.net/a.txt");
  });

  it("refuses entries that are not exact public https origins as misuse", async () => {
    const efs = client(net().fetch);
    const f = file("https://files.example.org/a.txt");
    for (const bad of [
      "https://files.example.org/path",
      "https://files.example.org/?q=1",
      "https://user:pw@files.example.org",
      "http://files.example.org",
      "https://127.0.0.1",
      "files.example.org",
      "ipfs://x",
    ])
      await expect(readBytes(efs, f, { allowOrigins: [bad] })).rejects.toThrow(
        /allowOrigins entry/,
      );
    // http and private hosts become possible only with the client's own opt-ins
    const lax = client(net().fetch, { allowInsecureHttp: true, allowPrivateHosts: true });
    expect(
      (
        await readBytes(lax, file("http://127.0.0.1:8080/a.txt"), {
          allowOrigins: ["http://127.0.0.1:8080"],
        })
      ).grade,
    ).toBe("VERIFIED");
  });

  it("streams take allowOrigins too, validate it at the call, and name blocked origins in failures", async () => {
    const n = net();
    const efs = client(n.fetch);
    const f = file("https://files.example.org/a.txt");
    const parts: Uint8Array[] = [];
    for await (const p of fileChunks(efs, f, { allowOrigins: ["https://files.example.org"] }))
      parts.push(p);
    expect(parts.length).toBe(1);
    try {
      for await (const _ of fileChunks(client(n.fetch), f)) void _; // a client without the bytes cached
      throw new Error("expected a failure");
    } catch (e) {
      expect(e).toBeInstanceOf(EfsFault);
      expect((e as EfsFault).details).toMatchObject({
        grade: "POLICY_BLOCKED",
        blockedOrigins: ["https://files.example.org"],
      });
    }
    expect(() => fileChunks(efs, f, { allowOrigins: ["https://x.example/p"] })).toThrow(
      /allowOrigins entry/,
    );
    expect(() => unverifiedChunks(efs, f, { allowOrigins: ["https://x.example/p"] })).toThrow(
      /allowOrigins entry/,
    );
    const u = unverifiedChunks(efs, f, { allowOrigins: ["https://files.example.org"] });
    for await (const _ of u) void _;
    expect((await u.result).grade).toBe("VERIFIED");
    const blocked = unverifiedChunks(client(n.fetch), f);
    await expect(blocked.next()).rejects.toThrow(/POLICY_BLOCKED/);
    expect((await blocked.result).blockedOrigins).toEqual(["https://files.example.org"]);
  });

  it("names each blocked location with the option that allows it; blockedOrigins lists only per-call ones", async () => {
    const efs = client(net().fetch);
    const r = await readBytes(
      efs,
      file(
        "https://files.example.org/a.txt",
        "http://plain.example.org/a.txt",
        "https://10.0.0.7/a.txt",
      ),
    );
    expect(r.grade).toBe("POLICY_BLOCKED");
    expect(r.blockedOrigins).toEqual(["https://files.example.org"]); // the only one allowOrigins can lift
    expect(r.reason?.detail).toContain(
      'https://files.example.org: allow once with { allowOrigins: ["https://files.example.org"] }',
    );
    expect(r.reason?.detail).toContain(
      "http://plain.example.org: plain http needs gateways.allowInsecureHttp",
    );
    expect(r.reason?.detail).toContain(
      "https://10.0.0.7: a private or local host needs gateways.allowPrivateHosts",
    );
    expect(r.attempts.map((a) => a.location)).toEqual([
      "https://files.example.org",
      "http://plain.example.org",
      "https://10.0.0.7",
    ]);
  });
});
