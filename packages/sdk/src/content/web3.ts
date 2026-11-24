// SPDX-License-Identifier: MIT
// web3:// URLs (ERC-6860) for contracts in resource-request mode (ERC-5219, discovered via ERC-6944 resolveMode),
// with chunked responses (ERC-7617 `web3-next-chunk`). Pure parsing; the reads live in files/web3read.ts.
//
//   web3://0x<address>[:<chainId>]/<seg>/<seg>?<key>=<value>&…
//
// Supported in 0.1: a 20-byte hex address host (no ENS names, no userinfo "from" address), and the deployment's own
// chain (the SDK has RPC endpoints for that chain only). The chain id defaults to 1, as ERC-6860 says.
import type { Address } from "../core/hex.js";

export interface KeyValue {
  key: string;
  value: string;
}
export interface Web3Url {
  address: Address;
  chainId: number;
  /** Path segments, each percent-decoded once (ERC-5219 `resource`). */
  resource: string[];
  /** Query pairs, percent-decoded once (ERC-5219 `params`). */
  params: KeyValue[];
}
export type Web3Parse =
  | { ok: true; url: Web3Url }
  | { ok: false; why: "MALFORMED" | "UNSUPPORTED"; detail: string };

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/** Parse a path + query (`/a/b?k=v`) into resource segments and params. Null when malformed. */
export function parsePathQuery(
  pathQuery: string,
): { resource: string[]; params: KeyValue[] } | null {
  if (!pathQuery.startsWith("/") || pathQuery.includes("#")) return null;
  const q = pathQuery.indexOf("?");
  const path = q < 0 ? pathQuery : pathQuery.slice(0, q);
  const query = q < 0 ? "" : pathQuery.slice(q + 1);
  const resource: string[] = [];
  if (path !== "/") {
    for (const seg of path.slice(1).split("/")) {
      const d = decode(seg);
      if (d === null) return null;
      resource.push(d);
    }
  }
  const params: KeyValue[] = [];
  if (query !== "") {
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const key = decode(eq < 0 ? pair : pair.slice(0, eq));
      const value = decode(eq < 0 ? "" : pair.slice(eq + 1));
      if (key === null || value === null || key === "") return null;
      params.push({ key, value });
    }
  }
  return { resource, params };
}

export function parseWeb3Url(locator: string): Web3Parse {
  const m = /^web3:\/\/([^/?#]*)(.*)$/is.exec(locator);
  if (!m) return { ok: false, why: "MALFORMED", detail: "not a web3:// URL" };
  const authority = m[1] as string;
  const rest = (m[2] as string) || "/";
  if (authority.includes("@"))
    return {
      ok: false,
      why: "UNSUPPORTED",
      detail: "web3:// with a from-address (userinfo) is not supported",
    };
  const am = /^(0x[0-9a-fA-F]{40})(?::([0-9]+))?$/.exec(authority);
  if (!am) {
    const name = /^[^:]+/.exec(authority)?.[0] ?? authority;
    return /^0x/i.test(name)
      ? { ok: false, why: "MALFORMED", detail: "the host is not a 20-byte address" }
      : {
          ok: false,
          why: "UNSUPPORTED",
          detail: `web3:// names (${name}) are not resolved in 0.1; use an address`,
        };
  }
  const chainId = am[2] === undefined ? 1 : Number(am[2]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || (am[2] !== undefined && /^0\d/.test(am[2])))
    return { ok: false, why: "MALFORMED", detail: "bad chain id" };
  const pq = parsePathQuery(rest);
  if (!pq) return { ok: false, why: "MALFORMED", detail: "bad path or query" };
  return {
    ok: true,
    url: { address: (am[1] as string).toLowerCase() as Address, chainId, ...pq },
  };
}

/** A header's value, matched case-insensitively (gateways return keys in their own case). */
export function header(headers: readonly KeyValue[], name: string): string | undefined {
  const n = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === n)?.value;
}
