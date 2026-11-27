// SPDX-License-Identifier: MIT
// Folder writes: create a file or a folder under a parent, move or rename entries, remove them, restore them. Each
// planner reads the chain at one basis, never calls the wallet, and returns parts for writer.runSequence with a
// review and `files.*` effects, like planEditFile. Every write touches only the writer's own entries (FOLDER
// bindings are per author) with a compare-and-swap on each one's revision, so a race is refused by the ledger, never
// a silent overwrite.
//
// What each one publishes (contracts src/lib/EfsFiles.sol recipes; FilesFinalValidator: a FOLDER bind needs its
// name's files-name/3 record, a files-directory/1 parent and a created subject or a directory record as target):
//   create file    CREATE(salt), the root revision (inline, or chunks under a descriptor), the name record if new,
//                  BIND(HEAD, file → root), BIND(FOLDER, parent, name → file)
//   create folder  PUBLISH(files-directory/1 (writer, salt)), the name record if new, BIND(FOLDER, parent, name → it).
//                  No CREATE: a folder is its record, which only its creator may publish (never REUSE another's)
//   move / rename  the new name record if new, RELEASE(FOLDER, from), BIND(FOLDER, to → target): one publication
//   remove         RELEASE(FOLDER, at): the Lens falls through to the next author's entry. With hide: UNBIND, a
//                  mask: nothing shows there for a reader who ranks you above the entry's author
//   restore        BIND(FOLDER, at → the target it had before it was removed), read from the binding's history
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import type { PartUnit } from "../actions/journal.js";
import type { SequencePartInput } from "../actions/sequence.js";
import {
  type BindRow,
  batchGasOf,
  type PlannedAction,
  packBatches,
  splitPublications,
} from "../actions/split.js";
import type { EffectView } from "../actions/types.js";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { encode, FORM } from "../content/codec.js";
import { recordCall } from "../content/records.js";
import { type CallOpts, EfsFault, misuse, type Reason, reason } from "../core/errors.js";
import {
  type Hex,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
  uniquePrincipals,
  ZERO_WORD,
} from "../core/hex.js";
import { indexAbi, ledgerAbi, ledgerViewsAbi } from "../generated/abis.js";
import { ACTION, FILES, PURPOSES } from "../generated/constants.js";
import { checkName, NAME_PROFILE } from "../names/name.js";
import { bindingKey, positionKey, recordFromHash, recordId, subjectId } from "../protocol/keys.js";
import { chainStatus, headConsistent, headState, neverBoundHead } from "../protocol/status.js";
import type { Ctx, FileRef } from "./bytes.js";
import {
  checkParent,
  decodeCreator,
  decodeFolderRecord,
  type EntryRef,
  type EntryTarget,
  type FolderRef,
  lookupAt,
  type ParentRef,
  parentSubject,
  subjectInfoCall,
} from "./folders.js";
import {
  askedMediaType,
  buildContent,
  type ContentLayout,
  checkContent,
  checkedGasSetup,
  type ExternalContent,
  type FilesTypes,
  type GasOpts,
  plain,
  publish,
  randomSalt,
  tooManyBytes,
} from "./plan.js";
import { lastBoundTarget } from "./removed.js";

// ---- shared shapes

/** Why one entry of a plan was refused. A refused plan plans nothing, and lists every refusal at once. */
export interface EntryRefusal {
  /** The input's index (0 for the single-entry planners). */
  index: number;
  code: /**
   * Your own entry already holds this name here: choose another name, or open it and save a new version. From
   * planHideEntries: hide your own entry with planRemoveEntries and `hide: true` (Remove and block) instead.
   */
    | "NAME_TAKEN_MINE"
    /** The entry this Lens shows is another author's: you can move or remove only your own. */
    | "NOT_YOURS"
    /** The folder is not a files-directory/1 record on this chain. */
    | "FOLDER_ABSENT"
    /** You have no entry at this name (and no author in the Lens shows one). */
    | "ENTRY_ABSENT"
    /** Restore: your entry here is not removed. */
    | "NOT_REMOVED"
    /** Restore: you never placed anything at this name; your hide covers someone else's entry. Unhide it instead. */
    | "NEVER_BOUND"
    /** Restore: the entry's history is too deep (or unreadable) to name its last target; `reason` says which. */
    | "HISTORY_UNKNOWN"
    /** Unhide: your entry here is not hidden. */
    | "NOT_HIDDEN"
    /** Hide: your hide is already at this name (planUnhideEntries removes it). */
    | "ALREADY_HIDDEN"
    /** The destination path (`via`) no longer reaches the destination folder under this Lens: resolve it again. */
    | "PATH_CHANGED";
  entry: EntryRef;
  /** NOT_YOURS: whose entry the Lens shows, and the admission that last set it (compare with Basis.admissions). */
  author?: PrincipalId;
  admission?: bigint;
  /** HISTORY_UNKNOWN: why the history could not name the target. */
  reason?: Reason;
}

/** What a reader with this Lens sees at a name. */
export interface LensView {
  /** Your entry is the one this Lens shows. */
  visibleInLens: boolean;
  /** Another author's entry shows instead of yours (they come earlier in the Lens). */
  shownInstead: { author: PrincipalId } | null;
  /** An earlier author in the Lens removed this name with hide, so nothing shows here. */
  hiddenBy?: PrincipalId;
}

export type FolderPlanResult<R> =
  | {
      kind: "efs.folderPlan";
      status: "PLANNED";
      parts: SequencePartInput[];
      review: R;
      basis: Basis;
    }
  | { kind: "efs.folderPlan"; status: "REFUSED"; refused: readonly EntryRefusal[]; basis: Basis }
  | { kind: "efs.folderPlan"; status: "TOO_LARGE"; reason: Reason }
  /** The chain could not be read (or answered something this SDK does not accept): nothing was decided. */
  | { kind: "efs.folderPlan"; status: "UNKNOWN"; reason: Reason; basis?: Basis };

export interface FolderPlanOpts extends CallOpts, GasOpts {
  /** Refuse (TOO_LARGE) rather than plan more parts than this. Default 64. */
  maxParts?: number;
  /** Each part's deadline, in seconds from the block it is planned at (default 15 minutes). */
  deadlineSeconds?: number;
}

/** What every folder review carries (prompts, gas and records as in EditReview). */
export interface FolderReviewBase {
  /** The principal the entries are written by: the writer's. */
  author: PrincipalId;
  parts: number;
  /**
   * Wallet approvals: one per part, or `atomicBatch` with an atomic EIP-5792 wallet, which takes consecutive parts
   * in one request only while their summed gas fits one transaction (so content parts that each fill a
   * transaction still need one approval each).
   */
  prompts: { sequential: number; atomicBatch: number };
  /** The model's estimate per part (planning only; eth_estimateGas decides before each send). */
  gas: { perPart: readonly number[]; schedule: string };
  /** Records published (chunks, spans, descriptor, revision, folder, names). */
  records: number;
}

// ---- reading at one basis

type RawHead = {
  state: number;
  revision: bigint;
  admission: bigint;
  targetKind: number;
  prevAdmission: bigint;
  bindingOrdinal: bigint;
  target: Hex;
};
type RecordInfo = { present: false } | { present: true; typeId: Hex; length: number; word0: Hex };

/** One place a planner touches: a name in a folder or home. */
interface Place {
  /** The folder or home, as the reads key it (lowercase, no owner). */
  parent: ParentRef;
  /** Its subject word: the folder's record id, the home's left-padded address. */
  folder: Hex;
  name: string;
  nameBytes: Uint8Array;
  role: Hex;
  position: Hex;
}
interface PlaceState {
  /** The writer's own binding at this place. */
  mine: RawHead;
  /** Every Lens author's head here, in Lens order. */
  lens: RawHead[];
}
interface Seen {
  places: Map<Hex, PlaceState>;
  records: Map<Hex, RecordInfo>;
  /** Each folder a place is under: whether it is a files-directory/1 record, from its hash-checked record. */
  folders: Map<Hex, boolean>;
  /** For each subject asked about: whether it was already created. */
  created: Map<Hex, boolean>;
}

const READ_CHUNK = 64; // limits.maxReadIds and the 64-principal cap
const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const failed = (out: { ok: false; reason: Reason } | undefined): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
});
const bad = (what: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", `${what} did not decode`),
});

