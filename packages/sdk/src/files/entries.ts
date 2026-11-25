// SPDX-License-Identifier: MIT
// Folder writes: create a file or a folder under a parent, move or rename entries, remove them, restore them. Each
// planner reads the chain at one basis, never calls the wallet, and returns parts for writer.runSequence with a
// review and `files.*` effects, like planEditFile. Every write touches only the writer's own entries (FOLDER
// bindings are per author) with a compare-and-swap on each one's revision, so a race is refused by the ledger, never
// a silent overwrite.
//
// What each one publishes (contracts src/lib/EfsFiles.sol recipes; FilesFinalValidator: a FOLDER bind needs its
// name's files-name/2 record, a files-directory/1 parent and a created subject or a directory record as target):
//   create file    CREATE(salt), the root revision (inline, or chunks under a descriptor), the name record if new,
//                  BIND(HEAD, file → root), BIND(FOLDER, parent, name → file)
//   create folder  CREATE(salt), PUBLISH(files-directory/1), the name record if new, BIND(FOLDER, parent, name → it)
//   move / rename  the new name record if new, RELEASE(FOLDER, from), BIND(FOLDER, to → target): one publication
//   remove         RELEASE(FOLDER, at): the Lens falls through to the next author's entry. With hide: UNBIND, a
//                  mask: nothing shows there for a reader who ranks you above the entry's author
//   restore        BIND(FOLDER, at → the target it had before it was removed), read from the binding's history
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import type { SequencePartInput } from "../actions/sequence.js";
import { type PlannedAction, splitPublications } from "../actions/split.js";
import type { EffectView } from "../actions/types.js";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs, Lens } from "../client.js";
import { encode, FORM } from "../content/codec.js";
import { type CallOpts, EfsFault, misuse, type Reason, reason } from "../core/errors.js";
import {
  type Hex,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
  ZERO_WORD,
} from "../core/hex.js";
import { ledgerViewsAbi } from "../generated/abis.js";
import { ACTION, FILES, PURPOSES } from "../generated/constants.js";
import { checkName } from "../names/name.js";
import { bindingKey, positionKey, recordFromHash, recordId, subjectId } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import type { Ctx, FileRef } from "./bytes.js";
import {
  decodeCreator,
  type EntryRef,
  type EntryTarget,
  type FolderRef,
  lookupAt,
  subjectInfoCall,
} from "./folders.js";
import {
  askedMediaType,
  buildContent,
  type ContentLayout,
  checkContent,
  type ExternalContent,
  type FilesTypes,
  type GasOpts,
  gasSetup,
  plain,
  publish,
  randomSalt,
  tooManyBytes,
} from "./plan.js";

// ---- shared shapes

/** Why one entry of a plan was refused. A refused plan plans nothing, and lists every refusal at once. */
export interface EntryRefusal {
  /** The input's index (0 for the single-entry planners). */
  index: number;
  code: /** Your own entry already holds this name here: choose another name, or open it and save a new version. */
    | "NAME_TAKEN_MINE"
    /** The entry this Lens shows is another author's: you can move or remove only your own. */
    | "NOT_YOURS"
    /** The folder is not a files-directory/1 record on this chain. */
    | "FOLDER_ABSENT"
    /** You have no entry at this name (and no author in the Lens shows one). */
    | "ENTRY_ABSENT"
    /** Restore: your entry here is not removed. */
    | "NOT_REMOVED"
    /** The destination path (`via`) no longer reaches the destination folder under this Lens: resolve it again. */
    | "PATH_CHANGED";
  entry: EntryRef;
  /** NOT_YOURS: whose entry the Lens shows, and the admission that last set it (compare with Basis.admissions). */
  author?: PrincipalId;
  admission?: bigint;
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
  /** One approval per part, or one in all with an atomic EIP-5792 wallet. */
  prompts: { sequential: number; atomicBatch: 1 };
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

/** One place a planner touches: a name in a folder. */
interface Place {
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
  ];
  if (calls.length === 0)
    return { ok: true, value: { places: new Map(), records: new Map(), created: new Map() } };
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
  return { ok: true, value: { places: placesOut, records, created } };
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
    name: pick("files-name/2"),
  };
}
const folderOf = (f: FolderRef): Hex => {
  if (f?.kind !== "folder" || !/^0x[0-9a-fA-F]{64}$/.test(f.directory ?? ""))
    throw misuse("a folder is { kind: 'folder', directory: <files-directory/1 record id> }");
  return lower(f.directory);
};
/** A place from a folder and a name, or MISUSE with checkName's rule. */
function placeOf(folder: FolderRef, name: string, index: number): Place {
  const c = checkName(name);
  if (c.status !== "VALID")
    throw misuse(`not a files-name/2 name: ${c.status === "INVALID" ? c.rule : c.status}`, {
      index,
      name,
      ...(c.status === "INVALID"
        ? { rule: c.rule, ...(c.at !== undefined ? { at: c.at } : {}) }
        : {}),
    });
  const dir = folderOf(folder);
  const role = keccak256(c.bytes);
  return {
    folder: dir,
    name,
    nameBytes: c.bytes,
    role,
    position: positionKey(PURPOSES.folder, dir, role),
  };
}
const entryOf = (p: Place): EntryRef => ({
  folder: { kind: "folder", directory: p.folder as RecordId },
  name: p.name,
});
const nameRecord = (types: Types, p: Place): Hex => lower(recordFromHash(types.name, p.role));
const isFolder = (types: Types, r: RecordInfo | undefined): boolean =>
  !!r && r.present && r.typeId === types.directory && r.length === 32;
