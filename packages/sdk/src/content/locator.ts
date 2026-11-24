// SPDX-License-Identifier: MIT
// External locations: turn a files-external/1 locator into the HTTP URLs to try, in order. The bytes are verified
// against the descriptor's sha256 afterwards, so a gateway is never trusted for content. Locators are untrusted
// input (anyone can publish one), so the URLs are built strictly: only allowed schemes, strict ids, encoded path
// segments, no credentials, and no private, loopback or link-local hosts unless the caller opts in.
import { utf8Encode } from "../core/platform.js";

export interface GatewayPolicy {
  ipfs: readonly string[];
  arweave: readonly string[];
  /** Schemes that may be fetched at all. */
  allowSchemes: readonly string[];
  allowInsecureHttp: boolean;
  /** Allow locators that name private, loopback, link-local or metadata hosts (off by default). */
  allowPrivateHosts: boolean;
}
export const DEFAULT_GATEWAYS: GatewayPolicy = {
  ipfs: ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link"],
  arweave: ["https://arweave.net", "https://ar-io.net"],
  allowSchemes: ["https", "ipfs", "ar", "data"],
  allowInsecureHttp: false,
  allowPrivateHosts: false,
};

export type LocatorPlan =
  | { ok: true; scheme: string; urls: readonly string[] }
  | { ok: true; scheme: "data"; inline: Uint8Array }
  | { ok: false; scheme: string; why: "UNSUPPORTED_LOCATOR" | "POLICY_BLOCKED" | "MALFORMED" };

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
  if (!policy.allowSchemes.includes(scheme)) {
    const known = ["https", "http", "ipfs", "ar", "data"].includes(scheme);
    return { ok: false, scheme, why: known ? "POLICY_BLOCKED" : "UNSUPPORTED_LOCATOR" };
  }
  if (scheme === "https" || scheme === "http") {
    const verdict = checkHttpUrl(locator, policy);
    return verdict === "ok"
      ? { ok: true, scheme, urls: [locator] }
      : { ok: false, scheme, why: verdict };
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