/** Your heads, the Lens's heads and the records a plan rests on, in one batch at the basis. */
async function readSeen(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  me: PrincipalId,
  principals: readonly PrincipalId[],
  places: readonly Place[],
  recordIds: readonly Hex[],
  subjects: readonly Hex[] = [],
): Promise<Step<Seen>> {
  const d = ctx.efs.deployment;
  const uniquePlaces = [...new Map(places.map((p) => [p.position, p])).values()];
  const ids = [...new Set(recordIds.map((x) => lower(x)))];
  const keyChunks = chunks(uniquePlaces, READ_CHUNK);
  const idChunks = chunks(ids, READ_CHUNK);
  // The folders the places are under, each read with LedgerReads.record (type and body hash-checked): a plan decides
  // whether its parent is a folder from verified data, never from an unchecked header.
  const folderIds = [
    ...new Set(uniquePlaces.filter((p) => p.parent.kind === "folder").map((p) => lower(p.folder))),
  ];
  const calls: CallRequest[] = [
    ...keyChunks.map((c) => ({
      to: d.readers.ledgerViews,
      data: encodeFunctionData({
        abi: ledgerViewsAbi,
        functionName: "heads",
        args: [d.ledger, c.map((p) => bindingKey(me, p.position))],
      }),
    })),
    ...uniquePlaces.map((p) => ({
      to: d.readers.ledgerViews,
      data: encodeFunctionData({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        args: [d.ledger, principals as Hex[], p.position],
      }),
    })),
    ...idChunks.map((c) => ({
      to: d.readers.ledgerViews,
      data: encodeFunctionData({
        abi: ledgerViewsAbi,
        functionName: "records",
        args: [d.ledger, c],
      }),
    })),
    ...subjects.map((x) => subjectInfoCall(ctx.efs, x)),
    ...folderIds.map((id) => recordCall(d, id)),
  ];
  if (calls.length === 0)
    return {
      ok: true,
      value: { places: new Map(), records: new Map(), created: new Map(), folders: new Map() },
    };
  ctx.requests += calls.length;
  const outs = await callsAt(s, basis.blockHash, calls);
  let k = 0;
  const mine: RawHead[] = [];
  for (const c of keyChunks) {
    const out = outs[k++];
    if (!out?.ok) return failed(out);
    let hs: readonly RawHead[];
    try {
      [hs] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "heads",
        data: out.result as Hex,
      }) as unknown as [RawHead[]];
    } catch {
      return bad("heads");
    }
    if (hs.length !== c.length) return bad("heads (one per key)");
    if (hs.some((h) => !headConsistent(h.state, h.revision)))
      return bad("heads (a state its revision contradicts)");
    mine.push(...hs);
  }
  const placesOut = new Map<Hex, PlaceState>();
  for (let i = 0; i < uniquePlaces.length; i++) {
    const out = outs[k++];
    if (!out?.ok) return failed(out);
    let status: number;
    let all: readonly RawHead[];
    try {
      [status, , , all] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        data: out.result as Hex,
      }) as unknown as [number, RawHead, number, RawHead[]];
    } catch {
      return bad("headsAt");
    }
    const st = chainStatus(status);
    if (st !== "PRESENT" && st !== "MASKED" && st !== "ABSENT_PROVEN")
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", `headsAt reads ${st}`),
      };
    if (all.length !== principals.length) return bad("headsAt (one head per Lens author)");
    if (all.some((h) => !headConsistent(h.state, h.revision)))
      return bad("headsAt (a state its revision contradicts)");
    const p = uniquePlaces[i] as Place;
    placesOut.set(p.position, { mine: mine[i] as RawHead, lens: [...all] });
  }
  const records = new Map<Hex, RecordInfo>();
  for (const c of idChunks) {
    const out = outs[k++];
    if (!out?.ok) return failed(out);
    let statuses: readonly number[];
    let headers: readonly { typeId: Hex; length: number; word0: Hex }[];
    try {
      [statuses, headers] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "records",
        data: out.result as Hex,
      }) as unknown as [number[], { typeId: Hex; length: number; word0: Hex }[]];
    } catch {
      return bad("records");
    }
    if (statuses.length !== c.length || headers.length !== c.length)
      return bad("records (one per id)");
    for (let i = 0; i < c.length; i++) {
      const st = chainStatus(statuses[i] as number);
      const h = headers[i] as { typeId: Hex; length: number; word0: Hex };
      if (st === "ABSENT_PROVEN") records.set(c[i] as Hex, { present: false });
      else if (st === "PRESENT")
        records.set(c[i] as Hex, {
          present: true,
          typeId: lower(h.typeId),
          length: Number(h.length),
          word0: lower(h.word0),
        });
      else
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", `records reads ${st}`),
        };
    }
  }
  const created = new Map<Hex, boolean>();
  for (const x of subjects) {
    const c = decodeCreator(outs[k++]);
    if (!c.ok) return c;
    created.set(lower(x), c.value !== null);
  }
  const folders = new Map<Hex, boolean>();
  for (const id of folderIds) {
    const f = decodeFolderRecord(ctx.efs, id, outs[k++]);
    if (!f.ok) return f;
    folders.set(id, f.value.status === "PRESENT" && f.value.directory);
  }
  return { ok: true, value: { places: placesOut, records, created, folders } };
}

/** What this Lens shows at a place if your head there were `mine` (BOUND, MASKED or RELEASED), or as it is now. */
function lensAt(
  principals: readonly PrincipalId[],
  state: PlaceState,
  me: PrincipalId,
  mine?: "BOUND" | "MASKED" | "RELEASED",
): { shown: PrincipalId | null; maskedBy?: PrincipalId; admission?: bigint } {
  for (let i = 0; i < principals.length; i++) {
    const p = principals[i] as PrincipalId;
    const st = p === me && mine ? mine : headState((state.lens[i] as RawHead).state);
    if (st === "BOUND")
      return { shown: p, admission: BigInt((state.lens[i] as RawHead).admission) };
    if (st === "MASKED") return { shown: null, maskedBy: p };
  }
  return { shown: null };
}
const viewAfterBind = (
  principals: readonly PrincipalId[],
  state: PlaceState,
  me: PrincipalId,
): LensView => {
  const v = lensAt(principals, state, me, "BOUND");
  return {
    visibleInLens: v.shown === me,
    shownInstead: v.shown && v.shown !== me ? { author: v.shown } : null,
    ...(v.maskedBy ? { hiddenBy: v.maskedBy } : {}),
  };
};
const shownAfter = (
  principals: readonly PrincipalId[],
  state: PlaceState,
  me: PrincipalId,
  mine: "MASKED" | "RELEASED",
): { author: PrincipalId } | null => {
  const v = lensAt(principals, state, me, mine);
  return v.shown ? { author: v.shown } : null;
};

// ---- input checks

type Types = {
  child: Hex;
  root: Hex;
  content: Hex;
  bytes: Hex;
  span: Hex;
  external: Hex;
  directory: Hex;
  name: Hex;
};
function typesOf(efs: Efs): Types {
  const t = efs.deployment.typeIds as Record<string, Hex | undefined>;
  const pick = (k: string): Hex => {
    const v = t[k];
    if (!v) throw new EfsFault("MISUSE", `this deployment has no ${k} Type`);
    return lower(v);
  };
  return {
    child: pick("files-child/1"),
    root: pick("files-root/1"),
    content: pick("files-content/1"),
    bytes: pick("files-bytes/1"),
    span: pick("files-span/1"),
    external: pick("files-external/1"),
    directory: pick("files-directory/1"),
    name: pick(NAME_PROFILE),
  };
}
/** A place from a folder or home and a name, or MISUSE with checkName's rule. */
function placeOf(folder: ParentRef, name: string, index: number): Place {
  const c = checkName(name);
  if (c.status !== "VALID")
    throw misuse(`not a ${NAME_PROFILE} name: ${c.status === "INVALID" ? c.rule : c.status}`, {
      index,
      name,
      ...(c.status === "INVALID"
        ? { rule: c.rule, ...(c.at !== undefined ? { at: c.at } : {}) }
        : {}),
    });
  const parent = checkParent(folder);
  const dir = parentSubject(parent);
  const role = keccak256(c.bytes);
  return {
    parent,
    folder: dir,
    name,
    nameBytes: c.bytes,
    role,
    position: positionKey(PURPOSES.folder, dir, role),
  };
}
const entryOf = (p: Place): EntryRef => ({ folder: p.parent, name: p.name });
/** The record ids that prove places' parents: a folder's record (a home always exists and has none). */
const parentIds = (ps: readonly Place[]): Hex[] =>
  ps.filter((p) => p.parent.kind === "folder").map((p) => p.folder);
/** A home always exists; a folder must be a files-directory/1 record at the basis (its hash-checked record). */
const parentExists = (p: Place, folders: ReadonlyMap<Hex, boolean>): boolean =>
  p.parent.kind === "home" || folders.get(lower(p.folder)) === true;
const nameRecord = (types: Types, p: Place): Hex => lower(recordFromHash(types.name, p.role));
const TARGET_RECORD = FILES.targetKind.RECORD;
const targetOf = (h: RawHead): EntryTarget =>
  h.targetKind === TARGET_RECORD
    ? { kind: "folder", directory: lower(h.target) as RecordId }
    : { kind: "file", subject: lower(h.target) as SubjectId };
const lensPrincipals = (efs: Efs, lens: Lens | undefined): PrincipalId[] => {
  const ps = uniquePrincipals((lens ?? efs.lens.default).principals);
  if (ps.length === 0) throw misuse("a Lens names at least one principal");
  if (ps.length > READ_CHUNK) throw misuse(`a Lens names at most ${READ_CHUNK} principals`);
  return ps;
};
/**
 * @internal The gas-model row of your FOLDER BIND at a position, by your head there (gas/model.json laterRows.rule): a
 * first statement (fresh file or directory), a re-bind of a bound entry (bindFolderRebind), a yes where you only ever
 * hid (bindFolderAfterNo: never bound, perhaps released or hidden again), or a restore of an entry you removed
 * (restoreFolder, measured placing a new target: a same-target restore is over-priced by the kernel's rewrite, the
 * safe side). Unrecognized: none, so the bind is priced at the dearest row of its kind.
 */