const TARGET_RECORD = FILES.targetKind.RECORD;
const targetOf = (h: RawHead): EntryTarget =>
  h.targetKind === TARGET_RECORD
    ? { kind: "folder", directory: lower(h.target) as RecordId }
    : { kind: "file", subject: lower(h.target) as SubjectId };
const lensPrincipals = (efs: Efs, lens: Lens | undefined): PrincipalId[] => {
  const ps = (lens ?? efs.lens.default).principals.map((p) => lower(p) as PrincipalId);
  if (ps.length === 0) throw misuse("a Lens names at least one principal");
  if (ps.length > READ_CHUNK) throw misuse(`a Lens names at most ${READ_CHUNK} principals`);
  return ps;
};
const freshFolderBindRow = (h: RawHead, directory: boolean) =>
  headState(h.state) === "UNSET"
    ? directory
      ? ("bindFolderFreshDirectory" as const)
      : ("bindFolderFreshFile" as const)
    : undefined; // a masked or released position is priced at the larger rows

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
  const g = gasSetup(d, o);
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
    return {
      actions: part.actions.map((a) => a.action),
      bodies: part.actions.map((a) => a.body),
      effects: [...touched].map(([u, fin]) =>
        (units[u] as Unit).effect(fin ? "finish" : "content", i + 1, n),
      ),
      ...(o.deadlineSeconds !== undefined ? { deadlineSeconds: o.deadlineSeconds } : {}),
    };
  });
  return {
    kind: "efs.folderPlan",
    status: "PLANNED",
    parts,
    review: review({
      author: me,
      parts: n,
      prompts: { sequential: n, atomicBatch: 1 },
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
  /** The parent folder. There is no default: where a path starts is the caller's. */
  folder: FolderRef;
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
  folder: FolderRef;
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
      [place.folder, nameId],
      [file],
    );
    if (!r.ok) return r;
    const seen = r.value;
    // CREATE refuses a salt this writer already used: say so now, never as a revert.
    if (seen.created.get(file))
      throw misuse("this salt was already used by this writer: pass a new one", { salt });
    const st = seen.places.get(place.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!isFolder(types, seen.records.get(place.folder)))
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
    finish.push(plain({ kind: ACTION.CREATE, salt }, { group: FINISH }));
    finish.push(
      publish(
        types.root,
        rootBody,
        `files-root/1 form ${built.descriptor ? FORM.content : FORM.inline}`,
        FINISH,
      ),
    );
    if (!nameExists) finish.push(publish(types.name, place.nameBytes, "files-name/2", FINISH));
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
    const folderRow = freshFolderBindRow(st.mine, false);
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
        { group: FINISH, ...(folderRow ? { bindRow: folderRow } : {}) },
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
  /** The parent folder. */
  folder: FolderRef;
  name: string;
  lens?: Lens;
  /** The CREATE salt (default: 32 random bytes); the new folder's subject is subjectId(writer, salt). */
  salt?: Hex;
}
export interface CreateFolderReview extends FolderReviewBase, LensView {
  kind: "efs.createFolderReview";
  /** The parent. */
  folder: FolderRef;
  name: string;
  /** The new folder (its object link is its subject). */
  created: FolderRef & { subject: SubjectId };
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
  const subject = lower(subjectId(me, salt)) as SubjectId;
  const dirBody = encode.directory(subject);
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
      [place.folder, nameId],
      [subject],
    );
    if (!r.ok) return r;
    const seen = r.value;
    if (seen.created.get(subject))
      throw misuse("this salt was already used by this writer: pass a new one", { salt });
    const st = seen.places.get(place.position) as PlaceState;
    const refused: EntryRefusal[] = [];
    if (!isFolder(types, seen.records.get(place.folder)))
      refused.push({ index: 0, code: "FOLDER_ABSENT", entry: entryOf(place) });
    if (headState(st.mine.state) === "BOUND")
      refused.push({ index: 0, code: "NAME_TAKEN_MINE", entry: entryOf(place) });
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
    const nameExists = (seen.records.get(nameId) as RecordInfo).present;
    const row = freshFolderBindRow(st.mine, true);
    const actions: PlannedAction[] = [
      plain({ kind: ACTION.CREATE, salt }, { group: 1 }),
      publish(types.directory, dirBody, "files-directory/1", 1),
      ...(nameExists ? [] : [publish(types.name, place.nameBytes, "files-name/2", 1)]),
      plain(
        {
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: place.folder,
          role: place.role,
          target: directory,
          expectedRevision: BigInt(st.mine.revision),
        },
        { group: 1, ...(row ? { bindRow: row } : {}) },
      ),
    ];
    const args = effectArgs(place, { directory, subject });
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
            created: { kind: "folder", directory, subject },
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
  from: FolderRef;
  segments: readonly string[];
}
type Via = { from: Hex; names: Uint8Array[] };
const viaOf = (v: DestinationPath | undefined, index: number): Via | undefined => {
  if (v === undefined) return undefined;
  const from = folderOf(v.from);
  if (!Array.isArray(v.segments)) throw misuse("`via.segments` is a list of names", { index });
  const names = v.segments.map((n, j) => {
    const c = checkName(n);
    if (c.status !== "VALID")
      throw misuse(
        `not a files-name/2 name in \`via\`: ${c.status === "INVALID" ? c.rule : c.status}`,
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
  const folders: Hex[] = [via.from];
  let at: FolderRef = { kind: "folder", directory: via.from as RecordId };
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
    folder?: FolderRef;
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
  const ids = [...new Set(moves.flatMap((m) => [m.to.folder, nameRecord(types, m.to)]))];
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
      if (!isFolder(types, seen.records.get(m.to.folder)))
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
      const row = freshFolderBindRow(to.mine, target.kind === "folder");
      const actions: PlannedAction[] = [
        ...(needName ? [publish(types.name, m.to.nameBytes, "files-name/2", group)] : []),
        plain(
          {
            kind: ACTION.RELEASE,
            purpose: PURPOSES.folder,
            subject: m.from.folder,
            role: m.from.role,
            expectedRevision: BigInt(from.mine.revision),
          },
          { group },
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
          { group, ...(row ? { bindRow: row } : {}) },
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
          plain({
            kind: hide ? ACTION.UNBIND : ACTION.RELEASE,
            purpose: PURPOSES.folder,
            subject: p.folder,
            role: p.role,
            expectedRevision: BigInt(st.mine.revision),
          }),
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
}
export interface RestoreReview extends FolderReviewBase {
  kind: "efs.restoreReview";
  entries: readonly RestoreReviewItem[];
}

/** History hops walked back to the last bound target (each removal is one hop; a few is plenty). */
const RESTORE_HOPS = 8;

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
  const d = efs.deployment;
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
      // Walk the binding's history back to its last bound version: that is the target to restore.
      const key = bindingKey(me, p.position);
      let asOf = BigInt(st.mine.prevAdmission);
      let prior: RawHead | undefined;
      for (let hop = 0; hop < RESTORE_HOPS && asOf > 0n; hop++) {
        ctx.requests += 1;
        const [out] = await callsAt(s, basis.blockHash, [
          {
            to: d.readers.ledgerViews,
            data: encodeFunctionData({
              abi: ledgerViewsAbi,
              functionName: "historyAt",
              args: [d.ledger, key, asOf, RESTORE_HOPS],
            }),
          },
        ]);
        if (!out?.ok) return failed(out);
        let found: number;
        let h: RawHead;
        try {
          [found, h] = decodeFunctionResult({
            abi: ledgerViewsAbi,
            functionName: "historyAt",
            data: out.result as Hex,
          }) as unknown as [number, RawHead];
        } catch {
          return bad("historyAt");
        }
        if (found !== 3)
          // History.FOUND
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason(
              "NOT_YET_DECIDABLE",
              "transient",
              "the entry's history could not be read back",
            ),
          };
        if (headState(h.state) === "BOUND") {
          prior = h;
          break;
        }
        asOf = BigInt(h.prevAdmission);
      }
      if (!prior) {
        refused.push({ index: i, code: "ENTRY_ABSENT", entry: entryOf(p) });
        continue;
      }
      const target = targetOf(prior);
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
      const args = effectArgs(p, { target: lower(prior.target) });
      units.push({
        effect: (stage, part, parts) => ({
          code: "files.restore",
          args: { ...args, part: String(part), parts: String(parts), stage },
          text: `Restore ${p.name}`,
        }),
        actions: [
          plain({
            kind: ACTION.BIND,
            purpose: PURPOSES.folder,
            subject: p.folder,
            role: p.role,
            target: lower(prior.target),
            expectedRevision: BigInt(st.mine.revision),
          }),
        ],
        finishes: true,
      });
      items.push({ entry: entryOf(p), target, ...viewAfterBind(principals, st, me) });
    }
    refuseCycles(restoredFolders);
    if (refused.length) return { ok: true, value: async () => refusedResult(refused, basis) };
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
