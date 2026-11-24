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

/** True for hosts a locator must not reach unless allowPrivateHosts: loopback, private, link-local, metadata. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  )
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (h.includes(":"))
    return (
      h === "::1" ||
      h === "::" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80") ||
      h.startsWith("::ffff:")
    );
  return /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h); // integer-form IPv4 tricks
}

/** Validate an absolute http(s) URL (a locator or a redirect target) against the policy. */
export function checkHttpUrl(
  url: string,
  policy: GatewayPolicy,
): "ok" | "POLICY_BLOCKED" | "MALFORMED" {
  const m = /^(https?):\/\/([^/?#]*)([^#]*)$/i.exec(url);
  if (!m) return "MALFORMED";
  const scheme = (m[1] as string).toLowerCase();
  const authority = m[2] as string;
  if (scheme === "http" && !policy.allowInsecureHttp) return "POLICY_BLOCKED";
  if (authority.includes("@")) return "POLICY_BLOCKED"; // credentials in a URL
  const host = authority.replace(/:\d+$/, "");
  if (!host || /[\s%]/.test(host)) return "MALFORMED";
  if (!policy.allowPrivateHosts && isPrivateHost(host)) return "POLICY_BLOCKED";
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
