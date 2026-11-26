// SPDX-License-Identifier: MIT
// The kinds a view's rows carry, as one vocabulary, so one filter control works in every view (folders, homes,
// topic pages, word pages). A kind that can't occur in a view matches nothing there and is counted with what the
// filter left out; a string outside the vocabulary is MISUSE, never a filter that matches nothing (a scan from the
// start would then read COMPLETE and empty: a false "none of that kind").
//   file      a Files file (folders: its HEAD under the Lens is a Files revision; topics: its creator's, exact tier)
//   folder    a files-directory/1 record
//   other     anything else (folders: a subject with no Files HEAD under the Lens; topics: another record or subject)
//   subject   topics only, before the exact tier: a created subject (a file, or another app's)
//   revision  topics only: a files-root/1 or files-child/1 record
//   topic     topics only: a topic-word/1 or topic/1 record
//   address   topics only: a padded address
//   invalid   folders only: a row that breaks a Files rule
import { misuse } from "./errors.js";

/**
 * Every kind a listing row can be (file, folder, other, subject, revision, topic, address, invalid): pass a subset
 * as `kinds` to filter a listing; a kind outside this list is MISUSE.
 */
export const VIEW_KINDS = [
  "file",
  "folder",
  "other",
  "subject",
  "revision",
  "topic",
  "address",
  "invalid",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** The kinds of a filter, checked against the vocabulary, deduplicated and sorted; MISUSE for any other string. */
export function checkKinds(kinds: readonly string[]): ViewKind[] {
  const out = [...new Set(kinds)].sort();
  if (out.length === 0) throw misuse("`kinds` names at least one kind");
  const bad = out.find((k) => !(VIEW_KINDS as readonly string[]).includes(k));
  if (bad !== undefined) throw misuse(`"${bad}" is not a kind (${VIEW_KINDS.join(", ")})`);
  return out as ViewKind[];
}
