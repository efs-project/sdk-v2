// SPDX-License-Identifier: MIT
// Topic statements (the tag release, contracts step 2): planLabel ("this topic or home is called <text> in <lang>",
// a PROPERTY bind to a text/1 record), planSame ("this topic is the same as that one") and planBroader ("this topic
// is narrower than that one"). Each reads, at one block, which word pages, path records and text record already
// exist and the writer's own head at the statement's position; then it plans:
//   - registration first (word pages, then path records, parent first, for both ends), so a first SAME or BROADER
//     finds both topics registered strictly before it (FilesFinalValidator codes 10 and 11; an earlier action of the
//     same publication counts);
//   - the text record when it is new, then the one statement, or with `remove: true` a RELEASE of your own;
//   - parts by the planning rule, each statement priced by its measured gas row (contracts 0fb4804: bindPropertyFresh,
//     bindSameFreshWord, restoreSame, releaseBroader, …); eth_estimateGas decides before each send.
import type { SequencePartInput } from "../actions/sequence.js";
import {
  type BindRow,
  batchGasOf,
  type PlannedAction,
  packBatches,
  splitPublications,
} from "../actions/split.js";
import type { EffectView } from "../actions/types.js";
import type { CallRequest } from "../chain/basis.js";
import { callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { misuse, type Reason, reason } from "../core/errors.js";
import { type Hex, lower, type PrincipalId } from "../core/hex.js";
import type { Ctx } from "../files/bytes.js";
import { gasSetup } from "../files/plan.js";
import { ledgerViewsAbi } from "../generated/abis.js";
import { PURPOSES } from "../generated/constants.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import {
  badReply,
  callOf,
  decoded,
  placeOf,
  READ_IDS,
  type TagPlace,
  type TagPlanOpts,
  type TagReview,
} from "./plan.js";
import {
  broaderAction,
  checkText,
  labelKey,
  pathRecordAction,
  propertyAction,
  releaseAction,
  sameAction,
  type TopicId,
  textRecordAction,
  textRecordId,
  topicTypesOf,
  wordPageAction,
  wordPageId,
} from "./topics.js";

/** A BCP 47 language tag, lowercased (the tag is case-insensitive; EfsTopics' own example is `pt-br`). */
export function langTag(lang: string): string {
  const l = String(lang ?? "").toLowerCase();
  if (!/^[a-z]{2,8}(-[a-z0-9]{1,8})*$/.test(l))
    throw misuse(`not a BCP 47 language tag: ${JSON.stringify(lang)}`);
  return l;
}

export interface LabelInput {
  /** The topic (its words, registered as needed) or a home. */
  topic: TagPlace;
  /** A BCP 47 language tag (`en`, `pt-br`), lowercased before use. */
  lang: string;
  /** The display string (text/1 grammar: 1–255 bytes of UTF-8, no controls). Omit with `remove`. */
  text?: string;
  /** Take your label in this language back (RELEASE) instead. */
  remove?: boolean;
}
export interface SameInput {
  topic: readonly string[];
  other: readonly string[];
  remove?: boolean;
}
export interface BroaderInput {
  topic: readonly string[];
  broader: readonly string[];
  remove?: boolean;
}

export interface TopicStatementReview {
  kind: "efs.topicStatementReview";
  author: PrincipalId;
  purpose: "label" | "same" | "broader";
  /** What the statement is about. */
  subject: TagReview["place"];
  /** label: the language (lowercased) and the text (absent with remove). */
  lang?: string;
  text?: string;
  /** same / broader: the other topic. */
  other?: { words: readonly string[]; id: TopicId };
  /** true: a RELEASE of your statement (back to "said nothing"). */
  remove: boolean;
  /** Your statement there before: its state and target (label: the text record id), or null. */
  before: { state: "BOUND" | "MASKED"; target: Hex } | null;
  /** The topics this save registers, root first, and the records it publishes (those, plus a new text record). */
  newTopics: readonly { words: readonly string[]; id: TopicId }[];
  records: number;
  parts: number;
  prompts: { sequential: number; atomicBatch: number };
  gas: { perPart: readonly number[]; schedule: string };
}

