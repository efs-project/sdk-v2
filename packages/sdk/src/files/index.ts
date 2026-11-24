// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/files`: verified byte reads (open a file, read ranges or the whole file).
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
