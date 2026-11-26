// SPDX-License-Identifier: MIT
// Tag planners (the tag release): planTag ("thing is in topic, with number n ≥ 0"), planDeny ("not this", n < 0) and
// planUntag (back to "said nothing"). Each reads, at one block, which word pages and path records already exist, the
// writer's own head at each (topic, thing), how many authors ever stated there, and the roll-up lists' sizes at each
// proper ancestor; then it plans:
//   - registration first, in the chain's order (word pages, then path records from two words on, parent first), so
//     every topic is registered strictly before its first statement (FilesFinalValidator code 9). A deep new path may
//     take earlier parts of its own; they are harmless if the save is abandoned;
//   - one statement per target, priced by its gas row (a fresh pair, a later author's first yes, a number change, a
//     lone negative, a mask, a release, a restore) and, for a first statement, the per-level terms at each ancestor;
//   - parts by the planning rule (splitPublications), never a shortened path.
// A batch plans every statement or none, listing each refusal by index. Words are checked against the chain's own
// grammar after the caller's fold (efs/fold/1 is not ruled yet): a refused word is MISUSE, never a revert.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { PartUnit } from "../actions/journal.js";
import type { SequencePartInput } from "../actions/sequence.js";
import {
  batchGasOf,
  type PlannedAction,
  packBatches,
  priceAsNew,
  splitPublications,
} from "../actions/split.js";
import type { EffectView } from "../actions/types.js";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import { type Address, type Hex, lower, type PrincipalId } from "../core/hex.js";
import { type Ctx, EMPTY_BASIS, type FileRef, type RevisionRef } from "../files/bytes.js";
import { decodeCreator, type FolderRef, subjectInfoCall } from "../files/folders.js";
import { checkedGasSetup, type GasOpts } from "../files/plan.js";
import { ledgerViewsAbi, topicLookupReaderAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { checkStableWord, foldWord } from "../names/fold.js";
import type { FoldStep } from "../names/links.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus, headState, neverBoundHead } from "../protocol/status.js";
import {
  checkWord,
  denyAction,
  homeId,
  numberOf,
  pathIds,
  pathRecordAction,
  strengthOf,
  type TopicId,
  type TopicTypes,
  tagAction,
  topicTypesOf,
  untagAction,
  wordPageAction,
  wordPageId,
} from "./topics.js";

/** Where a statement is made: a topic by its words (registered as needed), or a home (an address; no record). */
export type TagPlace = readonly string[] | { kind: "home"; address: Address };
/** What a statement is about: any existing record or subject, or an address. */
export type TagTarget =
  | FileRef
  | RevisionRef
  | FolderRef
  | { kind: "topic"; id: Hex }
  | { kind: "address"; address: Address };

export interface TagInput {
  topic: TagPlace;
  targets: readonly TagTarget[];
  /** planTag: 0..65,535 (default 0). planDeny: −1..−65,536 (default −1). Ignored by planUntag. */
  number?: number;
}

export interface TagPlanOpts extends CallOpts, GasOpts {
  /** Folds each typed word before the chain's grammar checks it. Default: foldWord (interim until the rule is ruled). */
  fold?: FoldStep;
  /** Refuse (TOO_LARGE) rather than plan more parts than this. Default 64. */
  maxParts?: number;
  /** Each part's deadline, in seconds from the block it is planned at (default 15 minutes). */
  deadlineSeconds?: number;
}

export interface TagRefusal {
  index: number;
  code: /** The target names no record or created subject (and is not an address). */
    | "TARGET_ABSENT"
    /** Your statement there already has this number. */
    | "UNCHANGED"
    /** planUntag: you have said nothing there to take back. */
    | "NOT_STATED";
  target: TagTarget;
}

export interface TagStatementReview {
  target: TagTarget;
  /** The thing's word: the target's id, or the padded address. */
  thing: Hex;
  position: Hex;
  /** The number this statement sets (null: untag, back to "said nothing"). */
  number: number | null;
  /** Your number there before (null when you said nothing). */
  before: number | null;
  /** Your first statement on this (topic, thing): it files the first-statement lists. */
  first: boolean;
}

export interface TagReview {
  kind: "efs.tagReview";
  author: PrincipalId;
  /** The place: a topic (its words and id) or a home (its address and id). */
  place:
    | { kind: "topic"; words: readonly string[]; id: TopicId }
    | { kind: "home"; address: Address; id: Hex };
  /** The topics this save registers (each missing prefix, root first), with their ids. */
  newTopics: readonly { words: readonly string[]; id: TopicId }[];
  /** Records the save publishes (word pages and path records). */
  records: number;
  statements: readonly TagStatementReview[];
  parts: number;
  prompts: { sequential: number; atomicBatch: number };
  gas: { perPart: readonly number[]; schedule: string };
}

export type TagPlanResult =
  | {
      kind: "efs.tagPlan";
      status: "PLANNED";
      parts: SequencePartInput[];
      review: TagReview;
      basis: Basis;
    }
  | { kind: "efs.tagPlan"; status: "REFUSED"; refused: readonly TagRefusal[]; basis: Basis }
  | { kind: "efs.tagPlan"; status: "TOO_LARGE"; reason: Reason }
  /** The chain could not be read (or answered something this SDK does not accept): nothing was decided. */
  | { kind: "efs.tagPlan"; status: "UNKNOWN"; reason: Reason; basis?: Basis };

type Mode = "tag" | "deny" | "untag";

/** Plan "each target is in this topic (or home), with number n ≥ 0" (default 0). */
export const planTag = (
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: TagInput,
  o: TagPlanOpts = {},
): Promise<TagPlanResult> => plan(efs, writer, input, "tag", o);
/** Plan "not this" for each target at this topic (or home), with number n < 0 (default −1). */
export const planDeny = (
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: TagInput,
  o: TagPlanOpts = {},
): Promise<TagPlanResult> => plan(efs, writer, input, "deny", o);
/** Plan taking your statements back (RELEASE): you say nothing about these targets there any more. */
export const planUntag = (
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: Omit<TagInput, "number">,
  o: TagPlanOpts = {},
): Promise<TagPlanResult> => plan(efs, writer, input, "untag", o);

/** The thing's word for a target, and what proves it exists. */
function thingOf(t: TagTarget, i: number): { thing: Hex; proof: "subject" | "record" | "address" } {
  const word = (h: unknown, what: string): Hex => {
    if (typeof h !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h))
      throw misuse(`target ${i}: ${what} is 32 bytes of hex`, { index: i });
    return lower(h as Hex);
  };
  switch (t?.kind) {
    case "file":
      return { thing: word(t.subject, "a file's subject"), proof: "subject" };
    case "revision":
      return { thing: word(t.recordId, "a revision's record id"), proof: "record" };
    case "folder":
      return { thing: word(t.directory, "a folder's record id"), proof: "record" };
    case "topic":
      return { thing: word(t.id, "a topic id"), proof: "record" };
    case "address":
      return { thing: homeId(t.address), proof: "address" };
    default:
      throw misuse(`target ${i} is not a file, revision, folder, topic or address`, { index: i });
  }
}