export type TopicStatementPlanResult =
  | {
      kind: "efs.topicStatementPlan";
      status: "PLANNED";
      parts: SequencePartInput[];
      review: TopicStatementReview;
      basis: Basis;
    }
  | {
      kind: "efs.topicStatementPlan";
      /** UNCHANGED: you already say exactly this. NOT_STATED: remove, and you have said nothing there. */
      status: "REFUSED";
      code: "UNCHANGED" | "NOT_STATED";
      basis: Basis;
    }
  | { kind: "efs.topicStatementPlan"; status: "TOO_LARGE"; reason: Reason }
  /** The chain could not be read (or answered something this SDK does not accept): nothing was decided. */
  | { kind: "efs.topicStatementPlan"; status: "UNKNOWN"; reason: Reason; basis?: Basis };

/** Plan a label of a topic or home in one language (or, with `remove`, take yours back). */
export async function planLabel(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: LabelInput,
  o: TagPlanOpts = {},
): Promise<TopicStatementPlanResult> {
  const lang = langTag(input.lang);
  if (input.remove) {
    if (input.text !== undefined) throw misuse("a label removal takes no text");
  } else {
    const c = checkText(input.text ?? "");
    if (!c.ok) throw misuse(`not a text the chain admits (code ${c.code}: ${c.rule})`);
  }
  return plan(
    efs,
    writer,
    { purpose: "label", topic: input.topic, lang, text: input.text },
    !!input.remove,
    o,
  );
}
/** Plan "this topic is the same as that one" (or, with `remove`, take yours back). */
export function planSame(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: SameInput,
  o: TagPlanOpts = {},
): Promise<TopicStatementPlanResult> {
  return plan(
    efs,
    writer,
    { purpose: "same", topic: input.topic, other: input.other },
    !!input.remove,
    o,
  );
}
/** Plan "this topic is narrower than that one" (or, with `remove`, take yours back). */
export function planBroader(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: BroaderInput,
  o: TagPlanOpts = {},
): Promise<TopicStatementPlanResult> {
  return plan(
    efs,
    writer,
    { purpose: "broader", topic: input.topic, other: input.broader },
    !!input.remove,
    o,
  );
}

type Spec =
  | { purpose: "label"; topic: TagPlace; lang: string; text: string | undefined }
  | { purpose: "same" | "broader"; topic: readonly string[]; other: readonly string[] };
type RawHead = { state: number; revision: bigint; target: Hex };
const PURPOSE = {
  label: PURPOSES.property,
  same: PURPOSES.same,
  broader: PURPOSES.broader,
} as const;

