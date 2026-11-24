// SPDX-License-Identifier: MIT
// Shareable links to EFS objects, as one fragment-safe string an app puts in its route after the realm, as in
// `#/r/<realm>/<link>`. Two kinds exist today:
//
//   ~efs/o/<subject>[?lens=<p>,<p>…]   an object link: a subject id (stable across renames). It opens the current
//                                      head under a Lens: the route's default, or the ordered principals given
//   ~efs/v/<record>                    a revision link: one immutable revision record (exact bytes; no Lens)
//
// A Lens principal is written as its 20-byte address when it is a key principal (an account), else as its 32-byte
// principal id. Names (such as ENS) in a Lens are not supported in 0.1.
//
// Ids are 0x + 64 lowercase hex. The first segment is `~efs`, a prefix the name profile reserves, so no path can
// ever look like these links: path links (after the tags-vs-directories ruling) can use any other first segment.
// The strings contain only [0-9a-z~/x?=,], so they need no escaping in a URL path, query or fragment.
import type { Lens } from "../client.js";
import { misuse } from "../core/errors.js";
import type { Address, PrincipalId, RecordId, SubjectId } from "../core/hex.js";

/** An object by subject id. Files open from it today; folders will reuse the same form. */
export interface ObjectLink {
  kind: "object";
  subject: SubjectId;
  /** The sharer's Lens, when it differs from the route's default. Pass it to reads as `{ lens }`. */
  lens?: Lens;
}
/** One exact revision. */
export interface RevisionLink {
  kind: "revision";
  recordId: RecordId;
}
/** What `link` accepts: an object or revision link, or a FileRef / RevisionRef from `@efs/sdk/files`. */
export type LinkTarget =
  | ObjectLink
  | RevisionLink
  | { kind: "file"; subject: SubjectId }
  | { kind: "revision"; recordId: RecordId; file?: SubjectId };

export type LinkParse =
  /** `canonical` is the link in canonical form; routers can redirect to it when it differs from the input. */
  | { status: "OK"; target: ObjectLink | RevisionLink; canonical: string }
  | { status: "INVALID"; rule: LinkRule }
  /** A path link. Path links wait for the folder model; nothing is guessed. */
  | { status: "UNSUPPORTED"; kind: "path" };

export type LinkRule =
  | "empty"
  | "fragment"
  | "bad-escape"
  | "reserved-name"
  | "unknown-link-kind"
  | "bad-id"
  | "unsupported-parameter"
  | "bad-lens"
  | "lens-name-unsupported";

export const LINK_PREFIX = "~efs";
const ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The most principals a link's Lens may name (the deployment may allow fewer; reads enforce its limit). */
export const MAX_LINK_LENS = 64;
const KEY_PREFIX = `0x${"0".repeat(24)}`;

const lensEntry = (p: PrincipalId): string => {
  const x = p.toLowerCase();
  return x.startsWith(KEY_PREFIX) ? `0x${x.slice(KEY_PREFIX.length)}` : x;
};

/** The link string for an object or revision. Throws MISUSE for an id that is not 32-byte hex, or a bad Lens. */
export function link(target: LinkTarget): string {
  const id = target.kind === "revision" ? target.recordId : target.subject;
  if (typeof id !== "string" || !ID.test(id))
    throw misuse("link: the id must be 0x followed by 64 hex digits", { kind: target.kind });
  if (target.kind === "revision") return `${LINK_PREFIX}/v/${id.toLowerCase()}`;
  const base = `${LINK_PREFIX}/o/${id.toLowerCase()}`;
  const lens = target.kind === "object" ? target.lens : undefined;
  if (!lens) return base;
  const ps = lens.principals;
  if (ps.length === 0 || ps.length > MAX_LINK_LENS || ps.some((p) => !ID.test(p)))
    throw misuse(`link: a Lens holds 1 to ${MAX_LINK_LENS} principal ids (0x + 64 hex)`);
  const entries = ps.map(lensEntry);
  if (new Set(entries).size !== entries.length)
    throw misuse("link: a Lens names each principal once");
  return `${base}?lens=${entries.join(",")}`;
}

/** Parse a `lens=` value into principal ids, or the rule it breaks. */
function parseLens(value: string): Lens | LinkRule {
  const entries = value.split(",");
  if (entries.length > MAX_LINK_LENS || entries.some((e) => e === "")) return "bad-lens";
  const principals: PrincipalId[] = [];
  for (const e of entries) {
    if (ADDRESS.test(e)) principals.push(`${KEY_PREFIX}${e.slice(2).toLowerCase()}` as PrincipalId);
    else if (ID.test(e)) principals.push(e.toLowerCase() as PrincipalId);
    else if (!/^0x[0-9a-fA-F]*$/.test(e)) return "lens-name-unsupported";
    else return "bad-lens";
  }
  if (new Set(principals).size !== principals.length) return "bad-lens";
  return { principals };
}

/** Decode %HH escapes once. Null when an escape is malformed. */
function decodeOnce(s: string): string | null {
  if (!s.includes("%")) return s;
  if (/%(?![0-9a-fA-F]{2})/.test(s)) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // escapes that are not UTF-8
  }
}

/**
 * Parse a link string from a route. A leading "/" is ignored. Splitting happens before decoding (one decode per
 * segment, as for paths), so an escaped `%2F` is never a separator.
 */
