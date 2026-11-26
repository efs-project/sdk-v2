// SPDX-License-Identifier: MIT
// The SDK's word fold: what a typed word becomes before the chain's word grammar checks it. INTERIM (PM default D15,
// 2026-11-26) until the fold rule is ruled (Q53), then replaced by the ruled rule, which extends this one and never
// contradicts it:
//   - a word made only of ASCII: trimmed of spaces and tabs, each run of spaces or tabs inside becomes one underscore
//     (ruled: D-B 2026-09-10, spec §6), and A–Z become a–z;
//   - any other word: exactly as typed, capitals and spaces included (the grammar then judges it as today).
// Both candidate rules (NFKC_Casefold, or lowercase) give the same word for every ASCII input, so no id this fold
// makes changes when the rule is ruled. A word that mixes ASCII with other text is left alone because a rule could
// fold it differently (Straße to strasse; École to école).
import type { FoldStep } from "./links.js";

/** The fold's name, for an app that says which fold it applied ("Saved as notes"). */
export const FOLD_RULE = "efs-sdk/fold/interim-ascii-1";

/** Every UTF-16 code unit below 0x80: the word is ASCII only. */
const asciiOnly = (w: string): boolean => {
  for (let i = 0; i < w.length; i++) if (w.charCodeAt(i) >= 0x80) return false;
  return true;
};

/** Fold one typed word (see the header). Never fails: the chain's grammar judges the result (empty, controls, …). */
export const foldWord: FoldStep = (typed) => {
  if (!asciiOnly(typed)) return { ok: true, word: typed };
  const word = typed
    .replace(/^[ \t]+|[ \t]+$/g, "")
    .replace(/[ \t]+/g, "_")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
  return { ok: true, word };
};
