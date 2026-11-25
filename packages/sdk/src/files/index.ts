// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/files`: verified byte reads (open a file, read ranges or the whole file, or stream verified chunks), and
 * the edit planner (planEditFile: a new revision of an existing file, for writer.runSequence).
 * Folder, directory and path reads arrive here too, once the tags-vs-directories ruling settles their shape.
 */

export type {
  ByteGrade,
  ByteRangeResult,
  BytesOpts,
  FileRef,
  Location,
  LocationAttempt,
  OpenedFile,
  OpenResult,
  ReadOpts,
  RevisionRef,
} from "./bytes.js";
export { openFile, readBytes, readRange } from "./bytes.js";
export type {
  EditFileInput,
  EditFileOpts,
  EditLayout,
  EditPlanResult,
  EditReview,
  ExternalContent,
} from "./edit.js";
export { planEditFile } from "./edit.js";
export type { FileChunks, StreamFailure, StreamOpts } from "./stream.js";
export { fileChunks } from "./stream.js";
export type { UnverifiedChunks, UnverifiedOpts, UnverifiedResult } from "./unverified.js";
export { unverifiedChunks } from "./unverified.js";