export function parseLink(input: string): LinkParse {
  const raw = input.startsWith("/") ? input.slice(1) : input;
  if (raw === "") return { status: "INVALID", rule: "empty" };
  if (raw.includes("#")) return { status: "INVALID", rule: "fragment" };
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const segments = path.split("/").map(decodeOnce);
  if (segments.some((x) => x === null)) return { status: "INVALID", rule: "bad-escape" };
  const [first = "", kind, id, ...rest] = segments as string[];
  if (!first.startsWith(LINK_PREFIX)) return { status: "UNSUPPORTED", kind: "path" };
  if (first !== LINK_PREFIX) return { status: "INVALID", rule: "reserved-name" };
  if (kind !== "o" && kind !== "v") return { status: "INVALID", rule: "unknown-link-kind" };
  if (id === undefined || !ID.test(id) || rest.length > 0)
    return { status: "INVALID", rule: "bad-id" };
  if (kind === "v") {
    if (q >= 0) return { status: "INVALID", rule: "unsupported-parameter" }; // a revision needs no Lens
    const target: RevisionLink = { kind: "revision", recordId: id.toLowerCase() as RecordId };
    return { status: "OK", target, canonical: link(target) };
  }
  const target: ObjectLink = { kind: "object", subject: id.toLowerCase() as SubjectId };
  if (q >= 0) {
    const m = /^lens=([^&]*)$/.exec(raw.slice(q + 1));
    if (!m) return { status: "INVALID", rule: "unsupported-parameter" };
    const value = decodeOnce(m[1] as string);
    if (value === null) return { status: "INVALID", rule: "bad-escape" };
    const lens = parseLens(value);
    if (typeof lens === "string") return { status: "INVALID", rule: lens };
    target.lens = lens;
  }
  return { status: "OK", target, canonical: link(target) };
}

// ---- the realm part of a route (naming review §6)
//
//   #/r/<alias>/<link>                      an app-configured alias (sepolia, local-1): the app resolves it
//   #/r/eip155:<chainId>/0x<ledger>/<link>  the full form, always accepted: chain id + the deployment's ledger proxy
//
// One ledger is one Realm (the realm id derives from genesis chain, ledger and salt), so no realm id is needed.

export interface RealmRef {
  chainId: number;
  ledger: Address;
}

export type RealmSplit =
  /** The full form. `rest` is what follows it (the link), `canonical` the realm part in canonical form. */
  | { status: "FULL"; realm: RealmRef; canonical: string; rest: string }
  /** An alias the app resolves from its own configuration. */
  | { status: "ALIAS"; alias: string; rest: string }
  | { status: "INVALID"; rule: RealmRule };

export type RealmRule =
  | "empty"
  | "bad-escape"
  | "unsupported-namespace"
  | "bad-chain-id"
  | "bad-ledger"
  | "bad-alias";

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The full realm form for a deployment: `eip155:<chainId>/0x<ledger, lowercase>`. */
export function formatRealm(realm: RealmRef): string {
  if (!Number.isSafeInteger(realm.chainId) || realm.chainId <= 0)
    throw misuse("formatRealm: chainId must be a positive integer");
  if (!ADDRESS.test(realm.ledger)) throw misuse("formatRealm: ledger must be a 20-byte address");
  return `eip155:${realm.chainId}/${realm.ledger.toLowerCase()}`;
}

/**
 * Split the realm off the front of a route path (what follows `#/r/`). The full form spans two segments; an alias
 * is one. Aliases are lowercase letters, digits and hyphens; a colon always means a chain namespace, and only
 * `eip155` is supported.
 */
export function splitRealm(path: string): RealmSplit {
  const raw = path.startsWith("/") ? path.slice(1) : path;
  const at = (i: number) => {
    let n = -1;
    for (let k = 0; k < i; k++) {
      n = raw.indexOf("/", n + 1);
      if (n < 0) return raw.length;
    }
    return n;
  };
  const firstEnd = at(1);
  const first = decodeOnce(raw.slice(0, firstEnd));
  if (first === null) return { status: "INVALID", rule: "bad-escape" };
  if (first === "") return { status: "INVALID", rule: "empty" };
  const after = (end: number) => (end < raw.length ? raw.slice(end + 1) : "");
  if (!first.includes(":")) {
    if (!ALIAS.test(first)) return { status: "INVALID", rule: "bad-alias" };
    return { status: "ALIAS", alias: first, rest: after(firstEnd) };
  }
  const [ns, id] = first.split(/:(.*)/s, 2) as [string, string];
  if (ns !== "eip155") return { status: "INVALID", rule: "unsupported-namespace" };
  if (!CHAIN_ID.test(id) || !Number.isSafeInteger(Number(id)))
    return { status: "INVALID", rule: "bad-chain-id" };
  const secondEnd = at(2);
  const ledger = decodeOnce(raw.slice(firstEnd + 1, secondEnd));
  if (ledger === null) return { status: "INVALID", rule: "bad-escape" };
  if (firstEnd >= raw.length || !ADDRESS.test(ledger))
    return { status: "INVALID", rule: "bad-ledger" };
  const realm: RealmRef = { chainId: Number(id), ledger: ledger.toLowerCase() as Address };
  return { status: "FULL", realm, canonical: formatRealm(realm), rest: after(secondEnd) };
}
