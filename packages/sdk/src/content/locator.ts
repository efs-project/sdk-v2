// SPDX-License-Identifier: MIT
// External locations: turn a files-external/1 locator into the HTTP URLs to try, in order. The bytes are verified
// against the descriptor's sha256 afterwards, so a gateway is never trusted.
import { utf8Encode } from "../core/platform.js";

export interface GatewayPolicy {
  ipfs: readonly string[];
  arweave: readonly string[];
  allowInsecureHttp: boolean;
}
export const DEFAULT_GATEWAYS: GatewayPolicy = {
  ipfs: ["https://ipfs.io", "https://dweb.link", "https://trustless-gateway.link"],
  arweave: ["https://arweave.net", "https://ar-io.net"],
  allowInsecureHttp: false,
};

export type LocatorPlan =
  | { ok: true; scheme: string; urls: readonly string[] }
  | { ok: true; scheme: "data"; inline: Uint8Array }
  | { ok: false; scheme: string; why: "UNSUPPORTED_LOCATOR" | "POLICY_BLOCKED" | "MALFORMED" };

const trim = (gw: string): string => gw.replace(/\/+$/, "");

export function planLocator(locator: string, policy: GatewayPolicy): LocatorPlan {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(locator);
  if (!m) return { ok: false, scheme: "", why: "MALFORMED" };
  const scheme = (m[1] as string).toLowerCase();
  const rest = m[2] as string;
  if (scheme === "https" || scheme === "http") {
    if (scheme === "http" && !policy.allowInsecureHttp)
      return { ok: false, scheme, why: "POLICY_BLOCKED" };
    if (/^\/\/[^/@]*@/.test(rest)) return { ok: false, scheme, why: "POLICY_BLOCKED" }; // credentials in a URL
    return { ok: true, scheme, urls: [locator] };
  }
  if (scheme === "ipfs") {
    const path = rest.replace(/^\/\//, "");
    if (!/^[A-Za-z0-9]+(\/.*)?$/.test(path)) return { ok: false, scheme, why: "MALFORMED" };
    return { ok: true, scheme, urls: policy.ipfs.map((g) => `${trim(g)}/ipfs/${path}`) };
  }
  if (scheme === "ar") {
    const path = rest.replace(/^\/\//, "");
    if (!/^[A-Za-z0-9_-]{43}(\/.*)?$/.test(path)) return { ok: false, scheme, why: "MALFORMED" };
    return { ok: true, scheme, urls: policy.arweave.map((g) => `${trim(g)}/${path}`) };
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
    let text: string;
    try {
      text = decodeURIComponent(payload);
    } catch {
      return { ok: false, scheme, why: "MALFORMED" };
    }
    return { ok: true, scheme: "data", inline: utf8Encode(text) };
  }
  // web3:// is read through the EfsWeb3Gateway once contracts ship it (C10); bzz:// and others are not fetched yet.
  return { ok: false, scheme, why: "UNSUPPORTED_LOCATOR" };
}
