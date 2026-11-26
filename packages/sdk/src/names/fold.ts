// SPDX-License-Identifier: MIT
// The SDK's word fold: what a typed word becomes before the chain's word grammar checks it. INTERIM (PM default D15,
// 2026-11-26) until the fold rule is ruled (Q53), then replaced by the ruled rule, which extends this one and never
// contradicts it:
//   - a word made only of ASCII: the fold evaluation's white-space step (docs/design/fold-evaluation/analyze.py
//     `pre`, the ruled D-B 2026-09-10 / spec section 6), then A–Z to a–z. White space (tab, LF, VT, FF, CR, space)
//     is trimmed at both ends, and a maximal run of white space and underscores that holds at least one white-space
//     character becomes one underscore: "model _ y" and "model y" are model_y, while "model__y", "__init__" and
//     "_tesla" keep their underscores;
//   - any other word: exactly as typed, capitals and spaces included (the grammar then judges it as today).
// Both candidate rules (NFKC_Casefold, or NFC plus lowercase) give this same word for every ASCII input (every
// all-ASCII vector of the evaluation: test/fold.test.ts), so the WORD this fold makes doesn't change when the rule
// is ruled. Its topic id still can: the word Type's id covers the chain's refused-character table, regenerated
// from the pinned Unicode version. A word that mixes ASCII with other text is left alone because a rule could fold
// it differently (Straße to strasse; École to école).
import type { FoldStep } from "./links.js";

/** The fold's name, for an app that says which fold it applied ("Saved as notes"). */
export const FOLD_RULE = "efs-sdk/fold/interim-ascii-1";

/** Every UTF-16 code unit below 0x80: the word is ASCII only. */
const asciiOnly = (w: string): boolean => {
  for (let i = 0; i < w.length; i++) if (w.charCodeAt(i) >= 0x80) return false;
  return true;
};

/** The evaluation's white space among ASCII: tab, LF, VT, FF, CR and space. */
const isSpace = (c: number): boolean => (c >= 0x09 && c <= 0x0d) || c === 0x20;
const UNDERSCORE = 0x5f;

/** Fold one typed word (see the header). Never fails: the chain's grammar judges the result (empty, controls, …). */
export const foldWord: FoldStep = (typed) => {
  if (!asciiOnly(typed)) return { ok: true, word: typed };
  const cps = [...typed].map((ch) => ch.charCodeAt(0));
  let from = 0;
  let to = cps.length;
  while (from < to && isSpace(cps[from] as number)) from++;
  while (to > from && isSpace(cps[to - 1] as number)) to--;
  const out: number[] = [];
  for (let i = from; i < to; ) {
    const c = cps[i] as number;
    if (isSpace(c) || (c === UNDERSCORE && i + 1 < to && isSpace(cps[i + 1] as number))) {
      // A run of white space and underscores: one underscore if it holds any white space (an underscore just before
      // it joins the run too).
      let j = i;
      let saw = false;
      while (j < to && (isSpace(cps[j] as number) || cps[j] === UNDERSCORE)) {
        saw = saw || isSpace(cps[j] as number);
        j++;
      }
      if (saw) {
        while (out.length > 0 && out[out.length - 1] === UNDERSCORE) out.pop();
        out.push(UNDERSCORE);
        i = j;
        continue;
      }
    }
    out.push(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
    i++;
  }
  return { ok: true, word: String.fromCharCode(...out) };
};

/** Why a word is not stable until the fold rule is ruled (checkStableWord). */
export type UnstableCheck =
  | "nfc"
  | "lowercase"
  | "nfkc-casefold"
  | "unassigned-or-private"
  | "leading-mark";
export type StableWordCheck = { ok: true } | { ok: false; check: UnstableCheck };

const CHANGES_UNDER_NFKC_CASEFOLD = /\p{Changes_When_NFKC_Casefolded}/u;
const PRIVATE_OR_UNASSIGNED = /[\p{Co}\p{Cn}]/u;
const LEADING_MARK = /^\p{M}/u;

/**
 * Whether a word reads the same under both candidate fold rules, so writing it now can never leave text a ruling
 * would fold differently. INTERIM, with the interim fold, until Q53 (tag PM, 2026-11-26). An all-ASCII word is always
 * stable (foldWord made it so). A word with any other character is stable only when all of these hold:
 *   - it is NFC already;
 *   - lowercasing leaves it unchanged (rule A's fixed point, the final sigma included);
 *   - no character of it changes under NFKC_Casefold (rule B's fixed point: ß, ς, both Cherokee cases, full-width
 *     forms, ligatures and default-ignorable characters);
 *   - it holds no private-use or unassigned character, and doesn't start with a combining mark (both rules refuse
 *     those).
 * These checks need no tables of our own: they use the engine's Unicode data (Node 24 and current browsers: Unicode
 * 16). Until a version is pinned, two engines can disagree on characters newer than one of them. The planners apply
 * it to writes that add a statement; reads and links still pass such a word through, and taking a statement back is
 * never refused, so anything written before can be found and cleaned up.
 */
export function checkStableWord(word: string): StableWordCheck {
  if (asciiOnly(word)) return { ok: true };
  if (word.normalize("NFC") !== word) return { ok: false, check: "nfc" };
  if (word.toLowerCase() !== word) return { ok: false, check: "lowercase" };
  if (CHANGES_UNDER_NFKC_CASEFOLD.test(word)) return { ok: false, check: "nfkc-casefold" };
  if (PRIVATE_OR_UNASSIGNED.test(word)) return { ok: false, check: "unassigned-or-private" };
  if (LEADING_MARK.test(word)) return { ok: false, check: "leading-mark" };
  return { ok: true };
}