export const folderBindRow = (
  h: Pick<RawHead, "state" | "targetKind">,
  directory: boolean,
): BindRow | undefined => {
  const state = headState(h.state);
  if (state === "UNSET")
    return directory ? ("bindFolderFreshDirectory" as const) : ("bindFolderFreshFile" as const);
  if (state === "BOUND") return "bindFolderRebind" as const;
  if (state === "MASKED" || state === "RELEASED")
    return neverBoundHead(h) ? ("bindFolderAfterNo" as const) : ("restoreFolder" as const);
  return undefined;
};
/** The writer has never stated anything at this place: a BIND there is a first statement (the kernel's floor). */
const isUnset = (h: RawHead): boolean => headState(h.state) === "UNSET";

/** NOT_YOURS or ENTRY_ABSENT for a place where your own entry is not bound. */
const notMine = (
  principals: readonly PrincipalId[],
  st: PlaceState,
  me: PrincipalId,
  index: number,
  p: Place,
): EntryRefusal => {
  const v = lensAt(principals, st, me);
  return v.shown && v.shown !== me
    ? {
        index,
        code: "NOT_YOURS",
        entry: entryOf(p),
        author: v.shown,
        ...(v.admission !== undefined ? { admission: v.admission } : {}),
      }
    : { index, code: "ENTRY_ABSENT", entry: entryOf(p) };
};

// ---- splitting into parts

interface Unit {
  /** The entry the actions serve, for the part's effects. */
  effect: (stage: "content" | "finish", part: number, parts: number) => EffectView;
  actions: PlannedAction[];
  /** The unit's last action finishes it (the others store content only). */
  finishes: boolean;
}

async function toParts<R extends FolderReviewBase>(
  efs: Efs,
  o: FolderPlanOpts,
  units: readonly Unit[],
  review: (base: FolderReviewBase) => R,
  me: PrincipalId,
  basis: Basis,
  recordsCount: number,
): Promise<FolderPlanResult<R>> {
  const d = efs.deployment;
  const g = await checkedGasSetup(efs, o);
  if (!g.ok) return { kind: "efs.folderPlan", status: "UNKNOWN", reason: g.reason, basis };
  const gas = g.gas;
  // Tag each action with its unit so the parts' effects can say what each part carries.
  const owner = new Map<PlannedAction, number>();
  const all: PlannedAction[] = [];
  units.forEach((u, i) => {
    for (const a of u.actions) {
      owner.set(a, i);
      all.push(a);
    }
  });
  const split = splitPublications(all, {
    model: gas.model,
    limits: d.limits,
    txGasCap: gas.txGasCap,
    headroom: gas.headroom,
    ...(gas.blockGasLimit !== undefined ? { blockGasLimit: gas.blockGasLimit } : {}),
    typeNames: gas.typeNames,
    firstWrite: true, // priced as a first publication: planning does not read the nonce (see planEditFile)
  });
  if (!split.ok) return { kind: "efs.folderPlan", status: "TOO_LARGE", reason: split.reason };
  const maxParts = o.maxParts ?? 64;
  if (split.parts.length > maxParts)
    return {
      kind: "efs.folderPlan",
      status: "TOO_LARGE",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${split.parts.length} publications; the limit is ${maxParts}`,
      ),
    };
  const n = split.parts.length;
  const parts = split.parts.map((part, i): SequencePartInput => {
    const touched = new Map<number, boolean>();
    for (const a of part.actions) {
      const u = owner.get(a) as number;
      const unit = units[u] as Unit;
      const last = unit.actions[unit.actions.length - 1];
      touched.set(u, (touched.get(u) ?? false) || (unit.finishes && a === last));
    }
    const effectOf = (u: number) =>
      (units[u] as Unit).effect(touched.get(u) ? "finish" : "content", i + 1, n);
    // Each entry's actions in this part are one run: a re-split cuts only between entries (never inside a move).
    const runs: PartUnit[] = [];
    let at = -1;
    for (const a of part.actions) {
      const u = owner.get(a) as number;
      const last = runs[runs.length - 1];
      if (u === at && last) last.actions++;
      else runs.push({ actions: 1, effect: effectOf(u) });
      at = u;
    }
    return {
      actions: part.actions.map((a) => a.action),
      bodies: part.actions.map((a) => a.body),
      effects: [...touched].map(([u]) => effectOf(u)),
      units: runs,
      ...(o.deadlineSeconds !== undefined ? { deadlineSeconds: o.deadlineSeconds } : {}),
      ...batchGasOf(part),
    };
  });
  return {
    kind: "efs.folderPlan",
    status: "PLANNED",
    parts,
    review: review({
      author: me,
      parts: n,
      prompts: { sequential: n, atomicBatch: packBatches(parts, gas).length },
      gas: { perPart: split.parts.map((p) => p.gas), schedule: gas.model.schedule },
      records: recordsCount,
    }),
    basis,
  };
}

/** Pin, read and plan on one endpoint, at one basis. */
async function atOneBasis<R>(
  efs: Efs,
  o: CallOpts,
  read: (ctx: Ctx, s: Session, basis: Basis) => Promise<Step<() => Promise<FolderPlanResult<R>>>>,
): Promise<FolderPlanResult<R>> {
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.folderPlan",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  const ctx: Ctx = { efs, requests: 0 };
  const r = await onEndpoint(efs._internal.pool, (s) => read(ctx, s, basis), o);
  if (!r.ok) return { kind: "efs.folderPlan", status: "UNKNOWN", reason: r.reason, basis };
  return r.value();
}
const refusedResult = <R>(refused: EntryRefusal[], basis: Basis): FolderPlanResult<R> => ({
  kind: "efs.folderPlan",
  status: "REFUSED",
  refused,
  basis,
});
const effectArgs = (p: Place, extra: Record<string, string>): Record<string, string> => ({
  folder: p.folder,
  name: p.name,
  ...extra,
});

// ---- create a file

export interface CreateFileInput {
  /** The parent: a folder, or a home (anyone's address). There is no default: where a path starts is the caller's. */
  folder: ParentRef;
  name: string;
  content: Uint8Array | ExternalContent;
  /** As in planEditFile; omitted or "" declares none (a new file has no base to keep one from). */
  mediaType?: string;
  /** The Lens the person sees the folder through, for the review's LensView. Default: the client's default Lens. */
  lens?: Lens;
  /** The CREATE salt (default: 32 random bytes). The new file's subject is subjectId(writer, salt). */
  salt?: Hex;
}

export interface CreateFileReview extends FolderReviewBase, LensView {
  kind: "efs.createFileReview";
  folder: ParentRef;
  name: string;
  /** The new file, and its first revision (files-root/1). */
  file: FileRef;
  revision: RecordId;
  size: bigint;
  sha256: Hex;
  layout: ContentLayout;
  /** The media type the revision declares ("" = none: always for inline layout). */
  mediaType: string;
}

/** files-root/1 header: abi.encode(file, form). */
const ROOT_HEADER_BYTES = 64;
const checkSalt = (salt: Hex | undefined): Hex => {
  if (salt === undefined) return randomSalt();
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw misuse("salt is 32 bytes of hex");
  if (/^0x0{64}$/.test(salt)) throw misuse("salt must not be zero"); // the folder rule refuses a zero salt
  return lower(salt);
};

/**
 * Plan a new file `name` in `folder`: one review, one prompt in the common case (large content splits into parts,
 * the finish kept in one publication so the file appears whole). Your own entry at that name refuses
 * (NAME_TAKEN_MINE); another author's does not (yours is a separate entry; the review says which one this Lens shows).
 */
export async function planCreateFile(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: CreateFileInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<CreateFileReview>> {
  const types = typesOf(efs);
  const place = placeOf(input.folder, input.name, 0);
  const mediaType = askedMediaType(input.mediaType) ?? "";
  checkContent(input.content);
  const salt = checkSalt(input.salt);
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const d = efs.deployment;
  const huge = tooManyBytes(input.content, o.maxParts ?? 64, d.limits.maxBodyBytesPerPublication);
  if (huge) return { kind: "efs.folderPlan", status: "TOO_LARGE", reason: huge };
  const built = buildContent(
    types as FilesTypes,
    input.content,
    mediaType,
    d.limits.maxBodyBytes,
    ROOT_HEADER_BYTES,
  );
  if (!built.ok) return { kind: "efs.folderPlan", status: "TOO_LARGE", reason: built.reason };
  const file = lower(subjectId(me, salt)) as SubjectId;
  const rootBody = built.descriptor
    ? encode.rootContent(file, built.descriptor.id)
    : encode.rootInline(file, built.inline as Uint8Array);
  const revision = lower(recordId(types.root, rootBody)) as RecordId;
  const nameId = nameRecord(types, place);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(
      ctx,
      s,
      basis,
      me,
      principals,
      [place],
      [...parentIds([place]), nameId],
      [file],
    );
    if (!r.ok) return r;
    const seen = r.value;
    // CREATE refuses a salt this writer already used: say so now, never as a revert.
    if (seen.created.get(file))
      throw misuse("this salt was already used by this writer: pass a new one", { salt });
    const st = seen.places.get(place.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!parentExists(place, seen.folders))
      refused.push({ index: 0, code: "FOLDER_ABSENT", entry: entryOf(place) });
    if (headState(st.mine.state) === "BOUND")
      refused.push({ index: 0, code: "NAME_TAKEN_MINE", entry: entryOf(place) });
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    const nameExists = (seen.records.get(nameId) as RecordInfo).present;
    const FINISH = 1;
    const finish: PlannedAction[] = [];
    if (built.descriptor)
      finish.push(
        publish(built.descriptor.typeId, built.descriptor.body, built.descriptor.shape, FINISH),
      );
    finish.push(plain({ kind: ACTION.CREATE, saltOrStrength: salt }, { group: FINISH }));
    finish.push(
      publish(
        types.root,
        rootBody,
        `files-root/1 form ${built.descriptor ? FORM.content : FORM.inline}`,
        FINISH,
      ),
    );
    if (!nameExists) finish.push(publish(types.name, place.nameBytes, NAME_PROFILE, FINISH));
    finish.push(
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.head,
          subject: file,
          role: ZERO_WORD,
          target: revision,
        },
        { group: FINISH, bindRow: "bindHeadFresh" },
      ),
    );
    const folderRow = folderBindRow(st.mine, false);
    finish.push(
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: place.folder,
          role: place.role,
          target: file,
          expectedRevision: BigInt(st.mine.revision),
        },
        {
          group: FINISH,
          firstStatement: isUnset(st.mine),
          ...(folderRow ? { bindRow: folderRow } : {}),
        },
      ),
    );
    const args = effectArgs(place, { file, revision });
    const effect = (stage: "content" | "finish", part: number, parts: number): EffectView => ({
      code: "files.create",
      args: { ...args, part: String(part), parts: String(parts), stage },
      text:
        stage === "finish"
          ? `Create ${place.name} (${built.size} bytes)`
          : `Store part ${part} of ${parts} of ${place.name}'s content`,
    });
    const units: Unit[] = [
      ...built.records.map((a) => ({ effect, actions: [a], finishes: false })),
      { effect, actions: finish, finishes: true },
    ];
    const published =
      built.records.length + finish.filter((a) => a.action.kind === ACTION.PUBLISH).length;
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({
            kind: "efs.createFileReview",
            ...base,
            folder: entryOf(place).folder,
            name: place.name,
            file: { kind: "file", subject: file },
            revision,
            size: built.size,
            sha256: built.sha256,
            layout: built.layout,
            mediaType: built.layout === "inline" ? "" : mediaType,
            ...viewAfterBind(principals, st, me),
          }),
          me,
          basis,
          published,
        ),
    };
  });
}

