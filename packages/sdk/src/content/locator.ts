// SPDX-License-Identifier: MIT
// External locations: turn a files-external/1 locator into the HTTP URLs to try, in order. The bytes are verified
// against the descriptor's sha256 afterwards, so a gateway is never trusted for content. Locators are untrusted
// input (anyone can publish one), so the URLs are built strictly: only allowed schemes, strict ids, encoded path
// segments, no credentials, and no private, loopback or link-local hosts unless the caller opts in.
import { utf8Encode } from "../core/platform.js";
import { parseWeb3Url, type Web3Url } from "./web3.js";

export interface GatewayPolicy {
  ipfs: readonly string[];
  arweave: readonly string[];
  /**
   * Schemes that may be fetched at all. The default leaves out https: a publisher's https:// location is a server
   * the file's author chose, and it sees the reader's IP address. Apps opt in with `gateways.allowSchemes`, or per
   * call with `allowOrigins`.
   */
  allowSchemes: readonly string[];
  allowInsecureHttp: boolean;
  /** Allow locators that name private, loopback, link-local or metadata hosts (off by default). */
  allowPrivateHosts: boolean;
  /** Exact origins allowed for one call even when their scheme is not (normalized; see normalizeOrigin). */
  allowOrigins?: readonly string[];
  /** The chain the client has RPC endpoints for: web3:// locations on other chains are unsupported. */
  web3ChainId?: number;
}
export const DEFAULT_GATEWAYS: GatewayPolicy = {
  ipfs: ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link"],
  arweave: ["https://arweave.net", "https://ar-io.net"],
  allowSchemes: ["ipfs", "ar", "data", "web3"],
  allowInsecureHttp: false,
  allowPrivateHosts: false,
};

export type LocatorPlan =
  /** `originGrant`: allowed only through `allowOrigins`, so redirects must keep this exact origin. */
  | { ok: true; scheme: string; urls: readonly string[]; originGrant?: true }
  | { ok: true; scheme: "data"; inline: Uint8Array }
  /** Read through the client's own RPC endpoints (files/web3read.ts). */
  | { ok: true; scheme: "web3"; web3: Web3Url }
  | {
      ok: false;
      scheme: string;
      why: "UNSUPPORTED_LOCATOR" | "POLICY_BLOCKED" | "MALFORMED";
      /** For a blocked http(s) location: its origin, so the app can name it and offer to allow it. */
      origin?: string;
      /** Why the policy blocked it, which decides the option that would allow it (see blockAdvice). */
      rule?: BlockRule;
      /** Why a location is unsupported or malformed, in words. */
      detail?: string;
    };

/**
 * Why the gateway policy blocked a location. Only `scheme` can be lifted for one call (allowOrigins, http(s) only);
 * the others are client-wide settings, or (credentials) never.
 */
export type BlockRule = "scheme" | "insecure-http" | "private-host" | "credentials";

/** The exact option that would allow a blocked location, in words a developer can act on. */
export function blockAdvice(label: string, scheme: string, rule: BlockRule): string {
  switch (rule) {
    case "scheme":
      return label.includes("://")
        ? `${label}: allow once with { allowOrigins: ["${label}"] }, or always with gateways.allowSchemes including "${scheme}"`
        : `${label}: allow with gateways.allowSchemes including "${scheme}"`;
    case "insecure-http":
      return `${label}: plain http needs gateways.allowInsecureHttp`;
    case "private-host":
      return `${label}: a private or local host needs gateways.allowPrivateHosts`;
    case "credentials":
      return `${label}: a URL carrying credentials is never fetched`;
  }
}

const trim = (gw: string): string => gw.replace(/\/+$/, "");
/** CIDv0 (base58btc "Qm…", 46 chars) or CIDv1 in base32 lowercase ("b…"). */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;
const AR_ID = /^[A-Za-z0-9_-]{43}$/;

/** Encode the path after an id: each segment percent-encoded; ".", ".." and empty middle segments refused. */
function encodePath(rest: string): string | null {
  if (rest === "") return "";
  if (!rest.startsWith("/") || /[?#\\]/.test(rest)) return null;
  const segs = rest.slice(1).split("/");
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      (seg === "" && i < segs.length - 1)
    )
      return null;
    out.push(encodeURIComponent(decoded));
  }
  return `/${out.join("/")}`;
}