async function plan(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  spec: Spec,
  remove: boolean,
  o: TagPlanOpts,
): Promise<TopicStatementPlanResult> {
  const d = efs.deployment;
  const t = topicTypesOf(d);
  const me = lower(writer.principal) as PrincipalId;
  const subject = placeOf(t, spec.topic, o.fold);
  const other =
    spec.purpose === "label"
      ? undefined
      : (() => {
          if (!Array.isArray(spec.other))
            throw misuse(`${spec.purpose}'s other end is a topic: a list of words`);
          const p = placeOf(t, spec.other, o.fold);
          if (p.place.kind !== "topic") throw misuse("both ends are topics");
          return p;
        })();
  if (spec.purpose !== "label" && subject.place.kind !== "topic")
    throw misuse(`${spec.purpose} is said about a topic (a list of words), never a home`);
  const subjectId = subject.place.id;
  const otherId = other?.place.id as Hex | undefined;
  if (otherId !== undefined && lower(otherId) === lower(subjectId))
    throw misuse(
      "a topic is not the same as, or narrower than, itself (the chain refuses it: code 12)",
    );
  const textId =
    spec.purpose === "label" && !remove ? textRecordId(t, spec.text as string) : undefined;
  const purpose = PURPOSE[spec.purpose];
  const role = spec.purpose === "label" ? labelKey(spec.lang) : (otherId as Hex);
  const position = lower(positionKey(purpose, subjectId, role));
  // Both ends' chains of topics, root first, each id once: the registration order.
  const chains = [subject, ...(other ? [other] : [])];
  const topics: { words: string[]; id: Hex; pageOf: Hex; parent: Hex | null }[] = [];
  const seenIds = new Set<string>();
  const pageIds = new Set<string>();
  for (const c of chains)
    c.words.forEach((w, i) => {
      pageIds.add(lower(wordPageId(t, w)));
      const id = lower(c.ids[i] as Hex);
      if (seenIds.has(id)) return;
      seenIds.add(id);
      topics.push({
        words: c.words.slice(0, i + 1),
        id,
        pageOf: lower(wordPageId(t, w)),
        parent: i === 0 ? null : lower(c.ids[i - 1] as Hex),
      });
    });
  const recordIds = [
    ...new Set([...pageIds, ...seenIds, ...(textId ? [lower(textId)] : [])]),
  ] as Hex[];

  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.topicStatementPlan",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint<{ present: Set<string>; head: RawHead }>(
    efs._internal.pool,
    async (s: Session) => {
      const calls: CallRequest[] = [];
      const chunks: { at: number; ids: Hex[] }[] = [];
      for (let k = 0; k < recordIds.length; k += READ_IDS) {
        const chunk = recordIds.slice(k, k + READ_IDS);
        chunks.push({
          at:
            calls.push(
              callOf(d.readers.ledgerViews, ledgerViewsAbi, "records", [d.ledger, chunk]),
            ) - 1,
          ids: chunk,
        });
      }
      const hi =
        calls.push(
          callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [d.ledger, [me], position]),
        ) - 1;
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
          // Anything but a proven absence is not "absent": never plan a registration on a guess.
          else if (cs !== "ABSENT_PROVEN")
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason("NOT_YET_DECIDABLE", "transient", `records answered ${cs}`),
            };
        }
      }
      const h = decoded<[number, unknown, number, readonly RawHead[]]>(
        ledgerViewsAbi,
        "headsAt",
        outs[hi],
      );
      if (!h.ok) return h;
      const mine = h.value[3][0];
      if (!mine || h.value[3].length !== 1) return badReply("headsAt (one head per Lens author)");
      return {
        ok: true,
        value: {
          present,
          head: {
            state: Number(mine.state),
            revision: BigInt(mine.revision),
            target: lower(mine.target),
          },
        },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.topicStatementPlan", status: "UNKNOWN", reason: r.reason, basis };
  const { present, head } = r.value;
  const state = headState(head.state);
  const before = state === "BOUND" || state === "MASKED" ? { state, target: head.target } : null;
  const refused = (code: "UNCHANGED" | "NOT_STATED"): TopicStatementPlanResult => ({
    kind: "efs.topicStatementPlan",
    status: "REFUSED",
    code,
    basis,
  });
  if (remove && !before) return refused("NOT_STATED");
  const target = textId ?? otherId;
  if (!remove && state === "BOUND" && head.target === lower(target as Hex))
    return refused("UNCHANGED");

  // ---- registration (not for a removal: a statement you made was about registered topics)
  const registration: PlannedAction[] = [];
  const newTopics: { words: readonly string[]; id: TopicId }[] = [];
  if (!remove) {
    const pagesDone = new Set<string>();
    for (const x of topics) {
      if (!present.has(x.pageOf) && !pagesDone.has(x.pageOf)) {
        pagesDone.add(x.pageOf);
        const a = wordPageAction(t, x.words[x.words.length - 1] as string);
        registration.push({ action: a.action, body: a.body, shape: "topic-word/1" });
      }
      if (x.parent !== null && !present.has(x.id)) {
        const a = pathRecordAction(t, x.parent, x.words[x.words.length - 1] as string);
        registration.push({ action: a.action, body: a.body, shape: "topic/1" });
      }
      if (!present.has(x.id)) newTopics.push({ words: x.words, id: x.id as TopicId });
    }
  }
  const actions: PlannedAction[] = [...registration];
  let records = registration.length;
  if (spec.purpose === "label" && !remove && !present.has(lower(textId as Hex))) {
    const a = textRecordAction(t, spec.text as string);
    actions.push({ action: a.action, body: a.body, shape: "text/1" });
    records++;
  }
  const rev = head.revision;
  const statement = remove
    ? releaseAction(purpose, subjectId, role, rev)
    : spec.purpose === "label"
      ? propertyAction(subjectId, role, textId as Hex, rev)
      : spec.purpose === "same"
        ? sameAction(subjectId, otherId as Hex, rev)
        : broaderAction(subjectId, otherId as Hex, rev);
  // Each statement is priced by its measured row (contracts 0fb4804). A first SAME takes bindSameFreshWord, the
  // dearer of the two first-SAME rows (word ↔ word and path ↔ path differ by about 100 gas). A later bind (a new
  // text, or a restore of a masked or released statement) takes the purpose's later row.
  const first = !remove && state === "UNSET";
  const row: BindRow = remove
    ? spec.purpose === "label"
      ? "releaseProperty"
      : spec.purpose === "same"
        ? "releaseSame"
        : "releaseBroader"
    : spec.purpose === "label"
      ? first
        ? "bindPropertyFresh"
        : "bindPropertyRebind"
      : spec.purpose === "same"
        ? first
          ? "bindSameFreshWord"
          : "restoreSame"
        : first
          ? "bindBroaderFresh"
          : "restoreBroader";
  actions.push({ action: statement, body: "0x", firstStatement: first, bindRow: row });

  // ---- parts
  const g = gasSetup(d, o);
  if (!g.ok) return { kind: "efs.topicStatementPlan", status: "UNKNOWN", reason: g.reason, basis };
  const gas = g.gas;
  const split = splitPublications(actions, {
    model: gas.model,
    limits: d.limits,
    txGasCap: gas.txGasCap,
    headroom: gas.headroom,
    ...(gas.blockGasLimit !== undefined ? { blockGasLimit: gas.blockGasLimit } : {}),
    typeNames: gas.typeNames,
    firstWrite: true,
  });
  if (!split.ok)
    return { kind: "efs.topicStatementPlan", status: "TOO_LARGE", reason: split.reason };
  const maxParts = o.maxParts ?? 64;
  if (split.parts.length > maxParts)
    return {
      kind: "efs.topicStatementPlan",
      status: "TOO_LARGE",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${split.parts.length} publications; the limit is ${maxParts}`,
      ),
    };
  const subjectText =
    subject.place.kind === "topic" ? `/${subject.words.join("/")}` : subject.place.address;
  const otherText = other ? `/${other.words.join("/")}` : "";
  const text = remove
    ? `Take back your ${spec.purpose === "label" ? `${spec.lang} label` : spec.purpose} on ${subjectText}`
    : spec.purpose === "label"
      ? `Name ${subjectText} "${spec.text}" (${spec.lang})`
      : spec.purpose === "same"
        ? `${subjectText} is the same as ${otherText}`
        : `${subjectText} is narrower than ${otherText}`;
  const total = split.parts.length;
  const parts = split.parts.map((part, k): SequencePartInput => {
    const finishes = part.actions.includes(actions[actions.length - 1] as PlannedAction);
    const effects: EffectView[] = [
      finishes
        ? {
            code: `tags.${spec.purpose}`,
            args: {
              subject: subjectId,
              ...(spec.purpose === "label" ? { lang: spec.lang } : { other: otherId as Hex }),
              remove: String(remove),
              part: String(k + 1),
              parts: String(total),
              stage: "finish",
            },
            text,
          }
        : {
            code: "tags.register",
            args: {
              topic: subjectId,
              part: String(k + 1),
              parts: String(total),
              stage: "register",
            },
            text: `Register ${subjectText}${otherText ? ` and ${otherText}` : ""}`,
          },
    ];
    return {
      actions: part.actions.map((a) => a.action),
      bodies: part.actions.map((a) => a.body),
      effects,
      ...(o.deadlineSeconds !== undefined ? { deadlineSeconds: o.deadlineSeconds } : {}),
      ...batchGasOf(part),
    };
  });
  const review: TopicStatementReview = {
    kind: "efs.topicStatementReview",
    author: me,
    purpose: spec.purpose,
    subject: subject.place,
    ...(spec.purpose === "label"
      ? { lang: spec.lang, ...(remove ? {} : { text: spec.text as string }) }
      : { other: { words: other?.words as string[], id: otherId as TopicId } }),
    remove,
    before,
    newTopics,
    records,
    parts: total,
    prompts: { sequential: total, atomicBatch: packBatches(parts, gas).length },
    gas: { perPart: split.parts.map((p) => p.gas), schedule: gas.model.schedule },
  };
  return { kind: "efs.topicStatementPlan", status: "PLANNED", parts, review, basis };
}
