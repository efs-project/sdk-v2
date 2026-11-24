// SPDX-License-Identifier: MIT
// Shareable links to EFS objects, as one fragment-safe string an app puts in its route (for example after
// `#/files/`). Two kinds exist today:
//
//   ~efs/o/<subject>   an object link: a subject id (stable across renames; opens the current head under a Lens)
//   ~efs/v/<record>    a revision link: one immutable revision record (exact bytes forever; no Lens needed)
//
// Ids are 0x + 64 lowercase hex. The first segment is `~efs`, a prefix the name profile reserves, so no path can
// ever look like these links: path links (after the tags-vs-directories ruling) can use any other first segment.
// The strings contain only [0-9a-z~/x], so they need no escaping in a URL path, query or fragment.
import { misuse } from "../core/errors.js";
import type { RecordId, SubjectId } from "../core/hex.js";

/** An object by subject id. Files open from it today; folders will reuse the same form. */
export interface ObjectLink {
  kind: "object";
  subject: SubjectId;
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
  | "unsupported-parameter";

export const LINK_PREFIX = "~efs";
const ID = /^0x[0-9a-fA-F]{64}$/;

/** The link string for an object or revision. Throws MISUSE for an id that is not 32-byte hex. */
export function link(target: LinkTarget): string {
  const id = target.kind === "revision" ? target.recordId : target.subject;
  if (typeof id !== "string" || !ID.test(id))
    throw misuse("link: the id must be 0x followed by 64 hex digits", { kind: target.kind });
  return `${LINK_PREFIX}/${target.kind === "revision" ? "v" : "o"}/${id.toLowerCase()}`;
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
  if (q >= 0) return { status: "INVALID", rule: "unsupported-parameter" };
  if (kind !== "o" && kind !== "v") return { status: "INVALID", rule: "unknown-link-kind" };
  if (id === undefined || !ID.test(id) || rest.length > 0)
    return { status: "INVALID", rule: "bad-id" };
  const target: ObjectLink | RevisionLink =
    kind === "o"
      ? { kind: "object", subject: id.toLowerCase() as SubjectId }
      : { kind: "revision", recordId: id.toLowerCase() as RecordId };
  return { status: "OK", target, canonical: link(target) };
}