type ParsedUrl = {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  /** hostname plus a non-default port */
  host: string;
  href: string;
};
/** The platform's WHATWG URL parser: the same parser fetch() uses, so validation and fetching never disagree. */
function parseUrl(url: string): ParsedUrl | null {
  const U = (globalThis as unknown as { URL?: new (u: string) => ParsedUrl }).URL;
  if (!U) return null;
  try {
    return new U(url);
  } catch {
    return null;
  }
}

/** The exact origin of an http(s) URL (scheme, host, port; default ports elided), or null. */
export function originOfUrl(url: string): string | null {
  const u = parseUrl(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

/**
 * Normalize an `allowOrigins` entry, or say why it is refused: it must be exactly an origin (no path, query,
 * fragment or credentials), https unless insecure http is allowed, and not a private host unless those are allowed.
 */
export function normalizeOrigin(
  entry: string,
  policy: GatewayPolicy,
): string | { refused: string } {
  if (/[\\\s]/.test(entry)) return { refused: "contains a backslash or whitespace" };
  const u = parseUrl(entry);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:"))
    return { refused: "not an http(s) origin" };
  if (u.protocol === "http:" && !policy.allowInsecureHttp)
    return { refused: "http origins need gateways.allowInsecureHttp" };
  if (u.username !== "" || u.password !== "") return { refused: "contains credentials" };
  if (!/^[a-z]+:\/\/[^/?#]+\/?$/i.test(entry)) return { refused: "has a path, query or fragment" };
  if (!policy.allowPrivateHosts && isPrivateHost(u.hostname))
    return { refused: "a private host needs gateways.allowPrivateHosts" };
  return `${u.protocol}//${u.host}`.toLowerCase();
}

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Expand a canonical (WHATWG-serialized) IPv6 address to eight 16-bit groups. */
function v6Groups(h: string): number[] | null {
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const part = (x: string): number[] =>
    x === "" ? [] : x.split(":").map((g) => Number.parseInt(g, 16));
  const head = part(halves[0] as string);
  const tail = halves.length === 2 ? part(halves[1] as string) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...new Array(fill).fill(0), ...tail];
  return all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : all;
}

/**
 * True for a canonical hostname (as the WHATWG parser serializes it) that a locator must not reach unless
 * allowPrivateHosts: loopback, private, link-local, CGNAT, benchmarking, multicast/reserved, unique-local IPv6,
 * IPv4-mapped/NAT64 forms of those, and local names. DNS rebinding is out of reach here: servers that fetch
 * untrusted locations should also restrict egress at the network layer.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (
    h === "" ||
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa")
  )
    return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  if (h.startsWith("[") && h.endsWith("]")) {
    const g = v6Groups(h.slice(1, -1));
    if (!g) return true; // unparseable: refuse
    const [g0, , , , , g5, g6, g7] = g as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g7 === 1)) return true; // :: and ::1
    if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00)
      return true; // ULA, link-local, multicast
    const embedded =
      (g0 === 0 && g.slice(1, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) ||
      (g0 === 0x64 && g[1] === 0xff9b);
    if (embedded) return privateV4(g6 >> 8, g6 & 0xff); // IPv4-mapped, IPv4-compatible, NAT64
    return false;
  }
  return false;
}

/** Validate an absolute http(s) URL (a locator or a redirect target) against the policy, as fetch() will parse it. */
export function checkHttpUrl(
  url: string,
  policy: GatewayPolicy,
): "ok" | "POLICY_BLOCKED" | "MALFORMED" {
  if (/[\\\s]/.test(url)) return "MALFORMED"; // backslashes and whitespace parse differently across tools
  const u = parseUrl(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return "MALFORMED";
  if (u.protocol === "http:" && !policy.allowInsecureHttp) return "POLICY_BLOCKED";
  if (u.username !== "" || u.password !== "") return "POLICY_BLOCKED"; // credentials in a URL
  if (!policy.allowPrivateHosts && isPrivateHost(u.hostname)) return "POLICY_BLOCKED";
  return "ok";
}

export function planLocator(locator: string, policy: GatewayPolicy): LocatorPlan {
  if (locator.length > 2048 || /[^\x21-\x7e]/.test(locator))
    return { ok: false, scheme: "", why: "MALFORMED" };
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(locator);
  if (!m) return { ok: false, scheme: "", why: "MALFORMED" };
  const scheme = (m[1] as string).toLowerCase();
  const rest = m[2] as string;
  if (scheme === "https" || scheme === "http") {
    const verdict = checkHttpUrl(locator, policy);
    if (verdict === "MALFORMED") return { ok: false, scheme, why: "MALFORMED" };
    const u = parseUrl(locator) as ParsedUrl;
    const origin = `${u.protocol}//${u.host}`.toLowerCase();
    const granted = (policy.allowOrigins ?? []).includes(origin);
    const schemeAllowed = policy.allowSchemes.includes(scheme);
    const rule: BlockRule | null =
      u.username !== "" || u.password !== ""
        ? "credentials"
        : u.protocol === "http:" && !policy.allowInsecureHttp
          ? "insecure-http"
          : !policy.allowPrivateHosts && isPrivateHost(u.hostname)
            ? "private-host"
            : !schemeAllowed && !granted
              ? "scheme"
              : null;
    if (rule) return { ok: false, scheme, why: "POLICY_BLOCKED", origin, rule };
    return granted && !schemeAllowed
      ? { ok: true, scheme, urls: [locator], originGrant: true }
      : { ok: true, scheme, urls: [locator] };
  }
  if (scheme === "web3") {
    if (!policy.allowSchemes.includes("web3"))
      return { ok: false, scheme, why: "POLICY_BLOCKED", rule: "scheme" };
    const p = parseWeb3Url(locator);
    if (!p.ok)
      return {
        ok: false,
        scheme,
        why: p.why === "MALFORMED" ? "MALFORMED" : "UNSUPPORTED_LOCATOR",
        detail: p.detail,
      };
    if (policy.web3ChainId !== undefined && p.url.chainId !== policy.web3ChainId)
      return {
        ok: false,
        scheme,
        why: "UNSUPPORTED_LOCATOR",
        detail: `web3:// on chain ${p.url.chainId}; this client has RPC endpoints for chain ${policy.web3ChainId} only`,
      };
    return { ok: true, scheme: "web3", web3: p.url };
  }
  if (!policy.allowSchemes.includes(scheme)) {
    const known = ["ipfs", "ar", "data"].includes(scheme);
    return known
      ? { ok: false, scheme, why: "POLICY_BLOCKED", rule: "scheme" }
      : { ok: false, scheme, why: "UNSUPPORTED_LOCATOR" };
  }
  if (scheme === "ipfs" || scheme === "ar") {
    const body = rest.replace(/^\/\//, "");
    const slash = body.indexOf("/");
    const id = slash < 0 ? body : body.slice(0, slash);
    const path = encodePath(slash < 0 ? "" : body.slice(slash));
    if (path === null || !(scheme === "ipfs" ? CID : AR_ID).test(id))
      return { ok: false, scheme, why: "MALFORMED" };
    const urls = (scheme === "ipfs" ? policy.ipfs : policy.arweave).map(
      (g) => `${trim(g)}${scheme === "ipfs" ? "/ipfs" : ""}/${id}${path}`,
    );
    return { ok: true, scheme, urls };
  }
  if (scheme === "data") {
    const d = /^([^,]*),(.*)$/s.exec(rest);
    if (!d) return { ok: false, scheme, why: "MALFORMED" };
    const meta = d[1] as string;
    const payload = d[2] as string;
    if (/;base64$/i.test(meta)) {
      const g = globalThis as unknown as { atob?: (s: string) => string };
      if (!g.atob) return { ok: false, scheme, why: "UNSUPPORTED_LOCATOR" };
      let bin: string;
      try {
        bin = g.atob(payload);
      } catch {
        return { ok: false, scheme, why: "MALFORMED" };
      }
      return { ok: true, scheme: "data", inline: Uint8Array.from(bin, (c) => c.charCodeAt(0)) };
    }
    try {
      return { ok: true, scheme: "data", inline: utf8Encode(decodeURIComponent(payload)) };
    } catch {
      return { ok: false, scheme, why: "MALFORMED" };
    }
  }
  // web3:// is read through the EfsWeb3Gateway once contracts ship it (C10); bzz:// and others are not fetched yet.
  return { ok: false, scheme, why: "UNSUPPORTED_LOCATOR" };
}