// ---- create a folder

export interface CreateFolderInput {
  /** The parent: a folder, or a home (anyone's address). */
  folder: ParentRef;
  name: string;
  lens?: Lens;
  /** The folder record's salt (default: 32 random bytes, never zero); its id is recordId(files-directory/1, (writer, salt)). */
  salt?: Hex;
}
export interface CreateFolderReview extends FolderReviewBase, LensView {
  kind: "efs.createFolderReview";
  /** The parent. */
  folder: ParentRef;
  name: string;
  /** The new folder: its directory record id is its permanent link, and the writer is its owner. */
  created: FolderRef & { owner: PrincipalId };
}

/** Plan a new, empty folder `name` in `folder`. One publication; the name rules are planCreateFile's. */
export async function planCreateFolder(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: CreateFolderInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<CreateFolderReview>> {
  const types = typesOf(efs);
  const place = placeOf(input.folder, input.name, 0);
  const salt = checkSalt(input.salt);
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  // A folder is its record: (creator, salt), published only by its creator. No CREATE, no subject.
  const dirBody = encode.directory(me, salt);
  const directory = lower(recordId(types.directory, dirBody)) as RecordId;
  const nameId = nameRecord(types, place);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(
      ctx,
      s,
      basis,
      me,
      principals,
      [place],
      [...parentIds([place]), nameId, directory],
    );
    if (!r.ok) return r;
    const seen = r.value;
    if ((seen.records.get(directory) as RecordInfo).present)
      throw misuse("this salt was already used by this writer: pass a new one", { salt });
    const st = seen.places.get(place.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!parentExists(place, seen.folders))
      refused.push({ index: 0, code: "FOLDER_ABSENT", entry: entryOf(place) });
    if (headState(st.mine.state) === "BOUND")
      refused.push({ index: 0, code: "NAME_TAKEN_MINE", entry: entryOf(place) });
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    const nameExists = (seen.records.get(nameId) as RecordInfo).present;
    const row = folderBindRow(st.mine, true);
    const actions: PlannedAction[] = [
      publish(types.directory, dirBody, "files-directory/1", 1),
      ...(nameExists ? [] : [publish(types.name, place.nameBytes, NAME_PROFILE, 1)]),
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: place.folder,
          role: place.role,
          target: directory,
          expectedRevision: BigInt(st.mine.revision),
        },
        {
          group: 1,
          firstStatement: isUnset(st.mine),
          ...(row ? { bindRow: row } : {}),
        },
      ),
    ];
    const args = effectArgs(place, { directory });
    const units: Unit[] = [
      {
        effect: (stage, part, parts) => ({
          code: "files.createFolder",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Create the folder ${place.name}`,
        }),
        actions,
        finishes: true,
      },
    ];
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({
            kind: "efs.createFolderReview",
            ...base,
            folder: entryOf(place).folder,
            name: place.name,
            created: { kind: "folder", directory, owner: me },
            ...viewAfterBind(principals, st, me),
          }),
          me,
          basis,
          nameExists ? 1 : 2,
        ),
    };
  });
}

// ---- destination paths (the only check against moving a folder below itself: there are no parent pointers)

/**
 * A destination's path: a folder you name (`from`, the start of your view, such as a home) and the names below it,
 * as you resolved them. The planner resolves it again itself at the planning block, under the same Lens, so a
 * stale or made-up path cannot get past it; the path must end at the destination folder.
 */
export interface DestinationPath {
  /** A folder or a home: where the path starts. */
  from: ParentRef;
  segments: readonly string[];
}
type Via = { from: ParentRef; names: Uint8Array[] };
const viaOf = (v: DestinationPath | undefined, index: number): Via | undefined => {
  if (v === undefined) return undefined;
  const from = checkParent(v.from);
  if (!Array.isArray(v.segments)) throw misuse("`via.segments` is a list of names", { index });
  const names = v.segments.map((n, j) => {
    const c = checkName(n);
    if (c.status !== "VALID")
      throw misuse(
        `not a ${NAME_PROFILE} name in \`via\`: ${c.status === "INVALID" ? c.rule : c.status}`,
        {
          index,
          segment: j,
        },
      );
    return c.bytes;
  });
  return { from, names };
};

/** The folders on a destination path (from first), resolved under the Lens at the basis; null when it no longer reaches `to`. */
async function pathFolders(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  principals: readonly PrincipalId[],
  via: Via,
  to: Hex,
): Promise<Step<Hex[] | null>> {
  const folders: Hex[] = [parentSubject(via.from)];
  let at: ParentRef = via.from;
  for (const name of via.names) {
    const r = await lookupAt(ctx, s, basis, principals, at, name, false, true);
    if (!r.ok) return r;
    const v = r.value;
    if (v.status === "UNKNOWN") return { ok: false, retryElsewhere: true, reason: v.reason };
    if (v.status !== "PRESENT" || v.selected.target?.kind !== "folder")
      return { ok: true, value: null };
    at = v.selected.target;
    folders.push(lower(at.directory));
  }
  return { ok: true, value: folders[folders.length - 1] === to ? folders : null };
}

/**
 * Refuse (MISUSE, INTO_ITSELF) a batch whose folder moves or restores would put a folder inside itself: each one's
 * destination ancestry, followed through the batch's other folder placements, must not reach the folder itself.
 */
function refuseCycles(
  placed: readonly { index: number; target: Hex; to: Hex; folders: readonly Hex[] }[],
): void {
  const at = new Map(placed.map((f) => [f.target, f]));
  for (const f of placed) {
    if (f.folders.includes(f.target) || f.to === f.target)
      throw misuse("a folder cannot be placed inside itself or below itself (under this Lens)", {
        index: f.index,
        code: "INTO_ITSELF",
      });
    const seen = new Set<Hex>();
    const queue: Hex[] = [...f.folders];
    while (queue.length > 0) {
      const x = queue.pop() as Hex;
      if (x === f.target)
        throw misuse(
          "these changes would put a folder inside itself (through another one in the batch)",
          {
            index: f.index,
            code: "INTO_ITSELF",
          },
        );
      if (seen.has(x)) continue;
      seen.add(x);
      const g = at.get(x);
      if (g) queue.push(...g.folders);
    }
  }
}

// ---- move and rename