/** The place's id, its words (topics), every prefix's id root first, and the proper ancestors. */
/** @internal A place from words (checked after the fold, with every prefix's id) or a home. */
export function placeOf(
  t: TopicTypes,
  p: TagPlace,
  fold: FoldStep | undefined,
  /** A write that adds a statement: refuse a word that isn't stable until the fold rule is ruled (checkStableWord). */
  adds = false,
): { place: TagReview["place"]; words: string[]; ids: TopicId[] } {
  if (!Array.isArray(p)) {
    const home = p as { kind: "home"; address: Address };
    if (home?.kind !== "home")
      throw misuse("a place is a list of words or { kind: 'home', address }");
    return {
      place: { kind: "home", address: home.address, id: homeId(home.address) },
      words: [],
      ids: [],
    };
  }
  if (p.length === 0) throw misuse("a topic is at least one word");
  const step = fold ?? foldWord;
  const words = (p as readonly string[]).map((typed, i) => {
    const f = step(typed);
    if (!f.ok) throw misuse(`word ${i} does not fold (${f.rule})`, { index: i });
    const w = f.word;
    const c = checkWord(w);
    if (!c.ok)
      throw misuse(`word ${i} is not a word the chain admits (code ${c.code}: ${c.rule})`, {
        index: i,
      });
    if (adds) {
      const st = checkStableWord(w);
      if (!st.ok)
        throw misuse(
          `word ${i} can't be used until the tag text rule is chosen (${st.check}): "${w}"`,
          { index: i, rule: "unstable-until-ruled", check: st.check },
        );
    }
    return w;
  });
  const ids = pathIds(t, words);
  return { place: { kind: "topic", words, id: ids[ids.length - 1] as TopicId }, words, ids };
}

