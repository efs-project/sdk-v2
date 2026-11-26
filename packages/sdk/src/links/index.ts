// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/links`: the route and link grammar alone. Pure string code with no runtime dependencies (no hashing,
 * no ABI, no viem), so an app's startup router can parse routes before the SDK core loads. The same functions are
 * also exported from `@efs/sdk`.
 */

export type { StableWordCheck, UnstableCheck } from "../names/fold.js";
export { checkStableWord, FOLD_RULE, foldWord } from "../names/fold.js";
export type {
  FoldStep,
  HomeLink,
  LinkParse,
  LinkRule,
  LinkTarget,
  ObjectLink,
  ParseLinkOpts,
  PathLink,
  RealmRef,
  RealmRule,
  RealmSplit,
  RevisionLink,
  TopicLink,
} from "../names/links.js";
export {
  formatRealm,
  LINK_PREFIX,
  link,
  MAX_LINK_LENS,
  parseLink,
  splitRealm,
} from "../names/links.js";