export interface MoveInput {
  from: EntryRef;
  /** Omit `folder` to rename in place, `name` to move under the same name. */
  to: {
    folder?: ParentRef;
    name?: string;
    /**
     * Required when the entry is a folder (MISUSE without it): the destination's path from a folder you name, which
     * the planner resolves again at the planning block and which must end at the destination. A folder is never
     * moved into itself or below itself on that path, under this Lens. There are no parent pointers, so this path is
     * the only check there is: name the start of your view (such as a home) as `from`.
     */
    via?: DestinationPath;
  };
}
export interface MoveEntriesInput {
  moves: readonly MoveInput[];
  lens?: Lens;
}
export interface MoveReviewItem extends LensView {
  from: EntryRef;
  to: EntryRef;
  target: EntryTarget;
  /** What this Lens shows at the old place afterwards: the next author's entry there, or nothing (null). */
  shownAfter: { author: PrincipalId } | null;
}
export interface MoveReview extends FolderReviewBase {
  kind: "efs.moveReview";
  moves: readonly MoveReviewItem[];
}

/**
 * Plan moves and renames of your own entries: each one RELEASEs the old place (the Lens falls through to the next
 * author there) and BINDs the new one, atomically in one publication. Links to the file or folder keep working; a
 * path through the old name answers ABSENT_PROVEN there. A batch plans every move or none (REFUSED lists each).
 */
export async function planMoveEntries(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: MoveEntriesInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<MoveReview>> {
  const types = typesOf(efs);
  if (!input.moves?.length) throw misuse("planMoveEntries needs at least one move");
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const moves = input.moves.map((m, i) => {
    const from = placeOf(m.from.folder, m.from.name, i);
    const to = placeOf(m.to.folder ?? m.from.folder, m.to.name ?? m.from.name, i);
    if (from.position === to.position)
      throw misuse("a move needs a new folder or a new name", { index: i });
    return { from, to, via: viaOf(m.to.via, i) };
  });
  const sources = new Set<Hex>();
  const dests = new Set<Hex>();
  for (const [i, m] of moves.entries()) {
    if (sources.has(m.from.position)) throw misuse("the same entry is moved twice", { index: i });
    if (dests.has(m.to.position)) throw misuse("two moves land on the same name", { index: i });
    sources.add(m.from.position);
    dests.add(m.to.position);
  }
  const places = moves.flatMap((m) => [m.from, m.to]);
  const ids = [...new Set(moves.flatMap((m) => [...parentIds([m.to]), nameRecord(types, m.to)]))];
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, places, ids);
    if (!r.ok) return r;
    const seen = r.value;
    const refused: EntryRefusal[] = [];
    const items: MoveReviewItem[] = [];
    const units: Unit[] = [];
    const namesPublished = new Set<Hex>();
    const folderMoves: { index: number; target: Hex; to: Hex; folders: readonly Hex[] }[] = [];
    let records = 0;
    for (const [i, m] of moves.entries()) {
      const from = seen.places.get(m.from.position) as PlaceState;
      const to = seen.places.get(m.to.position) as PlaceState;
      // Every refusal for this move is listed, the source's and the destination's.
      const mine = headState(from.mine.state) === "BOUND";
      if (!mine) refused.push(notMine(principals, from, me, i, m.from));
      if (!parentExists(m.to, seen.folders))
        refused.push({ index: i, code: "FOLDER_ABSENT", entry: entryOf(m.to) });
      if (headState(to.mine.state) === "BOUND")
        refused.push({ index: i, code: "NAME_TAKEN_MINE", entry: entryOf(m.to) });
      if (!mine) continue;
      const target = targetOf(from.mine);
      if (target.kind === "folder") {
        if (!m.via)
          throw misuse(
            "moving a folder needs `to.via`: the destination's path from a folder you name",
            {
              index: i,
            },
          );
        const folders = await pathFolders(ctx, s, basis, principals, m.via, m.to.folder);
        if (!folders.ok) return folders;
        if (folders.value === null) {
          refused.push({ index: i, code: "PATH_CHANGED", entry: entryOf(m.to) });
          continue;
        }
        folderMoves.push({
          index: i,
          target: target.directory,
          to: m.to.folder,
          folders: folders.value,
        });
      }
      if (refused.some((x) => x.index === i)) continue;
      const nameId = nameRecord(types, m.to);
      const needName =
        !(seen.records.get(nameId) as RecordInfo).present && !namesPublished.has(nameId);
      if (needName) namesPublished.add(nameId);
      const group = i + 1;
      const row = folderBindRow(to.mine, target.kind === "folder");
      const actions: PlannedAction[] = [
        ...(needName ? [publish(types.name, m.to.nameBytes, NAME_PROFILE, group)] : []),
        plain(
          {
            kind: ACTION.RELEASE,
            purpose: PURPOSES.folder,
            subject: m.from.folder,
            role: m.from.role,
            expectedRevision: BigInt(from.mine.revision),
          },
          { group, bindRow: "releaseFolder" },
        ),
        plain(
          {
            kind: ACTION.BIND,
            purpose: PURPOSES.folder,
            subject: m.to.folder,
            role: m.to.role,
            target: lower(from.mine.target),
            expectedRevision: BigInt(to.mine.revision),
          },
          {
            group,
            firstStatement: isUnset(to.mine),
            ...(row ? { bindRow: row } : {}),
          },
        ),
      ];
      if (needName) records++;
      const args = effectArgs(m.from, {
        toFolder: m.to.folder,
        toName: m.to.name,
        target: lower(from.mine.target),
      });
      units.push({
        effect: (stage, part, parts) => ({
          code: "files.move",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text:
            m.from.folder === m.to.folder
              ? `Rename ${m.from.name} to ${m.to.name}`
              : `Move ${m.from.name} to another folder${m.to.name !== m.from.name ? ` as ${m.to.name}` : ""}`,
        }),
        actions,
        finishes: true,
      });
      items.push({
        from: entryOf(m.from),
        to: entryOf(m.to),
        target,
        shownAfter: shownAfter(principals, from, me, "RELEASED"),
        ...viewAfterBind(principals, to, me),
      });
    }
    // Within one batch, a folder's new place can sit below another folder the same batch moves (a into b and b into
    // a would leave both reachable only by link): refuseCycles follows each destination through the others.
    refuseCycles(folderMoves);
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.moveReview", ...base, moves: items }),
          me,
          basis,
          records,
        ),
    };
  });
}

// ---- where else a target is placed

/**
 * The live placements pointing at each target (the backlink family's `live` count) at the basis, read from the
 * index generation the ledger names now. Null for a target whose count the index can't vouch for (coverage not
 * COMPLETE), or when the deployment names no backlink family.
 */
async function placements(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  targets: readonly Hex[],
): Promise<Step<(number | null)[]>> {
  const d = ctx.efs.deployment;
  const family = d.index.backlinkFamily;
  const nulls = targets.map(() => null);
  if (!family || !d.index.address || targets.length === 0) return { ok: true, value: nulls };
  ctx.requests += 1;
  const [ix] = await callsAt(s, basis.blockHash, [
    { to: d.ledger, data: encodeFunctionData({ abi: ledgerAbi, functionName: "index" }) },
  ]);
  if (!ix?.ok) return failed(ix);
  let index: Hex;
  try {
    index = decodeFunctionResult({
      abi: ledgerAbi,
      functionName: "index",
      data: ix.result as Hex,
    }) as Hex;
  } catch {
    return bad("index");
  }
  // Only the generation the deployment document names (its family ids are that generation's): another one, or an
  // endpoint that names another, can't vouch for the count.
  if (lower(index) !== d.index.address) return { ok: true, value: nulls };
  ctx.requests += targets.length;
  const outs = await callsAt(
    s,
    basis.blockHash,
    targets.map((t) => ({
      to: index,
      data: encodeFunctionData({
        abi: indexAbi,
        functionName: "postingHeadOf",
        // The FOLDER backlink list (Keys.backlinkList(FOLDER, target)): tags and other purposes never count.
        args: [family, PURPOSES.folder, 0, t],
      }),
    })),
  );
  const counts: (number | null)[] = [];
  for (const out of outs) {
    if (!out?.ok) return failed(out);
    try {
      const [coverage, , live] = decodeFunctionResult({
        abi: indexAbi,
        functionName: "postingHeadOf",
        data: out.result as Hex,
      }) as unknown as [number, bigint, bigint];
      counts.push(coverage === 3 ? Number(live) : null); // Coverage.COMPLETE
    } catch {
      return bad("postingHeadOf");
    }
  }
  return { ok: true, value: counts };
}

// ---- remove and restore

export interface RemoveEntriesInput {
  entries: readonly EntryRef[];
  /**
   * false (default): RELEASE: you no longer put anything at this name, so the Lens falls through to the next author's
   * entry there. true: UNBIND, a mask: nothing shows at this name for a reader who ranks you above the entry's
   * author. The chain lets anyone mask their own position; offering hide only to a place's owner is an app rule.
   */
  hide?: boolean;
  lens?: Lens;
}
export interface RemoveReviewItem {
  entry: EntryRef;
  target: EntryTarget;
  /** What this Lens shows at that name afterwards: the next author's entry, or nothing (null). */
  shownAfter: { author: PrincipalId } | null;
}
export interface RemoveReview extends FolderReviewBase {
  kind: "efs.removeReview";
  hide: boolean;
  entries: readonly RemoveReviewItem[];
}

/**
 * Plan removing your own entries from their folders. Nothing is destroyed: the file or folder stays reachable by its
 * link, and planRestoreEntries puts an entry back. A batch plans every removal or none (REFUSED lists each).
 */
