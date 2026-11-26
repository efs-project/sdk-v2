// SPDX-License-Identifier: MIT
// files-name/2: the exact on-chain grammar (contracts src/profiles/rules/FilesNameRule.sol, ported from the
// measured naming experiment). Byte-exact and case-sensitive; the contract never normalizes. NFC is an SDK
// obligation: `normalize` produces it, and `check` reports whether a name is already NFC.
import { utf8Encode } from "../core/platform.js";

/** The name profile folder and file names are checked against: files-name/2 (UTF-8, byte-exact, case-sensitive). */
export const NAME_PROFILE = "files-name/2" as const;
/** The longest name files-name/2 admits, in UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;

export type NameInput = string | Uint8Array;

export type NameCheck =
  | { status: "VALID"; bytes: Uint8Array; text: string; nfc: boolean }
  | { status: "INVALID"; rule: NameRule; at?: number }
  | { status: "UNSUPPORTED_BY_PROFILE"; profile: string };

export type NameRule =
  | "empty"
  | "too-long"
  | "dot-or-dotdot"
  | "reserved-prefix"
  | "malformed-utf8"
  | "excluded-character"
  | "leading-whitespace"
  | "trailing-whitespace";

/** Scalars the rule refuses anywhere in a name (NameRules.sol `Utf8.excluded`). */
export function isExcluded(cp: number): boolean {
  if (cp <= 0x1f) return true; // C0 controls
  if (cp < 0x7f) return cp === 0x2f || cp === 0x5c; // '/' and '\'
  if (cp <= 0x9f) return true; // DEL and C1
  if (cp === 0xad || cp === 0x061c || cp === 0x180e) return true; // soft hyphen, ALM, Mongolian vowel separator
  if (cp === 0x200b || cp === 0x200e || cp === 0x200f) return true; // ZWSP, LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embeddings and overrides
  if (cp === 0x2028 || cp === 0x2029) return true; // line and paragraph separators
  if (cp >= 0x2060 && cp <= 0x2064) return true; // word joiner, invisible operators
  if (cp >= 0x2066 && cp <= 0x206f) return true; // bidi isolates, deprecated format characters
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true; // noncharacters
  if (cp === 0xfeff) return true; // BOM / ZWNBSP
  if (cp >= 0xfff9 && cp <= 0xfffd) return true; // interlinear annotations, OBJ, REPLACEMENT CHARACTER
  return (cp & 0xfffe) === 0xfffe; // U+xFFFE and U+xFFFF in every plane
}

/** Unicode White_Space minus scalars already excluded (NameRules.sol `Utf8.whitespace`). */
export function isNameWhitespace(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** Encode a name as UTF-8 exactly as given (no normalization). */
export function nameBytes(input: NameInput): Uint8Array {
  return typeof input === "string" ? utf8Encode(input) : input;
}

/** Strict UTF-8 decode into scalars: no overlong forms, no surrogates, nothing above U+10FFFF. Null if malformed. */
export function decodeScalars(bytes: Uint8Array): { scalars: number[]; text: string } | null {
  const scalars: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    let cp: number;
    let w: number;
    if (b0 < 0x80) {
      cp = b0;
      w = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      w = 2;
      cp = b0 & 0x1f;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      w = 3;
      cp = b0 & 0x0f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      w = 4;
      cp = b0 & 0x07;
    } else {
      return null;
    }
    if (i + w > bytes.length) return null;
    for (let j = 1; j < w; j++) {
      const c = bytes[i + j] as number;
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (w === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return null;
    if (w === 4 && (cp < 0x10000 || cp > 0x10ffff)) return null;
    scalars.push(cp);
    i += w;
  }
  return { scalars, text: String.fromCodePoint(...scalars) };
}

/**
 * Check a name against files-name/2. Strings are encoded as given: the SDK never re-normalizes a caller's text
 * here, so the result is exactly what the contract would decide. Use `normalize` first for new names.
 */
export function checkName(input: NameInput, profile: string = NAME_PROFILE): NameCheck {
  if (profile !== NAME_PROFILE) return { status: "UNSUPPORTED_BY_PROFILE", profile };
  const bytes = nameBytes(input);
  const n = bytes.length;
  if (n === 0) return { status: "INVALID", rule: "empty" };
  if (n > MAX_NAME_BYTES) return { status: "INVALID", rule: "too-long" };
  if (bytes[0] === 0x2e && (n === 1 || (n === 2 && bytes[1] === 0x2e)))
    return { status: "INVALID", rule: "dot-or-dotdot" };
  if (n >= 4 && bytes[0] === 0x7e && bytes[1] === 0x65 && bytes[2] === 0x66 && bytes[3] === 0x73) {
    return { status: "INVALID", rule: "reserved-prefix" };
  }
  const decoded = decodeScalars(bytes);
  if (!decoded) return { status: "INVALID", rule: "malformed-utf8" };
  const { scalars, text } = decoded;
  for (let i = 0; i < scalars.length; i++) {
    if (isExcluded(scalars[i] as number))
      return { status: "INVALID", rule: "excluded-character", at: i };
  }
  if (isNameWhitespace(scalars[0] as number))
    return { status: "INVALID", rule: "leading-whitespace" };
  if (isNameWhitespace(scalars[scalars.length - 1] as number))
    return { status: "INVALID", rule: "trailing-whitespace" };
  return { status: "VALID", bytes, text, nfc: text.normalize("NFC") === text };
}

/** NFC, the form the SDK writes. Two names that differ only in normalization are different on-chain names. */
export function normalizeName(text: string): string {
  return text.normalize("NFC");
}