/** @internal */
export const failed = (out: { ok: false; reason: Reason } | undefined): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
});
/** @internal */
export const badReply = (what: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", `${what} did not decode`),
});
/** @internal */
export const callOf = (
  to: Hex,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): CallRequest => ({
  to: to as `0x${string}`,
  data: encodeFunctionData({ abi: abi as never, functionName, args } as never),
});
/** @internal */
export function decoded<T>(
  abi: readonly unknown[],
  functionName: string,
  out: { ok: boolean; result?: unknown } | undefined,
): Step<T> {
  if (!out?.ok) return failed(out as { ok: false; reason: Reason } | undefined);
  try {
    return {
      ok: true,
      value: decodeFunctionResult({
        abi: abi as never,
        functionName,
        data: out.result as Hex,
      } as never) as T,
    };
  } catch {
    return badReply(functionName);
  }
}

type RawHead = { state: number; revision: bigint; strength: number; targetKind: number };
/** The most ids one records() call takes (Limits.maxReadIds). */
export const READ_IDS = 64;

async function plan(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: TagInput,
  mode: Mode,
  o: TagPlanOpts,
): Promise<TagPlanResult> {
  const d = efs.deployment;
  const t = topicTypesOf(d);
  const lookup = d.readers.topicLookup;
  if (!lookup)
    throw misuse("this deployment names no topic lookup reader (it predates the tag release)");
  if (!input.targets?.length) throw misuse("a tag plan needs at least one target");
  const me = lower(writer.principal) as PrincipalId;
  const n = mode === "untag" ? null : (input.number ?? (mode === "tag" ? 0 : -1));
  if (n !== null) {
    const s = strengthOf(n);
    if (mode === "tag" && s.unbind)
      throw misuse("planTag's number is 0 or more: use planDeny for a negative one");
    if (mode === "deny" && !s.unbind)
      throw misuse("planDeny's number is below 0: use planTag for 0 or more");
  }
  const { place, words, ids } = placeOf(t, input.topic, o.fold, mode !== "untag");
  const placeId = place.id;
  // Every word's page, so a tag on an existing topic republishes nothing.
  const pageIds = words.map((w) => lower(wordPageId(t, w)) as Hex);
  const ancestors = ids.slice(0, -1);
  const things = input.targets.map((x, i) => ({ target: x, ...thingOf(x, i) }));
  if (new Set(things.map((x) => x.thing)).size !== things.length)
    throw misuse("the same target is listed twice");
  const positions = things.map((x) => lower(positionKey(PURPOSES.tag, placeId, x.thing)));

  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.tagPlan",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  type Seen = {
    present: Set<string>;
    created: Map<number, boolean>;
    heads: RawHead[];
    statements: bigint[];
    mineBelow: bigint[];
    sharedBelow: bigint[];
  };
  const r = await onEndpoint<Seen>(
    efs._internal.pool,
    async (s: Session) => {
      // One batch: records (every word page, every path record, record targets), created subjects, heads, author
      // counts, roll-up sizes. records() takes at most READ_IDS ids a call, so the ids go in chunks.
      const recordIds = [
        ...new Set([
          ...pageIds,
          ...ids,
          ...things.filter((x) => x.proof === "record").map((x) => x.thing),
        ]),
      ];
      const calls: CallRequest[] = [];
      const chunks: { at: number; ids: Hex[] }[] = [];
      for (let k = 0; k < recordIds.length; k += READ_IDS) {
        const chunk = recordIds.slice(k, k + READ_IDS) as Hex[];
        chunks.push({
          at:
            calls.push(
              callOf(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, chunk]),
            ) - 1,
          ids: chunk,
        });
      }
      const subjIdx = things.map((x) =>
        x.proof === "subject" ? calls.push(subjectInfoCall(efs, x.thing)) - 1 : -1,
      );
      const headIdx = positions.map(
        (p) =>
          calls.push(
            callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [d.ledger, [me], p]),
          ) - 1,
      );
      const authorIdx = positions.map(
        (p) =>
          calls.push(callOf(lookup, topicLookupReaderAbi, "authorCount", [p, EMPTY_BASIS])) - 1,
      );
      const mineIdx = ancestors.map(
        (a) =>
          calls.push(
            callOf(lookup, topicLookupReaderAbi, "entryCount", [
              me,
              PURPOSES.tag,
              a,
              true,
              EMPTY_BASIS,
            ]),
          ) - 1,
      );
      const sharedIdx = ancestors.map(
        (a) =>
          calls.push(
            callOf(lookup, topicLookupReaderAbi, "placeCount", [
              PURPOSES.tag,
              a,
              true,
              EMPTY_BASIS,
            ]),
          ) - 1,
      );
      ctx.requests += calls.length;
      const outs = await callsAt(s, basis.blockHash, calls);
      const present = new Set<string>();
      for (const c of chunks) {
        const rec = decoded<[readonly number[], readonly unknown[]]>(
          ledgerViewsAbi,
          "records",
          outs[c.at],
        );
        if (!rec.ok) return rec;
        const [statuses] = rec.value;
        if (statuses.length !== c.ids.length) return badReply("records (one per id)");
        for (const [i, st] of statuses.entries()) {
          const cs = chainStatus(st);
          if (cs === "PRESENT") present.add(c.ids[i] as string);
          // Anything but a proven absence is not "absent": the plan is UNKNOWN, never a false TARGET_ABSENT.
          else if (cs !== "ABSENT_PROVEN")
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason("NOT_YET_DECIDABLE", "transient", `records answered ${cs}`),
            };
        }
      }
      const created = new Map<number, boolean>();
      for (const [i, k] of subjIdx.entries()) {
        if (k < 0) continue;
        const c = decodeCreator(outs[k]);
        if (!c.ok) return c;
        created.set(i, c.value !== null);
      }
      const heads: RawHead[] = [];
      for (const k of headIdx) {
        const h = decoded<[number, unknown, number, readonly RawHead[]]>(
          ledgerViewsAbi,
          "headsAt",
          outs[k],
        );
        if (!h.ok) return h;
        const mine = h.value[3][0];
        if (!mine) return badReply("headsAt (one head per Lens author)");
        heads.push({
          state: Number(mine.state),
          revision: BigInt(mine.revision),
          strength: Number(mine.strength),
          targetKind: Number(mine.targetKind),
        });
      }
      // Counts only price the plan: an unreadable one is priced as the dearer (new) case, never refused.
      const counted = (k: number, fn: "authorCount" | "entryCount" | "placeCount"): bigint => {
        const c = decoded<[{ status: number }, number, bigint, bigint]>(
          topicLookupReaderAbi,
          fn,
          outs[k],
        );
        if (!c.ok || chainStatus(c.value[0].status) !== "PRESENT") return 0n;
        return fn === "placeCount" ? BigInt(c.value[3]) : BigInt(c.value[2]);
      };
      return {
        ok: true,
        value: {
          present,
          created,
          heads,
          statements: authorIdx.map((k) => counted(k, "authorCount")),
          mineBelow: mineIdx.map((k) => counted(k, "entryCount")),
          sharedBelow: sharedIdx.map((k) => counted(k, "placeCount")),
        },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.tagPlan", status: "UNKNOWN", reason: r.reason, basis };
  const seen = r.value;

  // ---- registration: each missing word page, then each missing path record, root first
  const pages = words.map((_, i) => i).filter((i) => !seen.present.has(pageIds[i] as string));
  const paths = ids
    .map((id, i) => ({ id, len: i + 1 }))
    .filter((x) => x.len >= 2 && !seen.present.has(x.id));
  const registration: PlannedAction[] = [
    ...pages.map((i) => {
      const a = wordPageAction(t, words[i] as string);
      return { action: a.action, body: a.body, shape: "topic-word/1" };
    }),
    ...paths.map((x) => {
      const a = pathRecordAction(t, ids[x.len - 2] as Hex, words[x.len - 1] as string);
      return { action: a.action, body: a.body, shape: "topic/1" };
    }),
  ];
  const newTopics = ids
    .map((id, i) => ({ words: words.slice(0, i + 1), id }))
    .filter((x) => !seen.present.has(x.id));

  // ---- the statements
  const refused: TagRefusal[] = [];
  const statements: PlannedAction[] = [];
  const reviews: TagStatementReview[] = [];
  const mineFiled = seen.mineBelow.map(Number);
  const sharedFiled = seen.sharedBelow.map(Number);
  const levels = (
    shared: boolean,
  ): Partial<Record<"mineNew" | "mineExisting" | "sharedNew" | "sharedExisting", number>> => {
    const out: Record<string, number> = {};
    ancestors.forEach((_, a) => {
      const m = priceAsNew(mineFiled[a] ?? 0) ? "mineNew" : "mineExisting";
      out[m] = (out[m] ?? 0) + 1;
      mineFiled[a] = (mineFiled[a] ?? 0) + 1;
      if (shared) {
        const sh = priceAsNew(sharedFiled[a] ?? 0) ? "sharedNew" : "sharedExisting";
        out[sh] = (out[sh] ?? 0) + 1;
        sharedFiled[a] = (sharedFiled[a] ?? 0) + 1;
      }
    });
    return out;
  };
  for (const [i, x] of things.entries()) {
    const head = seen.heads[i] as RawHead;
    const state = headState(head.state);
    const before = numberOf(head.state, head.strength);
    const exists =
      x.proof === "address" ||
      (x.proof === "record" ? seen.present.has(x.thing) : seen.created.get(i) === true);
    if (!exists) {
      refused.push({ index: i, code: "TARGET_ABSENT", target: x.target });
      continue;
    }
    const freshPair = (seen.statements[i] ?? 0n) === 0n;
    let a: PlannedAction;
    let first = false;
    if (mode === "untag") {
      if (state !== "BOUND" && state !== "MASKED") {
        refused.push({ index: i, code: "NOT_STATED", target: x.target });
        continue;
      }
      a = {
        action: untagAction(placeId, x.thing, head.revision),
        body: "0x",
        bindRow: "releaseTag",
        firstStatement: false,
      };
    } else if (before !== null && before === n) {
      refused.push({ index: i, code: "UNCHANGED", target: x.target });
      continue;
    } else if (mode === "tag") {
      first = state === "UNSET";
      a = {
        action: tagAction(placeId, x.thing, head.revision, n as number),
        body: "0x",
        bindRow: first
          ? freshPair
            ? "bindTagFresh"
            : "bindTagSecondAuthor"
          : state === "BOUND"
            ? "bindTagNumberChange"
            : // a yes where you only ever said no (perhaps released): the kernel writes the target fresh
              neverBoundHead(head)
              ? "bindTagAfterNo"
              : "restoreTag",
        firstStatement: first,
        // a first yes files every roll-up: the author's own and the shared one at each ancestor
        ...(first && ancestors.length ? { levels: levels(true) } : {}),
      };
    } else {
      first = state === "UNSET";
      a = {
        action: denyAction(placeId, x.thing, head.revision, n as number),
        body: "0x",
        bindRow: first ? "unbindTagLone" : "unbindTag",
        firstStatement: first,
        // a first "not this" files the author's roll-up, and the shared one only at a fresh pair
        ...(first && ancestors.length ? { levels: levels(freshPair) } : {}),
      };
    }
    statements.push(a);
    reviews.push({
      target: x.target,
      thing: x.thing,
      position: positions[i] as Hex,
      number: n,
      before,
      first,
    });
  }
  if (refused.length) return { kind: "efs.tagPlan", status: "REFUSED", refused, basis };

  // ---- parts
  const g = await checkedGasSetup(efs, o);
  if (!g.ok) return { kind: "efs.tagPlan", status: "UNKNOWN", reason: g.reason, basis };
  const gas = g.gas;
  const all = [...registration, ...statements];
  const split = splitPublications(all, {
    model: gas.model,
    limits: d.limits,
    txGasCap: gas.txGasCap,
    headroom: gas.headroom,
    ...(gas.blockGasLimit !== undefined ? { blockGasLimit: gas.blockGasLimit } : {}),
    typeNames: gas.typeNames,
    firstWrite: true,
  });
  if (!split.ok) return { kind: "efs.tagPlan", status: "TOO_LARGE", reason: split.reason };
  const maxParts = o.maxParts ?? 64;
  if (split.parts.length > maxParts)
    return {
      kind: "efs.tagPlan",
      status: "TOO_LARGE",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${split.parts.length} publications; the limit is ${maxParts}`,
      ),
    };
  const regSet = new Set(registration);
  const code = mode === "tag" ? "tags.tag" : mode === "deny" ? "tags.deny" : "tags.untag";
  const total = split.parts.length;
  const parts = split.parts.map((part, k): SequencePartInput => {
    const stmts = part.actions.filter((a) => !regSet.has(a));
    const effects: EffectView[] = stmts.length
      ? stmts.map((a) => ({
          code,
          args: {
            topic: placeId,
            thing: a.action.role,
            ...(n !== null ? { number: String(n) } : {}),
            part: String(k + 1),
            parts: String(total),
            stage: "finish",
          },
          text: `${mode === "untag" ? "Untag" : mode === "deny" ? "Not this" : "Tag"} in ${place.kind === "topic" ? `/${words.join("/")}` : place.address}`,
        }))
      : [
          {
            code: "tags.register",
            args: { topic: placeId, part: String(k + 1), parts: String(total), stage: "register" },
            text: `Register /${words.join("/")}`,
          },
        ];
    // Units: the registration this part carries is one run, and each statement is one. A re-split never cuts a
    // statement from the registration before it, and keeps the order.
    const units: PartUnit[] = [];
    const regCount = part.actions.filter((a) => regSet.has(a)).length;
    if (regCount)
      units.push({
        actions: regCount,
        effect: {
          code: "tags.register",
          args: { topic: placeId, part: String(k + 1), parts: String(total), stage: "register" },
          text: `Register /${words.join("/")}`,
        },
      });
    for (let j = 0; j < stmts.length; j++)
      units.push({ actions: 1, effect: effects[j] as EffectView });
    return {
      actions: part.actions.map((a) => a.action),
      bodies: part.actions.map((a) => a.body),
      effects,
      ...(o.deadlineSeconds !== undefined ? { deadlineSeconds: o.deadlineSeconds } : {}),
      // The planner's own pricing (rows and per-level terms) is what an atomic batch is packed by.
      ...batchGasOf(part),
      // Registration first, then the statements: the order the actions already have.
      ...(regCount === 0 || part.actions.slice(0, regCount).every((a) => regSet.has(a))
        ? { units }
        : {}),
    };
  });
  const review: TagReview = {
    kind: "efs.tagReview",
    author: me,
    place,
    newTopics,
    records: registration.length,
    statements: reviews,
    parts: total,
    prompts: { sequential: total, atomicBatch: packBatches(parts, gas).length },
    gas: { perPart: split.parts.map((p) => p.gas), schedule: gas.model.schedule },
  };
  return { kind: "efs.tagPlan", status: "PLANNED", parts, review, basis };
}
