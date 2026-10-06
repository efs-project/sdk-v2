// SPDX-License-Identifier: MIT
import { stripVTControlCharacters } from "node:util";

// Complete non-TTY diagnostic from the pinned @changesets/cli 3.0.3, including its framing.
const missingChangesetDiagnostic = [
  "🦋 changeset v3.0.3",
  "Some packages have been changed but no changesets were found. Run changeset add to resolve this error.",
  "If this change doesn't need a release, run changeset add --empty.",
  "🦋 Exited with code 1",
].join("\n");

/** Classify Changesets status for the S0 draft release evidence. */
export function changesetStatus(result) {
  const normallyTerminated = result.signal == null && !result.error;
  if (normallyTerminated && result.status === 0) return "ok";
  const stdout = stripVTControlCharacters(result.stdout ?? "");
  const stderr = stripVTControlCharacters(result.stderr ?? "");
  const diagnostic = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (
    normallyTerminated &&
    result.status === 1 &&
    stderr.trim() === "" &&
    diagnostic === missingChangesetDiagnostic
  )
    return "missing changeset (optional during S0)";
  throw new Error(
    `Changesets status failed (exit=${result.status}, signal=${result.signal ?? "none"})\n` +
      `stdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}
