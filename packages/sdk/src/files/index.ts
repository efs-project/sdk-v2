// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/files`: verified byte reads (open a file, read ranges or the whole file, or stream verified chunks), and
 * the edit planner (planEditFile: a new revision of an existing file, for writer.runSequence), and normalizeMediaType
 * (the check planning applies to a declared media type, for validating one as it is typed).
 * Folders and homes (an address as a folder parent, HomeRef): listFolder, lookupEntry and resolvePath read one under
 * a Lens, always from a parent the caller names, and openHome / openPath open a home link;
 * planCreateFile, planCreateFolder, planMoveEntries, planRemoveEntries, planRestoreEntries and planUnhideEntries plan
 * the writer's own entries, and planHideEntries hides other authors' entries for views that put the writer first, for
 * writer.runSequence.
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
export type {
  CreateFileInput,
  CreateFileReview,
  CreateFolderInput,
  CreateFolderReview,
  EntryRefusal,
  FolderPlanOpts,
  FolderPlanResult,
  FolderReviewBase,
  HideEntriesInput,
  HideReview,
  HideReviewItem,
  LensView,
  MoveEntriesInput,
  MoveInput,
  MoveReview,
  MoveReviewItem,
  RemoveEntriesInput,
  RemoveReview,
  RemoveReviewItem,
  RestoreEntriesInput,
  RestoreReview,
  RestoreReviewItem,
  UnhideEntriesInput,
  UnhideReview,
  UnhideReviewItem,
} from "./entries.js";
export {
  planCreateFile,
  planCreateFolder,
  planHideEntries,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
  planUnhideEntries,
} from "./entries.js";
export type {
  EntryCandidate,
  EntryKind,
  EntryLookup,
  EntryRef,
  EntryTarget,
  FolderCoverage,
  FolderCursor,
  FolderPage,
  FolderRef,
  FolderRow,
  HomeOpen,
  HomeRef,
  ListFolderOpts,
  ObjectOpen,
  OpenPathOpts,
  ParentRef,
  PathOpen,
  PathResolution,
  PathStep,
  ResolvePathOpts,
} from "./folders.js";
export {
  listFolder,
  lookupEntry,
  openHome,
  openObject,
  openPath,
  resolvePath,
} from "./folders.js";
export type { MediaTypeCheck } from "./media.js";
export { MAX_MEDIA_TYPE_BYTES, normalizeMediaType } from "./media.js";
export type {
  LastBound,
  ListRemovedOpts,
  RemovedCursor,
  RemovedPage,
  RemovedRow,
} from "./removed.js";
export { listRemoved } from "./removed.js";
export type { FileChunks, StreamFailure, StreamOpts } from "./stream.js";
export { fileChunks } from "./stream.js";
export type { UnverifiedChunks, UnverifiedOpts, UnverifiedResult } from "./unverified.js";
export { unverifiedChunks } from "./unverified.js";
export type {
  FileVersion,
  FileVersionsCursor,
  FileVersionsOpts,
  FileVersionsResult,
  LensVersion,
  PublicVersions,
  VersionsDecision,
} from "./versions.js";
export { fileVersions, MAX_VERSIONS_PAGE } from "./versions.js";
