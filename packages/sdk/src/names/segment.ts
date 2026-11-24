// SPDX-License-Identifier: MIT
// Path segment codecs (naming reconciliation §URLs). Wire form: RFC 3986 percent-encoding, unreserved characters
// literal, uppercase %HH. Display form: IRI text with a small escape set, plus any default-ignorable scalar escaped
// so an invisible character can't hide in a shared link. Parsing decodes exactly once and is strict UTF-8.
import { utf8Encode } from "../core/platform.js";
import { decodeScalars } from "./name.js";

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const DISPLAY_ESCAPE = new Set([
  "%",
  "/",
  "?",
  "#",
  "[",
  "]",
  "\\",
  " ",
  '"',
  "<",
  ">",
  "^",
  "`",
  "{",
  "}",
  "|",
]);
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

const pct = (b: number): string => `%${b.toString(16).toUpperCase().padStart(2, "0")}`;

/** Canonical wire segment for exact name bytes. */
export function wireSegment(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += b < 0x80 && UNRESERVED.test(c) ? c : pct(b);
  }
  return out;
}

/** Human-friendly display segment for name text. Parses back to the same bytes as the wire form. */
export function displaySegment(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80)
      out += DISPLAY_ESCAPE.has(ch) || cp < 0x21 || cp === 0x7f ? wireSegment(utf8Encode(ch)) : ch;
    else out += DEFAULT_IGNORABLE.test(ch) ? wireSegment(utf8Encode(ch)) : ch;
  }
  return out;
}

export type SegmentParse =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; error: "slash" | "malformed-escape" | "malformed-utf8" };

/** Decode one segment (wire, display or encodeURIComponent form) to exact bytes. Decodes exactly once. */
export function parseSegment(segment: string): SegmentParse {
  if (segment.includes("/")) return { ok: false, error: "slash" };
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; ) {
    if (segment[i] === "%") {
      const m = /^%([0-9A-Fa-f]{2})/.exec(segment.slice(i, i + 3));
      if (!m) return { ok: false, error: "malformed-escape" };
      bytes.push(Number.parseInt(m[1] as string, 16));
      i += 3;
    } else {
      const cp = segment.codePointAt(i) as number;
      for (const b of utf8Encode(String.fromCodePoint(cp))) bytes.push(b);
      i += cp > 0xffff ? 2 : 1;
    }
  }
  const out = new Uint8Array(bytes);
  return decodeScalars(out) ? { ok: true, bytes: out } : { ok: false, error: "malformed-utf8" };
}
