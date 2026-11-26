// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/tags`: topics, tags and homes (the tag release). Pure ids and the chain's word and text grammars, the tag
 * planners (registration before the tag, the 16-bit number, pricing by the gas model's tag rows), and the topic
 * readers' views (Mine, Everyone, Raw; exact or roll-up) with the page laws: a short page is never the end, and
 * repeats are removed by thing across pages. Topic statements: planLabel, planSame, planBroader, and the names they
 * give (labelOf, topicName) under a Lens. See docs/design/tags-0.1.md.
 */

export type {
  FileName,
  FileNameInput,
  FileNameRow,
  FileNamesOpts,
  FileNamesResult,
} from "./filenames.js";
export { fileNames } from "./filenames.js";
export type { LensTagsOpts, ThingTagRow, ThingTagsPage } from "./lenstags.js";
export { lensTagsOf } from "./lenstags.js";
export type {
  MergedCursor,
  MergedHow,
  MergedItemsOpts,
  MergedList,
  MergedPage,
  MergedRow,
  MissingList,
} from "./merged.js";
export { topicItemsMerged } from "./merged.js";
export type { Label, LabelResult, NameOpts, SegmentName, TopicNameResult } from "./names.js";
export { labelOf, topicName } from "./names.js";
export type {
  TagInput,
  TagPlace,
  TagPlanOpts,
  TagPlanResult,
  TagRefusal,
  TagReview,
  TagStatementReview,
  TagTarget,
} from "./plan.js";
export { planDeny, planTag, planUntag } from "./plan.js";
export type {
  CountResult,
  Decider,
  FiledRow,
  LookupPage,
  PlaceCountRow,
  PlacesOpts,
  ScanStatus,
  ThingKind,
  TopicCursor,
  TopicItemsOpts,
  TopicPage,
  TopicPathResult,
  TopicPlace,
  TopicRow,
  TopicView,
} from "./read.js";
export {
  authorCount,
  placeCount,
  placeId,
  tagsOf,
  topicChildren,
  topicItems,
  topicPath,
  wordPage,
} from "./read.js";
export type {
  BroaderInput,
  LabelInput,
  SameInput,
  TopicStatementPlanResult,
  TopicStatementReview,
} from "./statements.js";
export { langTag, planBroader, planLabel, planSame } from "./statements.js";
export type {
  BroaderResult,
  Joined,
  Related,
  SynonymOpts,
  SynonymsResult,
  WordSynonyms,
} from "./synonyms.js";
export { topicBroader, topicSynonyms } from "./synonyms.js";
export type { GrammarCheck, TopicId, TopicTypes } from "./topics.js";
export {
  broaderAction,
  checkText,
  checkWord,
  childId,
  denyAction,
  homeId,
  labelActions,
  labelKey,
  numberOf,
  pathId,
  pathIds,
  propertyAction,
  propertyKey,
  registerPathActions,
  releaseAction,
  sameAction,
  strengthOf,
  tagAction,
  textRecordAction,
  textRecordId,
  topicTypesOf,
  untagAction,
  wordPageId,
} from "./topics.js";
