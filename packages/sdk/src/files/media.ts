// SPDX-License-Identifier: MIT
// A file's declared media type (files-content/1 and files-external/1): a hint about the bytes, never their identity.
// It is the rest of the descriptor body, so no length word is stored (contracts docs/LARGE-FILES.md "Media types").
// The chain never normalizes and refuses what does not fit its grammar; the SDK lowercases the type and subtype,
// then checks the same grammar while planning, so a bad value is refused before anything is sent, never as a revert.
//
// The grammar (FilesProfile.mediaTypeRefusal; contracts test/vectors/media.json is the authority): 0–255 bytes, empty
// = unknown. `type "/" subtype [";" parameters]`: each name 1–127 bytes, the first a–z or 0–9, the rest a–z, 0–9 or one
// of ! # $ & - ^ _ . +. From the first ";" to the end, any byte 0x20–0x7e (not parsed further).
import { FILES } from "../generated/constants.js";

/** The longest media type the chain accepts, in bytes (release constants.files.mediaType.maxLength). */
export const MAX_MEDIA_TYPE_BYTES: number = FILES.mediaTypeMaxLength;
/** RFC 6838 restricted-name length limit (the contracts grammar; checked against the vectors). */
const NAME_MAX = 127;

/**
 * The chain's refusal code for media bytes, exactly as FilesProfile.mediaTypeRefusal: 0 admitted (empty is admitted:
 * unknown), 1 longer than 255 bytes, 2 a bad type name, 3 no "/" after the type, 4 a bad subtype name, 5 the subtype
 * is followed by a byte other than ";", 6 a byte outside 0x20–0x7e after the first ";".
 */
export function mediaTypeRefusal(b: Uint8Array): number {
  if (b.length === 0) return 0;
  if (b.length > MAX_MEDIA_TYPE_BYTES) return 1;
  const first = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39);
  const rest = (c: number) =>
    first(c) ||
    c === 0x21 || // !
    c === 0x23 || // #
    c === 0x24 || // $
    c === 0x26 || // &
    c === 0x2d || // -
    c === 0x5e || // ^
    c === 0x5f || // _
    c === 0x2e || // .
    c === 0x2b; //   +
  /** The end of the name starting at i, or -1 when there is none (or it is longer than 127 bytes). */
  const name = (i: number): number => {
    if (i >= b.length || !first(b[i] as number)) return -1;
    let j = i + 1;
    while (j < b.length && rest(b[j] as number)) j++;
    return j - i > NAME_MAX ? -1 : j;
  };
  const t = name(0);
  if (t < 0) return 2;
  if (t >= b.length || b[t] !== 0x2f) return 3;
  const s = name(t + 1);
  if (s < 0) return 4;
  if (s === b.length) return 0;
  if (b[s] !== 0x3b) return 5;
  for (let i = s + 1; i < b.length; i++) {
    const c = b[i] as number;
    if (c < 0x20 || c > 0x7e) return 6;
  }
  return 0;
}

const REFUSAL: Readonly<Record<number, string>> = {
  1: `a media type is at most ${MAX_MEDIA_TYPE_BYTES} bytes`,
  2: "a media type starts with a type name (1–127 bytes: a–z or 0–9 first, then a–z 0–9 ! # $ & - ^ _ . +)",
  3: "the type name must be followed by '/'",
  4: "'/' must be followed by a subtype name (1–127 bytes: a–z or 0–9 first, then a–z 0–9 ! # $ & - ^ _ . +)",
  5: "only ';' may follow the subtype (no spaces, tabs or a second '/')",
  6: "parameters after ';' must be printable ASCII (0x20–0x7e)",
};

/** A media type's bytes as the chain stores them (every admitted string is ASCII, one byte per character). */
export function mediaTypeBytes(mediaType: string): Uint8Array {
  const out = new Uint8Array(mediaType.length);
  for (let i = 0; i < mediaType.length; i++) {
    const c = mediaType.charCodeAt(i);
    out[i] = c > 0xff ? 0xff : c; // never admitted; mediaTypeRefusal refuses the 0xff it maps to
  }
  return out;
}

/** The media type stored in a descriptor's tail: the string when the chain's grammar admits it, else null. */
export function decodeMediaType(b: Uint8Array): string | null {
  if (mediaTypeRefusal(b) !== 0) return null;
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

export type MediaTypeCheck =
  | { ok: true; mediaType: string }
  | { ok: false; code: number; reason: string };

/**
 * Normalize a caller's media type for planning: lowercase A–Z in the type and subtype (before the first ";"), keep
 * the parameters exactly as given, then check the chain's grammar. Returns the exact string to store, or the chain's
 * refusal code and why. "" is admitted: the media type is unknown.
 */
export function normalizeMediaType(input: string): MediaTypeCheck {
  const semi = input.indexOf(";");
  const head = semi === -1 ? input : input.slice(0, semi);
  // Only A–Z fold: anything else outside the name bytes is refused, never mapped.
  const mediaType = head.replace(/[A-Z]/g, (c) => c.toLowerCase()) + input.slice(head.length);
  const code = mediaTypeRefusal(mediaTypeBytes(mediaType));
  if (code === 0) return { ok: true, mediaType };
  return { ok: false, code, reason: REFUSAL[code] as string };
}