export async function planRemoveEntries(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: RemoveEntriesInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<RemoveReview>> {
  if (!input.entries?.length) throw misuse("planRemoveEntries needs at least one entry");
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const hide = input.hide === true;
  const places = input.entries.map((e, i) => placeOf(e.folder, e.name, i));
  if (new Set(places.map((p) => p.position)).size !== places.length)
    throw misuse("the same entry is listed twice");
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, places, []);
    if (!r.ok) return r;
    const seen = r.value;
    const refused: EntryRefusal[] = [];
    const items: RemoveReviewItem[] = [];
    const units: Unit[] = [];
    for (const [i, p] of places.entries()) {
      const st = seen.places.get(p.position) as PlaceState;
      if (headState(st.mine.state) !== "BOUND") {
        refused.push(notMine(principals, st, me, i, p));
        continue;
      }
      const target = targetOf(st.mine);
      const args = effectArgs(p, { target: lower(st.mine.target), hide: String(hide) });
      units.push({
        effect: (stage, part, parts) => ({
          code: "files.remove",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Remove ${p.name}`,
        }),
        actions: [
          plain(
            {
              kind: hide ? ACTION.UNBIND : ACTION.RELEASE,
              purpose: PURPOSES.folder,
              subject: p.folder,
              role: p.role,
              expectedRevision: BigInt(st.mine.revision),
            },
            // your own bound entry: a later statement, priced by its own row
            { bindRow: hide ? "unbindFolder" : "releaseFolder" },
          ),
        ],
        finishes: true,
      });
      items.push({
        entry: entryOf(p),
        target,
        shownAfter: shownAfter(principals, st, me, hide ? "MASKED" : "RELEASED"),
      });
    }
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.removeReview", ...base, hide, entries: items }),
          me,
          basis,
          0,
        ),
    };
  });
}

export interface UnhideEntriesInput {
  entries: readonly EntryRef[];
  lens?: Lens;
}
export interface UnhideReviewItem {
  entry: EntryRef;
  /** What this Lens shows at that name afterwards: the next author's entry, or nothing (null). */
  shownAfter: { author: PrincipalId } | null;
}
export interface UnhideReview extends FolderReviewBase {
  kind: "efs.unhideReview";
  entries: readonly UnhideReviewItem[];
}

/**
 * Plan removing your hides (RELEASE of your own MASKED entries): the Lens falls through to the next author's entry at
 * each name again. It is the answer to a NEVER_BOUND row (a lone hide of someone else's entry), and works on any of
 * your hidden entries; to put your own target back instead, use planRestoreEntries. A batch plans every entry or none.
 */
export async function planUnhideEntries(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: UnhideEntriesInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<UnhideReview>> {
  if (!input.entries?.length) throw misuse("planUnhideEntries needs at least one entry");
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const places = input.entries.map((e, i) => placeOf(e.folder, e.name, i));
  if (new Set(places.map((p) => p.position)).size !== places.length)
    throw misuse("the same entry is listed twice");
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, places, []);
    if (!r.ok) return r;
    const seen = r.value;
    const refused: EntryRefusal[] = [];
    const items: UnhideReviewItem[] = [];
    const units: Unit[] = [];
    for (const [i, p] of places.entries()) {
      const st = seen.places.get(p.position) as PlaceState;
      const state = headState(st.mine.state);
      if (state !== "MASKED") {
        refused.push({
          index: i,
          code: state === "UNSET" ? "ENTRY_ABSENT" : "NOT_HIDDEN",
          entry: entryOf(p),
        });
        continue;
      }
      const args = effectArgs(p, {});
      units.push({
        effect: (stage, part, parts) => ({
          code: "files.unhide",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Unhide ${p.name}`,
        }),
        actions: [
          plain(
            {
              kind: ACTION.RELEASE,
              purpose: PURPOSES.folder,
              subject: p.folder,
              role: p.role,
              expectedRevision: BigInt(st.mine.revision),
            },
            { bindRow: "releaseFolder" },
          ),
        ],
        finishes: true,
      });
      items.push({ entry: entryOf(p), shownAfter: shownAfter(principals, st, me, "RELEASED") });
    }
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.unhideReview", ...base, entries: items }),
          me,
          basis,
          0,
        ),
    };
  });
}

// ---- hide another author's entry

/** An UNBIND (a mask) at your position for a place, after its name record when that is missing (effect files.hide). */
const hideUnit = (
  types: Types,
  p: Place,
  mine: RawHead,
  needName: boolean,
  group: number,
  extra: Record<string, string>,
): Unit => {
  const args = effectArgs(p, extra);
  return {
    effect: (stage, part, parts) => ({
      code: "files.hide",
      args: { ...args, part: String(part), parts: String(parts), stage },
      text: `Hide ${p.name}`,
    }),
    actions: [
      ...(needName ? [publish(types.name, p.nameBytes, NAME_PROFILE, group)] : []),
      plain(
        {
          kind: ACTION.UNBIND,
          purpose: PURPOSES.folder,
          subject: p.folder,
          role: p.role,
          expectedRevision: BigInt(mine.revision),
        },
        { group, firstStatement: isUnset(mine), bindRow: "unbindFolder" },
      ),
    ],
    finishes: true,
  };
};

const HIDE_NOTICE =
  "A hide covers this entry for anyone whose view puts you before its author. Other apps and views may still " +
  "show it, and the hide itself is public.";

export interface HideEntriesInput {
  entries: readonly EntryRef[];
  lens?: Lens;
}
export interface HideReviewItem {
  entry: EntryRef;
  /** The entry this Lens shows at that name now: the one the hide covers. */
  shownNow: { author: PrincipalId };
  /**
   * What this Lens shows afterwards: null when your hide covers the entry here, or an author ranked before you in
   * this Lens, whose entry your hide does not change.
   */
  shownAfter: { author: PrincipalId } | null;
}
export interface HideReview extends FolderReviewBase {
  kind: "efs.hideReview";
  entries: readonly HideReviewItem[];
  /** What a hide does, in plain words for the confirmation. */
  notice: string;
}

/**
 * Plan hiding other authors' entries (an UNBIND, a mask, at your own position at each name): nothing shows there for
 * a reader whose Lens puts you before the entry's author; readers who rank that author first still see it. The chain
 * lets anyone mask their own position, so this is not gated by ownership: whom to offer it (a folder's owner hiding
 * spam, say) is the app's rule. planUnhideEntries undoes it. Refused: NAME_TAKEN_MINE (your own entry: Remove and
 * block, planRemoveEntries with `hide: true`), ALREADY_HIDDEN, and ENTRY_ABSENT (this Lens shows nothing there). A
 * batch plans every entry or none.
 */
export async function planHideEntries(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: HideEntriesInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<HideReview>> {
  if (!input.entries?.length) throw misuse("planHideEntries needs at least one entry");
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const types = typesOf(efs);
  const places = input.entries.map((e, i) => placeOf(e.folder, e.name, i));
  if (new Set(places.map((p) => p.position)).size !== places.length)
    throw misuse("the same entry is listed twice");
  const nameIds = [...new Set(places.map((p) => nameRecord(types, p)))];
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, places, nameIds);
    if (!r.ok) return r;
    const seen = r.value;
    const refused: EntryRefusal[] = [];
    const items: HideReviewItem[] = [];
    const units: Unit[] = [];
    let published = 0;
    for (const [i, p] of places.entries()) {
      const st = seen.places.get(p.position) as PlaceState;
      const state = headState(st.mine.state);
      if (state === "BOUND") {
        refused.push({ index: i, code: "NAME_TAKEN_MINE", entry: entryOf(p) });
        continue;
      }
      if (state === "MASKED") {
        refused.push({ index: i, code: "ALREADY_HIDDEN", entry: entryOf(p) });
        continue;
      }
      const now = lensAt(principals, st, me);
      if (!now.shown) {
        refused.push({ index: i, code: "ENTRY_ABSENT", entry: entryOf(p) });
        continue;
      }
      // An entry shown here means the record exists (the validator needs it for a first statement); checked anyway.
      const needName = !(seen.records.get(nameRecord(types, p))?.present ?? false);
      if (needName) published++;
      units.push(hideUnit(types, p, st.mine, needName, i + 1, { author: now.shown }));
      items.push({
        entry: entryOf(p),
        shownNow: { author: now.shown },
        shownAfter: shownAfter(principals, st, me, "MASKED"),
      });
    }
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.hideReview", ...base, entries: items, notice: HIDE_NOTICE }),
          me,
          basis,
          published,
        ),
    };
  });
}

// ---- an entry with no file version (test-only: exported from @efs/sdk/testing)

export interface OtherEntryInput {
  /** A folder or a home. */
  folder: ParentRef;
  name: string;
  /** The CREATE salt (default: 32 random bytes). The subject is subjectId(writer, salt). */
  salt?: Hex;
  lens?: Lens;
}
export interface OtherEntryReview extends FolderReviewBase {
  kind: "efs.otherEntryReview";
  entry: EntryRef;
  /** The new subject: created, and never given a file version (no HEAD), so a listing shows it as kind "other". */
  subject: SubjectId;
}

/**
 * Test-only (exported from `@efs/sdk/testing`): plan placing a subject with no file version at a name (a CREATE, the
 * name record when it is missing, and the FOLDER bind), in a folder or a home. A listing shows it as kind "other": the
 * junk row an owner blocks with planHideEntries. Your own entry already at the name is NAME_TAKEN_MINE, a folder that
 * is not one FOLDER_ABSENT, and a salt you already used MISUSE.
 */
export async function planOtherEntry(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: OtherEntryInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<OtherEntryReview>> {
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const types = typesOf(efs);
  const p = placeOf(input.folder, input.name, 0);
  const salt = checkSalt(input.salt);
  const subject = lower(subjectId(me, salt)) as SubjectId;
  const nameId = nameRecord(types, p);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(
      ctx,
      s,
      basis,
      me,
      principals,
      [p],
      [...parentIds([p]), nameId],
      [subject],
    );
    if (!r.ok) return r;
    const seen = r.value;
    if (seen.created.get(subject))
      throw misuse("this salt was already used by this writer: pass a new one", { salt });
    const st = seen.places.get(p.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!parentExists(p, seen.folders))
      refused.push({ index: 0, code: "FOLDER_ABSENT", entry: entryOf(p) });
    if (headState(st.mine.state) === "BOUND")
      refused.push({ index: 0, code: "NAME_TAKEN_MINE", entry: entryOf(p) });
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    const needName = !(seen.records.get(nameId) as RecordInfo).present;
    const row = folderBindRow(st.mine, false);
    const actions: PlannedAction[] = [
      plain({ kind: ACTION.CREATE, saltOrStrength: salt }, { group: 1 }),
      ...(needName ? [publish(types.name, p.nameBytes, NAME_PROFILE, 1)] : []),
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: p.folder,
          role: p.role,
          target: subject,
          expectedRevision: BigInt(st.mine.revision),
        },
        {
          group: 1,
          firstStatement: isUnset(st.mine),
          ...(row ? { bindRow: row } : {}),
        },
      ),
    ];
    const args = effectArgs(p, { subject });
    const units: Unit[] = [
      {
        effect: (stage, part, parts) => ({
          code: "testing.other",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Place ${p.name} (no file version)`,
        }),
        actions,
        finishes: true,
      },
    ];
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.otherEntryReview", ...base, entry: entryOf(p), subject }),
          me,
          basis,
          needName ? 1 : 0,
        ),
    };
  });
}

// ---- an entry for an existing folder (test-only: exported from @efs/sdk/testing)

export interface FolderEntryInput {
  /** Where the entry goes: a folder or a home. */
  folder: ParentRef;
  name: string;
  /** The existing folder the entry points at (its directory record). */
  target: FolderRef;
  lens?: Lens;
}
export interface FolderEntryReview extends FolderReviewBase, LensView {
  kind: "efs.folderEntryReview";
  entry: EntryRef;
  target: FolderRef;
}

/**
 * Test tooling: the writer's own entry `name` in `folder`, pointing at an existing folder `target` (the name record
 * when missing, then the FOLDER bind). The SDK's planners only ever point a new entry at a folder they create or one
 * of your entries they move; this places a link to any folder, for tests that need one (a folder reachable two ways,
 * or a cycle). It deliberately does NOT refuse a cycle: making one is what it is for, and the chain allows it (it
 * refuses only a folder holding itself). Refusals: FOLDER_ABSENT (the parent) and NAME_TAKEN_MINE; MISUSE when
 * `target` is not a folder at the basis (its hash-checked record).
 */
export async function planFolderEntry(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: FolderEntryInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<FolderEntryReview>> {
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const types = typesOf(efs);
  const p = placeOf(input.folder, input.name, 0);
  const target = lower(input.target?.directory ?? "") as RecordId;
  if (!/^0x[0-9a-f]{64}$/.test(target))
    throw misuse("target is a folder: { kind: 'folder', directory }");
  const nameId = nameRecord(types, p);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, [p], [...parentIds([p]), nameId]);
    if (!r.ok) return r;
    const seen = r.value;
    // The target's own record, hash-checked: it must be a files-directory/1 record at the basis.
    ctx.requests += 1;
    const [out] = await callsAt(s, basis.blockHash, [recordCall(efs.deployment, target)]);
    const t = decodeFolderRecord(efs, target, out);
    if (!t.ok) return t;
    if (t.value.status !== "PRESENT" || !t.value.directory)
      throw misuse("target is not a folder at the basis (no files-directory/1 record there)", {
        target,
      });
    const st = seen.places.get(p.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!parentExists(p, seen.folders))
      refused.push({ index: 0, code: "FOLDER_ABSENT", entry: entryOf(p) });
    if (headState(st.mine.state) === "BOUND")
      refused.push({ index: 0, code: "NAME_TAKEN_MINE", entry: entryOf(p) });
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    const needName = !(seen.records.get(nameId) as RecordInfo).present;
    const row = folderBindRow(st.mine, true);
    const actions: PlannedAction[] = [
      ...(needName ? [publish(types.name, p.nameBytes, NAME_PROFILE, 1)] : []),
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: p.folder,
          role: p.role,
          target,
          expectedRevision: BigInt(st.mine.revision),
        },
        { group: 1, firstStatement: isUnset(st.mine), ...(row ? { bindRow: row } : {}) },
      ),
    ];
    const args = effectArgs(p, { target });
    const units: Unit[] = [
      {
        effect: (stage, part, parts) => ({
          code: "testing.folderEntry",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Place a link to a folder at ${p.name}`,
        }),
        actions,
        finishes: true,
      },
    ];
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({
            kind: "efs.folderEntryReview",
            ...base,
            entry: entryOf(p),
            target: { kind: "folder", directory: target },
            ...viewAfterBind(principals, st, me),
          }),
          me,
          basis,
          needName ? 1 : 0,
        ),
    };
  });
}

// ---- a lone hide (test-only: exported from @efs/sdk/testing)

export interface LoneHideInput {
  folder: ParentRef;
  name: string;
  lens?: Lens;
}
export interface LoneHideReview extends FolderReviewBase {
  kind: "efs.loneHideReview";
  entry: EntryRef;
  /** What this Lens shows at that name afterwards: an earlier author's entry, or nothing (null). */
  shownAfter: { author: PrincipalId } | null;
}

/**
 * Test-only (exported from `@efs/sdk/testing`): plan a lone hide, an UNBIND at a name where you never placed anything,
 * which listRemoved shows as NEVER_BOUND (the case Unhide answers). The name record is published first when it is
 * missing (the validator refuses a first statement without it). Throws MISUSE unless the name is lone for you: never
 * stated, or released after lone hides only (so a retried test can hide it again); your own entry, one you once
 * placed, or a hide already in place is not.
 */
export async function planLoneHide(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: LoneHideInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<LoneHideReview>> {
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const types = typesOf(efs);
  const p = placeOf(input.folder, input.name, 0);
  const nameId = nameRecord(types, p);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, [p], [nameId]);
    if (!r.ok) return r;
    const st = r.value.places.get(p.position) as PlaceState;
    const state = headState(st.mine.state);
    const notLone = (why: string): Step<() => Promise<FolderPlanResult<LoneHideReview>>> => ({
      ok: true,
      value: async () => {
        throw misuse(`planLoneHide: ${p.name} is not lone for you: ${why}`, { name: p.name });
      },
    });
    if (state === "BOUND") return notLone("your entry is there");
    if (state === "MASKED") return notLone("your hide is already there");
    if (state === "RELEASED") {
      const last = await lastBoundTarget(ctx, s, basis, bindingKey(me, p.position), st.mine);
      if (!last.ok) return last;
      if (last.value.last !== "NEVER_BOUND") return notLone("you placed something there before");
    }
    const needName = !(r.value.records.get(nameId)?.present ?? false);
    const units = [hideUnit(types, p, st.mine, needName, 1, {})];
    const item = { entry: entryOf(p), shownAfter: shownAfter(principals, st, me, "MASKED") };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.loneHideReview", ...base, ...item }),
          me,
          basis,
          needName ? 1 : 0,
        ),
    };
  });
}

// ---- a HEAD "not this" and a take-back (test-only: exported from @efs/sdk/testing)

export interface HeadStatementInput {
  file: FileRef;
}
export interface HeadStatementReview extends FolderReviewBase {
  kind: "efs.headStatementReview";
  file: FileRef;
  /** Your HEAD on the file before the statement. */
  before: "UNSET" | "BOUND" | "MASKED" | "RELEASED";
  /**
   * What the statement makes of it: a lone "not this" (UNSET before: an entry in the file's head-authors list, never a
   * version), your version hidden (BOUND before), another "not this" (MASKED or RELEASED before), or your version
   * taken back (a RELEASE).
   */
  statement: "lone-no" | "hide" | "no-again" | "release";
}

/**
 * Test-only (exported from `@efs/sdk/testing`): plan a HEAD statement on a file that no SDK planner makes, for
 * writer.runSequence. `planHeadNo` is an UNBIND, a "not this": from no head it is a lone no (an author with an entry in
 * the file's head-authors list and no version), from your own version it hides it. `planHeadRelease` is a RELEASE,
 * taking your HEAD back. Each reads your head at the planning block and states against its revision (E_CAS refuses
 * a stale one). MISUSE when the subject was never created, or for a release with nothing to take back.
 */
export async function planHeadNo(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: HeadStatementInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<HeadStatementReview>> {
  return planHeadStatement(efs, writer, input, ACTION.UNBIND, o);
}

/** Test-only (exported from `@efs/sdk/testing`): plan taking your HEAD on a file back (a RELEASE); see planHeadNo. */
export async function planHeadRelease(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: HeadStatementInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<HeadStatementReview>> {
  return planHeadStatement(efs, writer, input, ACTION.RELEASE, o);
}

async function planHeadStatement(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: HeadStatementInput,
  kind: number,
  o: FolderPlanOpts,
): Promise<FolderPlanResult<HeadStatementReview>> {
  const me = lower(writer.principal) as PrincipalId;
  const file = lower(input.file.subject) as SubjectId;
  const position = positionKey(PURPOSES.head, file, ZERO_WORD);
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const d = ctx.efs.deployment;
    ctx.requests += 2;
    const [sub, hd] = await callsAt(s, basis.blockHash, [
      subjectInfoCall(ctx.efs, file),
      {
        to: d.readers.ledgerViews,
        data: encodeFunctionData({
          abi: ledgerViewsAbi,
          functionName: "headsAt",
          args: [d.ledger, [me], position],
        }),
      },
    ]);
    const creator = decodeCreator(sub);
    if (!creator.ok) return creator;
    if (!hd?.ok) return failed(hd);
    let status: number;
    let all: readonly RawHead[];
    try {
      [status, , , all] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        data: hd.result as Hex,
      }) as unknown as [number, RawHead, number, RawHead[]];
    } catch {
      return bad("headsAt");
    }
    const st = chainStatus(status);
    if (st !== "PRESENT" && st !== "MASKED" && st !== "ABSENT_PROVEN")
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", `headsAt reads ${st}`),
      };
    const mine = all[0];
    if (!mine || all.length !== 1) return bad("headsAt (your head)");
    if (!headConsistent(mine.state, mine.revision))
      return bad("headsAt (a state its revision contradicts)");
    const before = headState(mine.state);
    if (before === "UNRECOGNIZED") return bad(`headsAt (head state ${mine.state})`);
    const refuse = (why: string): Step<() => Promise<FolderPlanResult<HeadStatementReview>>> => ({
      ok: true,
      value: async () => {
        throw misuse(why, { file });
      },
    });
    if (creator.value === null)
      return refuse("this subject was never created: there is no file to state about");
    if (kind === ACTION.RELEASE && (before === "UNSET" || before === "RELEASED"))
      return refuse(`your HEAD on this file is ${before}: there is nothing to take back`);
    const statement: HeadStatementReview["statement"] =
      kind === ACTION.RELEASE
        ? "release"
        : before === "UNSET"
          ? "lone-no"
          : before === "BOUND"
            ? "hide"
            : "no-again";
    const unit: Unit = {
      effect: (stage, part, parts) => ({
        code: kind === ACTION.RELEASE ? "test.headRelease" : "test.headNo",
        args: { file, part: String(part), parts: String(parts), stage },
        text: kind === ACTION.RELEASE ? "Take your version back" : "Say not this",
      }),
      actions: [
        plain(
          {
            kind,
            purpose: PURPOSES.head,
            subject: file,
            role: ZERO_WORD,
            expectedRevision: BigInt(mine.revision),
          },
          kind === ACTION.RELEASE
            ? { bindRow: "releaseHead" }
            : before === "UNSET"
              ? { firstStatement: true } // no HEAD lone-no row: priced at the dearest first UNBIND
              : { firstStatement: false, bindRow: "unbindHead" },
        ),
      ],
      finishes: true,
    };
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          [unit],
          (base) => ({
            kind: "efs.headStatementReview",
            ...base,
            file: input.file,
            before,
            statement,
          }),
          me,
          basis,
          0,
        ),
    };
  });
}

export interface RestoreEntriesInput {
  /**
   * `via` is required when the entry restored is a folder, as for planMoveEntries: the path to the entry's folder
   * from a folder you name, so a restore never puts a folder below itself (the tree may have changed since it was
   * removed).
   */
  entries: readonly (EntryRef & { via?: DestinationPath })[];
  lens?: Lens;
}
export interface RestoreReviewItem extends LensView {
  entry: EntryRef;
  /** The target the entry had before it was removed (read from its history). */
  target: EntryTarget;
  /**
   * How many live placements point at that target now, by anyone (the index's backlink count): above 0, restoring
   * puts it in one more place (for example after it was moved). Null when the index can't vouch for the count.
   */
  alsoPlaced: number | null;
}
export interface RestoreReview extends FolderReviewBase {
  kind: "efs.restoreReview";
  entries: readonly RestoreReviewItem[];
}

/**
 * Plan putting your removed entries back (released or hidden), each to the target it had before. If another
 * author's entry now shows at that name, the review says so (shownInstead): yours is restored beside it.
 */
export async function planRestoreEntries(
  efs: Efs,
  writer: { readonly principal: PrincipalId },
  input: RestoreEntriesInput,
  o: FolderPlanOpts = {},
): Promise<FolderPlanResult<RestoreReview>> {
  if (!input.entries?.length) throw misuse("planRestoreEntries needs at least one entry");
  const me = lower(writer.principal) as PrincipalId;
  const principals = lensPrincipals(efs, input.lens);
  const places = input.entries.map((e, i) => placeOf(e.folder, e.name, i));
  if (new Set(places.map((p) => p.position)).size !== places.length)
    throw misuse("the same entry is listed twice");
  const vias = input.entries.map((e, i) => viaOf(e.via, i));
  return atOneBasis(efs, o, async (ctx, s, basis) => {
    const r = await readSeen(ctx, s, basis, me, principals, places, []);
    if (!r.ok) return r;
    const seen = r.value;
    const refused: EntryRefusal[] = [];
    const items: RestoreReviewItem[] = [];
    const units: Unit[] = [];
    const restoredFolders: { index: number; target: Hex; to: Hex; folders: readonly Hex[] }[] = [];
    for (const [i, p] of places.entries()) {
      const st = seen.places.get(p.position) as PlaceState;
      const state = headState(st.mine.state);
      if (state === "BOUND") {
        refused.push({ index: i, code: "NOT_REMOVED", entry: entryOf(p) });
        continue;
      }
      if (state !== "MASKED" && state !== "RELEASED") {
        refused.push({ index: i, code: "ENTRY_ABSENT", entry: entryOf(p) });
        continue;
      }
      // The target to restore: the binding's last bound version, from its history (the same walk listRemoved shows).
      const last = await lastBoundTarget(ctx, s, basis, bindingKey(me, p.position), st.mine);
      if (!last.ok) return last;
      if (last.value.last === "NEVER_BOUND") {
        refused.push({ index: i, code: "NEVER_BOUND", entry: entryOf(p) });
        continue;
      }
      if (last.value.last === "UNKNOWN") {
        refused.push({
          index: i,
          code: "HISTORY_UNKNOWN",
          entry: entryOf(p),
          reason: last.value.reason,
        });
        continue;
      }
      const target = last.value.target;
      if (target.kind === "folder") {
        const via = vias[i];
        if (!via)
          throw misuse(
            "restoring a folder needs `via`: the path to its folder from a folder you name",
            {
              index: i,
            },
          );
        const folders = await pathFolders(ctx, s, basis, principals, via, p.folder);
        if (!folders.ok) return folders;
        if (folders.value === null) {
          refused.push({ index: i, code: "PATH_CHANGED", entry: entryOf(p) });
          continue;
        }
        restoredFolders.push({
          index: i,
          target: target.directory,
          to: p.folder,
          folders: folders.value,
        });
      }
      const targetWord = target.kind === "folder" ? target.directory : target.subject;
      const args = effectArgs(p, { target: targetWord });
      units.push({
        effect: (stage, part, parts) => ({
          code: "files.restore",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Restore ${p.name}`,
        }),
        actions: [
          plain(
            {
              kind: ACTION.BIND,
              purpose: PURPOSES.folder,
              subject: p.folder,
              role: p.role,
              target: targetWord,
              expectedRevision: BigInt(st.mine.revision),
            },
            // your own released or masked entry: the head exists (restoreFolder, or bindFolderAfterNo where it never
            // bound)
            { firstStatement: false, bindRow: folderBindRow(st.mine, false) ?? "restoreFolder" },
          ),
        ],
        finishes: true,
      });
      items.push({
        entry: entryOf(p),
        target,
        alsoPlaced: null,
        ...viewAfterBind(principals, st, me),
      });
    }
    refuseCycles(restoredFolders);
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    // Where else each target is placed now: the backlink list's live count, from the live index generation.
    const counted = await placements(
      ctx,
      s,
      basis,
      items.map((x) => lower(x.target.kind === "folder" ? x.target.directory : x.target.subject)),
    );
    if (!counted.ok) return counted;
    items.forEach((x, i) => {
      x.alsoPlaced = counted.value[i] ?? null;
    });
    return {
      ok: true,
      value: () =>
        toParts(
          efs,
          o,
          units,
          (base) => ({ kind: "efs.restoreReview", ...base, entries: items }),
          me,
          basis,
          0,
        ),
    };
  });
}
