// SPDX-License-Identifier: MIT
// Folders (files-directory/1): list a folder's entries, look up one name, and resolve a path of names, all under a
// Lens and always from a parent the caller names. There is no default root: where a path starts (a folder, the
// Realm's shared root among them, or a home: an address) is the caller's, so no link format bakes one in.
//
// A folder is a files-directory/1 record; its entries are FOLDER bindings `(FOLDER, directory, keccak(name)) →
// target`, one per author, where the target is a file subject or another directory record. A home is an address in
// the same place: `(FOLDER, left-padded address, keccak(name))` (FilesFinalValidator admits an address-shaped parent),
// so anyone can attach files and folders to any address, and every read and write here takes either. The Lens decides which
// author's entry a name shows: the first author in Lens order with a bound entry, unless an earlier author's
// removal-with-hide (a mask) stops the search (contracts FilesPageReader/1, LensReader/1; ledger headsAt).
//
// Same-named entries: a listing has one row per name (the reader's rule). A lookup returns the Lens's choice AND
// every author in the Lens with an entry at that name (in Lens order, each with when it was first placed), so an app
// can show them as a list instead and order them as it likes.
import { decodeFunctionResult, encodeFunctionData, keccak256 } from "viem";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { RpcOutcome } from "../chain/rpc.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
import {
  type Address,
  bytesToHex,
  type Hex,
  hexToBytes,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
} from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import {
  filesPageReaderAbi,
  ledgerReadsAbi,
  ledgerViewsAbi,
  lensReaderAbi,
} from "../generated/abis.js";
import { FILES, PURPOSES } from "../generated/constants.js";
import type { HomeLink, PathLink } from "../names/links.js";
import { checkName, decodeScalars, type NameRule } from "../names/name.js";
import { contractPrincipal, keyPrincipal, positionKey } from "../protocol/keys.js";
import { chainStatus, headState } from "../protocol/status.js";
import {
  type Ctx,
  decodeHead,
  EMPTY_BASIS,
  type Evidence,
  type FileRef,
  headCall,
  type OpenResult,
  openResult,
  openSelected,
  type ReadOpts,
  type RevisionOpen,
} from "./bytes.js";

/**
 * A folder: its files-directory/1 record id, which is also its permanent link (`~efs/o/<directory>`) and the subject
 * of its entries' FOLDER bindings. The record's body is (creator, salt) and only its creator may publish it, so the
 * id names one folder of one owner forever. `openObject` tells a folder's id from a file's.
 */
export interface FolderRef {
  kind: "folder";
  directory: RecordId;
  /** The principal that created it (the record's word 0), where a read saw it: the `owner` efs.lens.place takes. */
  owner?: PrincipalId;
}
/**
 * A home: an address as a folder parent (design §12.5). Its entries are FOLDER bindings at the left-padded address,
 * the word the gateway's `/0x<address>/…` serves. A home always exists (any address but zero), so it has no record and
 * no creator: anyone may attach entries to anyone's address, and the Lens decides whose show.
 */
export interface HomeRef {
  kind: "home";
  /** The address, lowercase. */
  address: Address;
  /**
   * The address's own author identity at the read's block (the gateway's `Keys.principalFor`): the key principal of
   * a key account (an EIP-7702 account included), the Realm's contract principal of a contract (so a Safe's home
   * shows the Safe's own entries). Set where a read saw it: the `owner` efs.lens.place takes.
   *
   * It is true only as of that read's basis, and it can change: a counterfactual Safe's address is a key-principal
   * home until code is deployed there, then the contract's; an EOA that sets or clears an EIP-7702 delegation to
   * anything but the exact designator changes too. Never cache it across bases: read it again with the home.
   */
  owner?: PrincipalId;
}
/** Where entries live: a folder (a files-directory/1 record) or a home (an address). */
export type ParentRef = FolderRef | HomeRef;
/** One name in one folder or home. */
export interface EntryRef {
  folder: ParentRef;
  name: string;
}
/** What a folder entry points at: a file (subject) or a folder (directory record). */
export type EntryTarget = FileRef | FolderRef;
/**
 * What a row is. In this generation the chain admits only files and folders as entries, so the kind is the Type:
 * - folder: a files-directory/1 record;
 * - file: a subject whose HEAD under this Lens is a Files revision;
 * - other: a subject with no Files HEAD under this Lens (an app's object, or a file no author in the Lens has a
 *   HEAD for);
 * - invalid: a row that breaks a Files rule (returned, never dropped).
 * A filter by Type id arrives with tag and topic views, where items of any Type appear.
 */
export type EntryKind = "folder" | "file" | "other" | "invalid";

export interface FolderRow {
  name: string;
  /** The entry's FOLDER position: (FOLDER, folder, keccak(name)). */
  position: Hex;
  kind: EntryKind;
  /**
   * The Type id of what the row shows: files-directory/1 for a folder, the HEAD revision's Type (files-root/1 or
   * files-child/1) for a file. Absent for other and invalid rows.
   */
  typeId?: Hex;
  /** With `withSize`: a file's content length in bytes, from its HEAD revision (inline) or its descriptor. */
  size?: bigint;
  /** Null only for an invalid row whose target kind is not a file or a folder. */
  target: EntryTarget | null;
  /** The author whose entry this Lens shows at this name. */
  author: PrincipalId;
  /** The admission (ledger order) of the entry's latest change. */
  admission: bigint;
  /** For file rows: the HEAD revision this Lens shows. */
  head?: { record: RecordId; revision: bigint };
}

/** One author's live entry at a name. */
export interface EntryCandidate {
  author: PrincipalId;
  target: EntryTarget | null;
  /** When this author first placed something at this name (the binding's ordinal): lower is older. */
  firstBound: bigint;
  /** The admission of the entry's latest change. */
  admission: bigint;
  /** The entry's binding revision. */
  revision: bigint;
}

export type FolderCoverage =
  | { state: "COMPLETE" }
  /**
   * MORE_PAGES: `next` continues the listing. RESUMED: a page reached from a cursor is never proof of the whole
   * listing (the chain's law); with no `next`, the listing ended. LIMIT/GAS are folded into MORE_PAGES.
   */
  /**
   * INDEX_PARTIAL: a scan from the start ended, but the index cannot vouch that it saw every entry; the rows are
   * real, and there may be more.
   */
  | { state: "PARTIAL"; why: "MORE_PAGES" | "RESUMED" | "INDEX_PARTIAL" }
  /** The index could not vouch for the listing's coverage: the rows are real, but "that's all" is not known. */
  | { state: "UNKNOWN"; reason: Reason };

/** Continues a listing. Plain data; valid only for the same folder, Lens and kinds (MISUSE otherwise). */
export interface FolderCursor {
  v: 1;
  query: Hex;
  continuation: Hex;
}

export interface ListFolderOpts extends CallOpts {
  lens?: Lens;
  /** Only these kinds. Rows of other kinds are counted in `skipped.filtered`, never silently dropped. */
  kinds?: readonly EntryKind[];
  /** Rows the chain returns per page, before filtering (default 50, at most 64). */
  limit?: number;
  /**
   * Also read each file's size: one more read per file row (its revision's head words), and one more round trip for
   * files stored under a descriptor (its length word). Off by default; a size can also come from openFile later.
   */
  withSize?: boolean;
  cursor?: FolderCursor;
}

export type FolderPage =
  | {
      kind: "efs.folderPage";
      status: "PRESENT";
      /** The listed folder, with its owner (the record's creator), or home, with its owner (the address's identity). */
      folder: ParentRef;
      rows: readonly FolderRow[];
      /**
       * hidden: names an earlier author in the Lens removed with hide (a mask), so nothing shows there. filtered: rows
       * the `kinds` filter left out. Neither is ever "absent".
       */
      skipped: { hidden: number; filtered: number };
      /** COMPLETE only for a listing scanned from its start to its end on one page. An empty PARTIAL page means "keep reading". */
      coverage: FolderCoverage;
      next?: FolderCursor;
      /**
       * How many times this page was read again because its readers disagreed about the chain's state at one block
       * (BASIS_STALE between calls). Absent when none. Every attempt is in `evidence.attempts`. On a real chain this
       * should stay absent: a count here means the endpoint answered one block hash from two states.
       */
      rereads?: number;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.folderPage";
      /**
       * ABSENT_PROVEN: no such folder (no files-directory/1 record): never "an empty folder". INVALID: the record is
       * not a folder, or the reader refused. UNKNOWN: nothing decided (a cursor gone stale is BASIS_STALE, retry
       * after-replan: list from the start).
       */
      status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID";
      folder: ParentRef;
      reason: Reason;
      /**
       * How many times this page was read again because its readers disagreed about the chain's state at one block
       * (BASIS_STALE between calls). Absent when none. Every attempt is in `evidence.attempts`. On a real chain this
       * should stay absent: a count here means the endpoint answered one block hash from two states.
       */
      rereads?: number;
      basis?: Basis;
      evidence: Evidence;
    };

export type EntryLookup =
  | {
      kind: "efs.entry";
      status: "PRESENT";
      entry: EntryRef;
      /** The Lens's choice: the first author in Lens order with a bound entry. */
      selected: FolderRow;
      /**
       * Every author in the Lens with a bound entry at this name, in Lens order. Each carries `firstBound`, so an app
       * that shows same-named entries as a list can order them by when each was first placed.
       */
      candidates: readonly EntryCandidate[];
      /** More than one author in the Lens has an entry here. */
      conflict: boolean;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.entry";
      /** An author in the Lens removed this name with hide, before any bound entry: nothing shows here. */
      status: "MASKED";
      entry: EntryRef;
      by: PrincipalId;
      /** Entries behind the mask, in Lens order: present, but this Lens does not show them. */
      candidates: readonly EntryCandidate[];
      conflict: boolean;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.entry";
      status: "ABSENT_PROVEN";
      entry: EntryRef;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.entry";
      status: "UNKNOWN" | "INVALID";
      entry: EntryRef;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

export interface PathStep {
  folder: ParentRef;
  name: string;
  author: PrincipalId;
  target: EntryTarget;
}

export type PathResolution =
  | {
      kind: "efs.path";
      status: "PRESENT";
      target: EntryTarget;
      /** The last segment's lookup: the Lens's choice, and every candidate at that name. */
      entry: Extract<EntryLookup, { status: "PRESENT" }>;
      /** Each segment as this Lens resolved it, with its author (so "whose /photos" is answerable). */
      chain: readonly PathStep[];
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.path";
      /** Segment `segment` (0-based) has no entry under this Lens, or an author in the Lens removed it with hide. */
      status: "ABSENT_PROVEN" | "MASKED";
      segment: number;
      chain: readonly PathStep[];
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.path";
      /** Segment `segment` is a file (or another non-folder), so the path cannot continue below it. */
      status: "NOT_A_FOLDER";
      segment: number;
      chain: readonly PathStep[];
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.path";
      status: "INVALID";
      /** The segment that is not a files-name/2 name (`rule`), or the reader refused. */
      segment?: number;
      rule?: NameRule;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.path";
      status: "UNKNOWN";
      segment?: number;
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

/** One page's rows fit one Lens resolution (64 coordinates) and one header read (maxReadIds). */
const MAX_LIST_LIMIT = 64;
/** Gas the page reader keeps for one more row and the return encoding (a row is about 150k). */
const PAGE_GAS_RESERVE = 1_000_000n;
// FilesPageReader Query fields and row kinds (src/readers/FilesPageReader.sol).
const F_NAME = 1;
const F_HEADER = 2;
const F_KIND = 4;
const ROW_WHITEOUT = 3;
const ROW_INVALID = 4;
const TARGET_RECORD = FILES.targetKind.RECORD;
const TARGET_SUBJECT = FILES.targetKind.SUBJECT;
const ZERO = `0x${"0".repeat(64)}` as Hex;

/** @internal The word a parent's entries are keyed by: a folder's record id, a home's left-padded address. */
export const parentSubject = (p: ParentRef): Hex =>
  p.kind === "home" ? (keyPrincipal(p.address) as Hex) : lower(p.directory);

/** @internal The FOLDER position of `name` in `folder`. */
export const entryPosition = (folder: ParentRef, nameBytes: Uint8Array): Hex =>
  positionKey(PURPOSES.folder, parentSubject(folder), keccak256(nameBytes));

/** @internal A binding target as a typed ref. */
export const targetRef = (targetKind: number, target: Hex): EntryTarget | null =>
  targetKind === TARGET_RECORD
    ? { kind: "folder", directory: lower(target) as RecordId }
    : targetKind === TARGET_SUBJECT
      ? { kind: "file", subject: lower(target) as SubjectId }
      : null;

/**
 * @internal A parent as the reads key it (lowercase, no owner), or MISUSE: a folder is `{ kind: "folder", directory }`
 * and a home `{ kind: "home", address }` with a nonzero 20-byte address (the kernel never admits a zero subject).
 */
export const checkParent = (p: ParentRef): ParentRef => {
  if (p?.kind === "home") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p.address ?? "") || /^0x0{40}$/.test(p.address))
      throw misuse("a home is { kind: 'home', address: <a nonzero 20-byte address> }");
    return { kind: "home", address: lower(p.address) as Address };
  }
  if (p?.kind !== "folder" || !/^0x[0-9a-fA-F]{64}$/.test(p.directory ?? ""))
    throw misuse(
      "a folder is { kind: 'folder', directory: <files-directory/1 record id> }, a home { kind: 'home', address }",
    );
  // A record id is a keccak-256 output: one with 12 leading zero bytes is an address (a home), never a folder.
  if (/^0x0{24}/.test(p.directory))
    throw misuse("that id is an address-shaped word: a home is { kind: 'home', address }");
  return { kind: "folder", directory: lower(p.directory) as RecordId };
};
const lensOf = (efs: Efs, lens: Lens | undefined): PrincipalId[] => {
  const ps = (lens ?? efs.lens.default).principals.map((p) => lower(p) as PrincipalId);
  if (ps.length === 0) throw misuse("a Lens names at least one principal");
  return ps;
};
const failed = (out: { ok: false; reason: Reason } | undefined): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
});
const badReply = (what: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", `${what} did not decode`),
});

type FolderRecord =
  | { status: "PRESENT"; directory: boolean; owner: PrincipalId }
  | { status: "ABSENT_PROVEN" };

/** @internal The ledger's records call for folder ids: whether each is a files-directory/1 record, and its subject. */
const recordsCall = (efs: Efs, ids: readonly Hex[]) => ({
  to: efs.deployment.readers.ledgerViews,
  data: encodeFunctionData({
    abi: ledgerViewsAbi,
    functionName: "records",
    args: [efs.deployment.ledger, ids as Hex[]],
  }),
});
const decodeRecords = (
  efs: Efs,
  out: Awaited<ReturnType<typeof callsAt>>[number] | undefined,
  n: number,
): Step<FolderRecord[]> => {
  if (!out?.ok) return failed(out);
  let statuses: readonly number[];
  let headers: readonly { typeId: Hex; word0: Hex; length: number }[];
  try {
    [statuses, headers] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "records",
      data: out.result as Hex,
    }) as unknown as [typeof statuses, typeof headers];
  } catch {
    return badReply("records");
  }
  if (statuses.length !== n || headers.length !== n) return badReply("records (one per id)");
  const dirType = lower(efs.deployment.typeIds["files-directory/1"] as Hex);
  const res: FolderRecord[] = [];
  for (let i = 0; i < n; i++) {
    const st = chainStatus(statuses[i] as number);
    const h = headers[i] as { typeId: Hex; word0: Hex; length: number };
    if (st === "ABSENT_PROVEN") res.push({ status: "ABSENT_PROVEN" });
    else if (st === "PRESENT")
      res.push({
        status: "PRESENT",
        directory: lower(h.typeId) === dirType && Number(h.length) === 64,
        owner: lower(h.word0) as PrincipalId, // the body is (creator, salt)
      });
    else
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", `records: ${st}`),
      };
  }
  return { ok: true, value: res };
};

/**
 * @internal A deployless eth_call that answers `Keys.principalFor`'s inputs for `address` at the call's block: a zero
 * word first (EIP-3541 refuses returned code that starts with 0xEF), the code size, then the code's first 3 bytes.
 * `PUSH20 a; EXTCODESIZE; PUSH1 0x20; MSTORE; PUSH1 3; PUSH1 0; PUSH1 0x40; PUSH20 a; EXTCODECOPY; PUSH1 0x60;
 * PUSH1 0; RETURN`.
 */
export const principalProbe = (address: Address): CallRequest => {
  const a = address.slice(2).toLowerCase();
  return { data: `0x73${a}3b602052600360006040${`73${a}3c`}60606000f3` as Hex };
};
/** @internal The author identity `principalProbe` describes (the gateway's Keys.principalFor). */
export const decodePrincipal = (efs: Efs, address: Address, out: Outcome): Step<PrincipalId> => {
  if (!out?.ok) return failed(out);
  const r = String(out.result);
  if (!/^0x[0-9a-fA-F]{192}$/.test(r) || !/^0x0{64}/.test(r)) return badReply("the code probe");
  const size = BigInt(`0x${r.slice(66, 130)}`);
  const prefix = r.slice(130, 136).toLowerCase();
  // No code, or exactly the 23-byte EIP-7702 designator `ef0100 ‖ address`: the signing key's own namespace.
  if (size === 0n || (size === 23n && prefix === "ef0100"))
    return { ok: true, value: keyPrincipal(address) };
  return { ok: true, value: contractPrincipal(efs.deployment.realmOrigin, address) };
};
/** @internal The call that proves a parent and names its owner: a folder's record, a home's code probe. */
export const parentCall = (efs: Efs, p: ParentRef): CallRequest =>
  p.kind === "home" ? principalProbe(p.address) : recordsCall(efs, [lower(p.directory)]);
/**
 * @internal `parentCall`'s answer: PRESENT with the owner (a folder's creator, a home's author identity),
 * ABSENT_PROVEN (no record has a folder's id) or NOT_A_FOLDER (a record of another Type). A home is always PRESENT.
 */
export const decodeParent = (
  efs: Efs,
  p: ParentRef,
  out: Outcome,
): Step<
  | { status: "PRESENT"; owner: PrincipalId }
  | { status: "ABSENT_PROVEN" }
  | { status: "NOT_A_FOLDER" }
> => {
  if (p.kind === "home") {
    const o = decodePrincipal(efs, p.address, out);
    return o.ok ? { ok: true, value: { status: "PRESENT", owner: o.value } } : o;
  }
  const r = decodeRecords(efs, out, 1);
  if (!r.ok) return r;
  const x = r.value[0] as FolderRecord;
  if (x.status === "ABSENT_PROVEN") return { ok: true, value: { status: "ABSENT_PROVEN" } };
  if (!x.directory) return { ok: true, value: { status: "NOT_A_FOLDER" } };
  return { ok: true, value: { status: "PRESENT", owner: x.owner } };
};

/** A reader's refusal status as a Reason (null when the status is a served one). */
function refusal(
  code: number,
  what: string,
): { status: "UNKNOWN" | "INVALID"; reason: Reason } | null {
  const st = chainStatus(code);
  if (st === "PRESENT" || st === "ABSENT_PROVEN" || st === "MASKED") return null;
  if (st === "BASIS_STALE")
    return {
      status: "UNKNOWN",
      reason: reason(
        "BASIS_STALE",
        "after-replan",
        `${what}: the basis moved; read again from the start`,
      ),
    };
  if (st === "LIMIT_EXCEEDED")
    return { status: "INVALID", reason: reason("LIMIT_EXCEEDED", "never", `${what}: ${st}`) };
  if (st === "INVALID" || st === "UNSUPPORTED")
    return { status: "INVALID", reason: reason("UNSUPPORTED_PROFILE", "never", `${what}: ${st}`) };
  return { status: "UNKNOWN", reason: reason("RPC_ERROR", "transient", `${what}: ${st}`) };
}

/** Strict UTF-8 (the name rule admits only well-formed UTF-8); null when malformed. */
const decodeName = (hex: Hex): string | null => decodeScalars(hexToBytes(hex))?.text ?? null;

type RawRow = {
  position: Hex;
  name: Hex;
  targetKind: number;
  target: Hex;
  headRecord: Hex;
  headRevision: bigint;
  admission: bigint;
  headerWord0: Hex;
  rowKind: number;
};

/** A reader row's kind: folder, file (a Files HEAD under the Lens), other (no HEAD), or invalid. */
const rowKind = (r: RawRow): EntryKind => {
  if (r.rowKind === ROW_INVALID) return "invalid";
  if (r.targetKind === TARGET_RECORD) return "folder";
  if (r.targetKind === TARGET_SUBJECT) return r.headRecord === ZERO ? "other" : "file";
  return "invalid";
};

const toRow = (r: RawRow, author: PrincipalId): FolderRow | null => {
  const name = decodeName(r.name);
  const kind = name === null ? "invalid" : rowKind(r);
  const target = targetRef(r.targetKind, r.target);
  return {
    name: name ?? "",
    position: lower(r.position),
    kind: target === null ? "invalid" : kind,
    target,
    author,
    admission: BigInt(r.admission),
    ...(kind === "file"
      ? { head: { record: lower(r.headRecord) as RecordId, revision: BigInt(r.headRevision) } }
      : {}),
  };
};

const queryOf = (folder: ParentRef, principals: readonly Hex[], kinds: readonly string[]): Hex =>
  keccak256(
    utf8Encode(
      JSON.stringify([
        "efs-sdk/folder-cursor/1",
        parentSubject(folder),
        principals,
        [...kinds].sort(),
      ]),
    ),
  );

/** @internal */
export const subjectInfoCall = (efs: Efs, subject: Hex): CallRequest => ({
  to: efs.deployment.readers.ledgerReads,
  data: encodeFunctionData({
    abi: ledgerReadsAbi,
    functionName: "subjectInfo",
    args: [efs.deployment.ledger, subject],
  }),
});
const bodySliceCall = (efs: Efs, id: Hex, offset: number, length: number): CallRequest => ({
  to: efs.deployment.readers.ledgerReads,
  data: encodeFunctionData({
    abi: ledgerReadsAbi,
    functionName: "bodySlice",
    args: [efs.deployment.ledger, id, offset, length],
  }),
});
/** @internal */
export type Outcome = Awaited<ReturnType<typeof callsAt>>[number] | undefined;
/** @internal The subject's creator, or null when the subject was never created. */
export const decodeCreator = (out: Outcome): Step<PrincipalId | null> => {
  if (!out?.ok) return failed(out);
  try {
    const [st, , creator] = decodeFunctionResult({
      abi: ledgerReadsAbi,
      functionName: "subjectInfo",
      data: out.result as Hex,
    }) as unknown as [number, bigint, Hex];
    const cs = chainStatus(st);
    if (cs === "ABSENT_PROVEN") return { ok: true, value: null };
    if (cs !== "PRESENT") return badReply(`subjectInfo (${cs})`);
    return { ok: true, value: lower(creator) as PrincipalId };
  } catch {
    return badReply("subjectInfo");
  }
};
const decodeSlice = (out: Outcome): Step<Uint8Array> => {
  if (!out?.ok) return failed(out);
  try {
    const [st, body] = decodeFunctionResult({
      abi: ledgerReadsAbi,
      functionName: "bodySlice",
      data: out.result as Hex,
    }) as unknown as [number, Hex];
    if (chainStatus(st) !== "PRESENT") return badReply("bodySlice (status)");
    return { ok: true, value: hexToBytes(body) };
  } catch {
    return badReply("bodySlice");
  }
};
const wordAt = (b: Uint8Array, i: number): Hex | undefined =>
  b.length >= (i + 1) * 32 ? (bytesToHex(b.subarray(i * 32, (i + 1) * 32)) as Hex) : undefined;

/**
 * The details a page's rows carry beyond the reader's: each file's HEAD revision Type and, with `withSize`, each
 * file's size (folders' owners come with their records). Mutates `rows`.
 */
async function pageDetails(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  rows: FolderRow[],
  withSize: boolean,
): Promise<Step<null>> {
  const efs = ctx.efs;
  const t = efs.deployment.typeIds as Record<string, Hex>;
  const rootType = lower(t["files-root/1"] as Hex);
  const childType = lower(t["files-child/1"] as Hex);
  const dirType = lower(t["files-directory/1"] as Hex);
  const files = rows.filter((r) => r.kind === "file" && r.head);
  for (const r of rows) if (r.kind === "folder") r.typeId = dirType;
  const calls: CallRequest[] = [];
  const headIds = files.map((r) => (r.head as { record: Hex }).record);
  const ri = headIds.length > 0 ? calls.push(recordsCall(efs, headIds)) - 1 : -1;
  const si = calls.length;
  if (withSize) for (const id of headIds) calls.push(bodySliceCall(efs, id, 0, 128));
  if (calls.length === 0) return { ok: true, value: null };
  ctx.requests += calls.length;
  const outs = await callsAt(s, basis.blockHash, calls);
  const lengths: (number | undefined)[] = [];
  if (ri >= 0) {
    const out = outs[ri];
    if (!out?.ok) return failed(out);
    let statuses: readonly number[];
    let headers: readonly { typeId: Hex; length: number }[];
    try {
      [statuses, headers] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "records",
        data: out.result as Hex,
      }) as unknown as [number[], { typeId: Hex; length: number }[]];
    } catch {
      return badReply("records");
    }
    if (statuses.length !== files.length || headers.length !== files.length)
      return badReply("records (one per id)");
    for (const [i, r] of files.entries()) {
      const h = headers[i] as { typeId: Hex; length: number };
      if (chainStatus(statuses[i] as number) !== "PRESENT")
        return badReply("records (a HEAD revision)");
      r.typeId = lower(h.typeId);
      lengths.push(Number(h.length));
    }
  }
  if (!withSize || files.length === 0) return { ok: true, value: null };
  // Inline revisions: the size is the body after the revision's header. Descriptors: their length word (word 4).
  const later: { row: FolderRow; descriptor: Hex }[] = [];
  for (const [i, r] of files.entries()) {
    const slice = decodeSlice(outs[si + i]);
    if (!slice.ok) return slice;
    const child = r.typeId === childType;
    if (!child && r.typeId !== rootType) continue;
    const form = wordAt(slice.value, child ? 2 : 1);
    const length = lengths[i] as number;
    const header = child ? 96 : 64;
    if (form !== undefined && BigInt(form) === 0n) r.size = BigInt(Math.max(0, length - header));
    else if (form !== undefined && BigInt(form) === 1n) {
      const descriptor = wordAt(slice.value, child ? 3 : 2);
      if (descriptor) later.push({ row: r, descriptor });
    }
  }
  if (later.length > 0) {
    ctx.requests += later.length;
    const outs2 = await callsAt(
      s,
      basis.blockHash,
      later.map((x) => bodySliceCall(efs, x.descriptor, 128, 32)),
    );
    for (const [i, x] of later.entries()) {
      const slice = decodeSlice(outs2[i]);
      if (!slice.ok) return slice;
      const w = wordAt(slice.value, 0);
      if (w !== undefined) x.row.size = BigInt(w);
    }
  }
  return { ok: true, value: null };
}

/**
 * One page of a folder's entries under a Lens, read at one block. Names an earlier author removed with hide are
 * counted (`skipped.hidden`), and rows the `kinds` filter leaves out are counted (`skipped.filtered`): neither ever
 * reads as "nothing here". COMPLETE only when the whole listing was scanned from its start on this page.
 */
export async function listFolder(
  efs: Efs,
  folder: ParentRef,
  o: ListFolderOpts = {},
): Promise<FolderPage> {
  // BASIS_STALE means the readers saw the chain move between calls: read the page again at a fresh basis, a bounded
  // number of times. A cursor the page reader itself refuses as stale is the caller's to restart; one refused only
  // by a follow-up read is still good, so that page is read again too.
  const attempts: Evidence["attempts"][number][] = [];
  let requests = 0;
  for (let attempt = 1; ; attempt++) {
    const page = await listFolderOnce(efs, folder, o);
    attempts.push(...page.evidence.attempts);
    requests += page.evidence.requests;
    const stale = page.status === "UNKNOWN" && page.reason.code === "BASIS_STALE";
    if (!stale || attempt >= 3 || (o.cursor && !rereadable.has(page.reason)))
      return attempt === 1
        ? page
        : { ...page, rereads: attempt - 1, evidence: { attempts, requests } };
  }
}

/** BASIS_STALE reasons raised after a page was served (the page can simply be read again). */
const rereadable = new WeakSet<Reason>();

async function listFolderOnce(efs: Efs, folder: ParentRef, o: ListFolderOpts): Promise<FolderPage> {
  const dir = checkParent(folder);
  const subject = parentSubject(dir);
  const principals = lensOf(efs, o.lens);
  const kinds = o.kinds ?? [];
  const limit = o.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT)
    throw misuse(`limit is a whole number from 1 to ${MAX_LIST_LIMIT}`);
  const query = queryOf(dir, principals, kinds);
  if (o.cursor && (o.cursor.v !== 1 || o.cursor.query !== query))
    throw misuse("this cursor continues another listing (another folder, Lens or kinds)");
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.folderPage",
      status: "UNKNOWN",
      folder: dir,
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const d = efs.deployment;
  type Out =
    | {
        kind: "page";
        folder: ParentRef;
        rows: FolderRow[];
        hidden: number;
        filtered: number;
        coverage: FolderCoverage;
        next?: Hex;
      }
    | { kind: "refused"; status: "ABSENT_PROVEN" | "UNKNOWN" | "INVALID"; reason: Reason };
  const r = await onEndpoint<Out>(
    efs._internal.pool,
    async (s) => {
      ctx.requests += 2;
      const [rec, out] = await callsAt(s, basis.blockHash, [
        parentCall(efs, dir),
        {
          to: d.readers.filesPage,
          data: encodeFunctionData({
            abi: filesPageReaderAbi,
            functionName: "listDirectory",
            args: [
              subject,
              principals,
              { fields: F_NAME | F_HEADER | F_KIND, tagConcept: ZERO, kinds: 0 },
              EMPTY_BASIS,
              o.cursor?.continuation ?? "0x",
              limit,
              PAGE_GAS_RESERVE,
            ],
          }),
        },
      ]);
      if (!out?.ok) return failed(out);
      // The folder itself: a listing of something that is not a folder is never "an empty folder". A home always
      // exists; its probe names its owner.
      const self = decodeParent(efs, dir, rec);
      if (!self.ok) return self;
      const me = self.value;
      if (me.status === "ABSENT_PROVEN")
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "ABSENT_PROVEN",
            reason: reason("NOT_YET_DECIDABLE", "never", "no folder has this record id"),
          },
        };
      if (me.status === "NOT_A_FOLDER")
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "INVALID",
            reason: reason(
              "UNSUPPORTED_PROFILE",
              "never",
              "this record is not a files-directory/1 folder",
            ),
          },
        };
      const owner = me.owner;
      let page: {
        q: { status: number; observed: { admissionHighWater: bigint } };
        rows: readonly RawRow[];
        listingCoverage: number;
        next: Hex;
        completeFromOrigin: boolean;
        startsAtOrigin: boolean;
      };
      try {
        page = decodeFunctionResult({
          abi: filesPageReaderAbi,
          functionName: "listDirectory",
          data: out.result as Hex,
        }) as unknown as typeof page;
      } catch {
        return badReply("listDirectory");
      }
      const refused = refusal(page.q.status, "listDirectory");
      if (refused) {
        if (refused.reason.code === "BASIS_STALE" && !o.cursor)
          return { ok: false, retryElsewhere: true, reason: refused.reason }; // a fresh listing: another endpoint may agree
        return { ok: true, value: { kind: "refused", ...refused } };
      }
      // Authors: the reader's rows do not carry them. Named rows resolve under the Lens in one call; a row with no
      // name (an INVALID row: no files-name/2 record for its role) is resolved by its position, so one bad row never
      // costs the rest of the page.
      const shown = page.rows.filter((x) => x.rowKind !== ROW_WHITEOUT);
      const named = shown.filter((x) => x.name !== "0x");
      const unnamed = shown.filter((x) => x.name === "0x");
      const folderIds = shown
        .filter((x) => x.targetKind === TARGET_RECORD)
        .map((x) => lower(x.target));
      const authorOf = new Map<Hex, PrincipalId>();
      const owners = new Map<Hex, PrincipalId>();
      if (shown.length > 0) {
        const calls: CallRequest[] = [];
        const si =
          named.length > 0
            ? calls.push({
                to: d.readers.lens,
                data: encodeFunctionData({
                  abi: lensReaderAbi,
                  functionName: "resolveManyAt",
                  args: [
                    principals,
                    named.map((x) => ({
                      purpose: PURPOSES.folder,
                      subject,
                      role: keccak256(x.name), // checked below: the position must be the row's
                    })),
                    page.q.observed.admissionHighWater,
                    EMPTY_BASIS,
                  ],
                }),
              }) - 1
            : -1;
        const fi = folderIds.length > 0 ? calls.push(recordsCall(efs, folderIds)) - 1 : -1;
        const hi = calls.length;
        for (const x of unnamed)
          calls.push({
            to: d.readers.ledgerViews,
            data: encodeFunctionData({
              abi: ledgerViewsAbi,
              functionName: "headsAt",
              args: [d.ledger, principals as Hex[], lower(x.position)],
            }),
          });
        ctx.requests += calls.length;
        const outs = await callsAt(s, basis.blockHash, calls);
        if (fi >= 0) {
          const fr = decodeRecords(efs, outs[fi], folderIds.length);
          if (!fr.ok) return fr;
          fr.value.forEach((x, i) => {
            // The chain admits only files-directory/1 records as folder entries; anything else is not given a subject.
            if (x.status === "PRESENT" && x.directory) owners.set(folderIds[i] as Hex, x.owner);
          });
        }
        if (si >= 0) {
          const sel = outs[si];
          if (!sel?.ok) return failed(sel);
          let q: { status: number };
          let sels: readonly { status: number; target: Hex; principalId: Hex }[];
          try {
            [q, sels] = decodeFunctionResult({
              abi: lensReaderAbi,
              functionName: "resolveManyAt",
              data: sel.result as Hex,
            }) as unknown as [typeof q, typeof sels];
          } catch {
            return badReply("resolveManyAt");
          }
          const refusedSel = refusal(q.status, "resolveManyAt");
          if (refusedSel) {
            // The page itself was served; only the follow-up read saw another basis. The cursor (if any) is still
            // good, so this page can be read again as it is.
            if (refusedSel.reason.code === "BASIS_STALE") rereadable.add(refusedSel.reason);
            return { ok: false, retryElsewhere: true, reason: refusedSel.reason };
          }
          for (let i = 0; i < named.length; i++) {
            const row = named[i] as RawRow;
            const x = sels[i];
            // The same block, the same Lens: the selection must be the row the page reader returned.
            if (
              !x ||
              chainStatus(x.status) !== "PRESENT" ||
              lower(x.target) !== lower(row.target) ||
              positionKey(PURPOSES.folder, subject, keccak256(row.name)) !== lower(row.position)
            )
              return {
                ok: false,
                retryElsewhere: true,
                reason: reason(
                  "RPC_ERROR",
                  "transient",
                  "the Lens and page readers disagree on a row",
                ),
              };
            authorOf.set(lower(row.position), lower(x.principalId) as PrincipalId);
          }
        }
        for (const [i, row] of unnamed.entries()) {
          const out = outs[hi + i];
          if (!out?.ok) return failed(out);
          let status: number;
          let selectedIndex: number;
          let all: readonly RawHead[];
          try {
            [status, , selectedIndex, all] = decodeFunctionResult({
              abi: ledgerViewsAbi,
              functionName: "headsAt",
              data: out.result as Hex,
            }) as unknown as [number, RawHead, number, RawHead[]];
          } catch {
            return badReply("headsAt");
          }
          const st = chainStatus(status);
          if (
            st !== "PRESENT" ||
            !selectionAgrees(
              st,
              Number(selectedIndex),
              all.map((x) => headState(x.state)),
            ) ||
            lower((all[Number(selectedIndex)] as RawHead).target) !== lower(row.target)
          )
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason(
                "RPC_ERROR",
                "transient",
                "the ledger and page reader disagree on a row",
              ),
            };
          authorOf.set(lower(row.position), principals[Number(selectedIndex)] as PrincipalId);
        }
      }
      const want = new Set<string>(kinds);
      const rows: FolderRow[] = [];
      let hidden = 0;
      let filtered = 0;
      for (const raw of page.rows) {
        if (raw.rowKind === ROW_WHITEOUT) {
          hidden++;
          continue;
        }
        const row = toRow(raw, authorOf.get(lower(raw.position)) as PrincipalId);
        if (!row) continue;
        if (row.target?.kind === "folder") {
          const owner = owners.get(row.target.directory);
          if (owner) row.target = { ...row.target, owner };
          else row.kind = "invalid"; // a folder entry whose record is not a folder
        }
        if (want.size > 0 && !want.has(row.kind)) {
          filtered++;
          continue;
        }
        rows.push(row);
      }
      // Types, owners and (withSize) sizes: one more batch, and one for sizes held in descriptors.
      const details = await pageDetails(ctx, s, basis, rows, o.withSize === true);
      if (!details.ok) return details;
      const cov = page.listingCoverage;
      const more = page.next !== "0x";
      // COMPLETE needs the reader's claim AND what this call knows: started at the origin, no cursor, nothing after.
      const complete = page.completeFromOrigin && page.startsAtOrigin && !o.cursor && !more;
      if (page.completeFromOrigin && !complete)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "RPC_ERROR",
            "transient",
            "the reader claimed a complete listing it cannot be",
          ),
        };
      const coverage: FolderCoverage = complete
        ? { state: "COMPLETE" }
        : cov === 1 // Coverage.UNKNOWN
          ? {
              state: "UNKNOWN",
              reason: reason(
                "NOT_YET_DECIDABLE",
                "transient",
                "the index does not vouch for this listing yet",
              ),
            }
          : { state: "PARTIAL", why: more ? "MORE_PAGES" : o.cursor ? "RESUMED" : "INDEX_PARTIAL" };
      // A page with no rows is "empty" only when COMPLETE. A fresh scan that ended without COMPLETE and found
      // nothing to show cannot say "nothing here", so it is UNKNOWN rather than an empty page with nowhere to go.
      if (rows.length === 0 && coverage.state !== "COMPLETE" && !more && !o.cursor)
        return {
          ok: true,
          value: {
            kind: "refused",
            status: "UNKNOWN",
            reason: reason(
              "NOT_YET_DECIDABLE",
              "transient",
              "the index cannot vouch for an empty listing of this folder yet",
            ),
          },
        };
      return {
        ok: true,
        value: {
          kind: "page",
          folder: { ...dir, owner },
          rows,
          hidden,
          filtered,
          coverage,
          ...(more ? { next: page.next } : {}),
        },
      };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return {
      kind: "efs.folderPage",
      status: "UNKNOWN",
      folder: dir,
      reason: r.reason,
      basis,
      evidence,
    };
  const v = r.value;
  if (v.kind === "refused")
    return {
      kind: "efs.folderPage",
      status: v.status,
      folder: dir,
      reason: v.reason,
      basis,
      evidence,
    };
  return {
    kind: "efs.folderPage",
    status: "PRESENT",
    folder: v.folder,
    rows: v.rows,
    skipped: { hidden: v.hidden, filtered: v.filtered },
    coverage: v.coverage,
    ...(v.next ? { next: { v: 1, query, continuation: v.next } } : {}),
    basis,
    evidence,
  };
}

// ---- one name

type RawHead = {
  state: number;
  revision: bigint;
  admission: bigint;
  targetKind: number;
  bindingOrdinal: bigint;
  target: Hex;
};
/** @internal */
export type Looked =
  | { status: "NOT_A_FOLDER" }
  | { status: "PRESENT"; selected: FolderRow; candidates: EntryCandidate[]; conflict: boolean }
  | { status: "MASKED"; by: PrincipalId; candidates: EntryCandidate[]; conflict: boolean }
  | { status: "ABSENT_PROVEN" }
  | { status: "UNKNOWN" | "INVALID"; reason: Reason };

/**
 * @internal Whether a headsAt reply's own status and selected index are what the Lens law gives for the heads it
 * returned: the first BOUND or MASKED head in Lens order is selected (PRESENT for BOUND, MASKED for MASKED), and none
 * at all is ABSENT_PROVEN. Anything else is a reply this SDK refuses.
 */
export function selectionAgrees(
  status: string,
  selectedIndex: number,
  states: readonly string[],
): boolean {
  const first = states.findIndex((x) => x === "BOUND" || x === "MASKED");
  if (status === "ABSENT_PROVEN") return first < 0;
  if (first < 0 || first !== selectedIndex) return false;
  return (
    (status === "PRESENT" && states[first] === "BOUND") ||
    (status === "MASKED" && states[first] === "MASKED")
  );
}

/**
 * @internal Look up `name` in `folder` under the Lens, on one endpoint at the basis: the ledger's heads for every
 * Lens author (headsAt: the selection and every candidate) and, when something is selected, the page reader's row
 * (its kind and HEAD), checked against each other. `full: false` skips the row (a path's middle segments).
 */
export async function lookupAt(
  ctx: Ctx,
  s: Session,
  basis: Basis,
  principals: readonly PrincipalId[],
  folder: ParentRef,
  nameBytes: Uint8Array,
  full: boolean,
  verifyFolder = false,
  /** With `verifyFolder`: set to the folder's creator, from the record that proves it is a folder. */
  folderSeen?: { owner?: PrincipalId },
): Promise<Step<Looked>> {
  const d = ctx.efs.deployment;
  const position = entryPosition(folder, nameBytes);
  const role = keccak256(nameBytes);
  ctx.requests += (full ? 2 : 1) + (verifyFolder ? 1 : 0);
  const calls: CallRequest[] = [
    {
      to: d.readers.ledgerViews,
      data: encodeFunctionData({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        args: [d.ledger, principals as Hex[], position],
      }),
    },
  ];
  const li = full
    ? calls.push({
        to: d.readers.filesPage,
        data: encodeFunctionData({
          abi: filesPageReaderAbi,
          functionName: "lookupName",
          args: [parentSubject(folder), role, principals as Hex[], EMPTY_BASIS],
        }),
      }) - 1
    : -1;
  const fi = verifyFolder ? calls.push(parentCall(ctx.efs, folder)) - 1 : -1;
  const outs = await callsAt(s, basis.blockHash, calls);
  const h = outs[0];
  const l = li >= 0 ? outs[li] : undefined;
  if (!h?.ok) return failed(h);
  if (verifyFolder) {
    // The folder a path descends into must be a files-directory/1 record (or a home), checked in the same batch.
    const fr = decodeParent(ctx.efs, folder, outs[fi]);
    if (!fr.ok) return fr;
    const x = fr.value;
    if (x.status !== "PRESENT") return { ok: true, value: { status: "NOT_A_FOLDER" } };
    if (folderSeen) folderSeen.owner = x.owner;
  }
  let status: number;
  let selectedIndex: number;
  let all: readonly RawHead[];
  try {
    [status, , selectedIndex, all] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "headsAt",
      data: h.result as Hex,
    }) as unknown as [number, RawHead, number, RawHead[]];
  } catch {
    return badReply("headsAt");
  }
  if (all.length !== principals.length) return badReply("headsAt (one head per Lens author)");
  const refused = refusal(status, "headsAt");
  if (refused) return { ok: true, value: refused };
  const candidates: EntryCandidate[] = [];
  for (let i = 0; i < all.length; i++) {
    const x = all[i] as RawHead;
    if (headState(x.state) !== "BOUND") continue;
    candidates.push({
      author: principals[i] as PrincipalId,
      target: targetRef(x.targetKind, x.target),
      firstBound: BigInt(x.bindingOrdinal),
      admission: BigInt(x.admission),
      revision: BigInt(x.revision),
    });
  }
  const conflict = candidates.length > 1;
  const st = chainStatus(status);
  // Recompute the Lens law from the heads themselves (first BOUND or MASKED in Lens order) and refuse a reply whose
  // own selection disagrees: an endpoint cannot pick a different author than the heads it returned.
  const agrees = selectionAgrees(
    st,
    Number(selectedIndex),
    all.map((x) => headState(x.state)),
  );
  if (!agrees)
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason(
        "RPC_ERROR",
        "transient",
        "headsAt's selection is not the first touch in Lens order",
      ),
    };
  if (st === "ABSENT_PROVEN") return { ok: true, value: { status: "ABSENT_PROVEN" } };
  const by = principals[selectedIndex] as PrincipalId | undefined;
  if (!by) return badReply("headsAt (selected index)");
  if (st === "MASKED") return { ok: true, value: { status: "MASKED", by, candidates, conflict } };
  const sel = all[selectedIndex] as RawHead;
  if (st !== "PRESENT" || headState(sel.state) !== "BOUND") return badReply("headsAt (selection)");
  let selected: FolderRow;
  if (full) {
    if (!l?.ok) return failed(l);
    let q: { status: number };
    let row: RawRow;
    try {
      [q, row] = decodeFunctionResult({
        abi: filesPageReaderAbi,
        functionName: "lookupName",
        data: l.result as Hex,
      }) as unknown as [typeof q, RawRow];
    } catch {
      return badReply("lookupName");
    }
    const qs = chainStatus(q.status);
    if (qs !== "PRESENT" && qs !== "INVALID") {
      const ref = refusal(q.status, "lookupName");
      return ref
        ? { ok: true, value: ref }
        : {
            ok: false,
            retryElsewhere: true,
            reason: reason(
              "RPC_ERROR",
              "transient",
              `lookupName reads ${qs} where the heads read PRESENT`,
            ),
          };
    }
    if (lower(row.target) !== lower(sel.target) || lower(row.position) !== position)
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason(
          "RPC_ERROR",
          "transient",
          "the ledger and the page reader disagree on this name",
        ),
      };
    const r = toRow(row, by);
    if (!r) return badReply("lookupName (row)");
    if (qs === "INVALID") {
      // The reader judged the row against the Files rules and refused it: never a usable file or folder.
      r.kind = "invalid";
      delete r.head;
    }
    if (r.target?.kind === "folder") {
      ctx.requests += 1;
      const [rec] = await callsAt(s, basis.blockHash, [recordsCall(ctx.efs, [r.target.directory])]);
      const fr = decodeRecords(ctx.efs, rec, 1);
      if (!fr.ok) return fr;
      const x = fr.value[0] as FolderRecord;
      if (x.status === "PRESENT" && x.directory) r.target = { ...r.target, owner: x.owner };
      else r.kind = "invalid";
    }
    selected = r;
  } else {
    const target = targetRef(sel.targetKind, sel.target);
    selected = {
      name: decodeScalars(nameBytes)?.text ?? "",
      position,
      kind: target?.kind === "folder" ? "folder" : target ? "other" : "invalid",
      target,
      author: by,
      admission: BigInt(sel.admission),
    };
  }
  return { ok: true, value: { status: "PRESENT", selected, candidates, conflict } };
}

const validName = (name: string): Uint8Array => {
  const c = checkName(name);
  if (c.status !== "VALID")
    throw misuse(`not a files-name/2 name: ${c.status === "INVALID" ? c.rule : c.status}`, {
      name,
      ...(c.status === "INVALID"
        ? { rule: c.rule, ...(c.at !== undefined ? { at: c.at } : {}) }
        : {}),
    });
  return c.bytes;
};

/**
 * Look up one name in a folder under a Lens: the Lens's choice (`selected`), and every author in the Lens with an
 * entry at that name, in Lens order with when each was first placed (`candidates`), so an app can show same-named
 * entries as a list. An invalid name throws MISUSE (checkName's rule in `details`).
 */
export async function lookupEntry(
  efs: Efs,
  entry: EntryRef,
  o: ReadOpts = {},
): Promise<EntryLookup> {
  const parent = checkParent(entry.folder);
  const bytes = validName(entry.name);
  const principals = lensOf(efs, o.lens);
  const e: EntryRef = { folder: parent, name: entry.name };
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.entry",
      status: "UNKNOWN",
      entry: e,
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const r = await onEndpoint<Looked>(
    efs._internal.pool,
    (s) => lookupAt(ctx, s, basis, principals, e.folder, bytes, true, true),
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return { kind: "efs.entry", status: "UNKNOWN", entry: e, reason: r.reason, basis, evidence };
  // The folder itself is checked in the same batch: a name in something that is not a folder is never "absent".
  if (r.value.status === "NOT_A_FOLDER")
    return {
      kind: "efs.entry",
      status: "INVALID",
      entry: e,
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        "the folder is not a files-directory/1 record",
      ),
      basis,
      evidence,
    };
  return { kind: "efs.entry", entry: e, ...r.value, basis, evidence } as EntryLookup;
}

export interface ResolvePathOpts extends ReadOpts {
  /**
   * Your own guard on the walk: refuse (INVALID, LIMIT_EXCEEDED) a path longer than this. There is no default limit:
   * a path has exactly as many segments as it was given, one read each.
   */
  maxSegments?: number;
}

/**
 * Resolve a path of names from a folder the caller names, under a Lens, at one block. Each segment follows the
 * Lens's choice; the last returns its full lookup (every candidate). Rename-proof sharing uses object links: a path
 * is a lookup, and a rename or move can break it.
 */
export async function resolvePath(
  efs: Efs,
  path: { from: ParentRef; segments: readonly string[] },
  o: ResolvePathOpts = {},
): Promise<PathResolution> {
  const from = checkParent(path.from);
  const principals = lensOf(efs, o.lens);
  const segments = path.segments;
  const none: Evidence = { attempts: [], requests: 0 };
  if (segments.length === 0) throw misuse("a path has at least one segment");
  if (o.maxSegments !== undefined && segments.length > o.maxSegments)
    return {
      kind: "efs.path",
      status: "INVALID",
      reason: reason("LIMIT_EXCEEDED", "never", `the path has more than ${o.maxSegments} segments`),
      evidence: none,
    };
  const names: Uint8Array[] = [];
  for (let i = 0; i < segments.length; i++) {
    const c = checkName(segments[i] as string);
    if (c.status !== "VALID")
      return {
        kind: "efs.path",
        status: "INVALID",
        segment: i,
        ...(c.status === "INVALID" ? { rule: c.rule } : {}),
        reason: reason("UNSUPPORTED_PROFILE", "never", `segment ${i} is not a files-name/2 name`),
        evidence: none,
      };
    names.push(c.bytes);
  }
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.path",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  type Walk =
    | { status: "PRESENT"; last: Extract<Looked, { status: "PRESENT" }>; chain: PathStep[] }
    | { status: "ABSENT_PROVEN" | "MASKED" | "NOT_A_FOLDER"; segment: number; chain: PathStep[] }
    | { status: "UNKNOWN" | "INVALID"; segment: number; reason: Reason };
  const r = await onEndpoint<Walk>(
    efs._internal.pool,
    async (s) => {
      const chain: PathStep[] = [];
      let folder: ParentRef = from;
      for (let i = 0; i < names.length; i++) {
        const last = i === names.length - 1;
        const seen: { owner?: PrincipalId } = {};
        const step = await lookupAt(
          ctx,
          s,
          basis,
          principals,
          folder,
          names[i] as Uint8Array,
          last,
          true,
          seen,
        );
        if (!step.ok) return step;
        // The folder's creator came with the record that proves it is a folder: put it on this step's folder and
        // on the step that pointed here, so every folder on the way carries its owner.
        if (seen.owner !== undefined) {
          folder = { ...folder, owner: seen.owner };
          const prev = chain[i - 1];
          if (prev?.target.kind === "folder")
            chain[i - 1] = { ...prev, target: { ...prev.target, owner: seen.owner } };
        }
        const v = step.value;
        // The folder segment i-1 pointed at is not a files-directory/1 record: the path cannot continue there.
        // `from` itself is not a folder: the path never started.
        if (v.status === "NOT_A_FOLDER" && i === 0)
          return {
            ok: true,
            value: {
              status: "INVALID",
              segment: 0,
              reason: reason(
                "UNSUPPORTED_PROFILE",
                "never",
                "`from` is not a files-directory/1 folder",
              ),
            },
          };
        if (v.status === "NOT_A_FOLDER")
          return {
            ok: true,
            value: { status: "NOT_A_FOLDER", segment: i - 1, chain: chain.slice(0, i) },
          };
        if (v.status === "ABSENT_PROVEN" || v.status === "MASKED")
          return { ok: true, value: { status: v.status, segment: i, chain } };
        if (v.status !== "PRESENT")
          return { ok: true, value: { status: v.status, segment: i, reason: v.reason } };
        const target = v.selected.target;
        if (!target)
          return {
            ok: true,
            value: {
              status: "INVALID",
              segment: i,
              reason: reason(
                "UNSUPPORTED_PROFILE",
                "never",
                `segment ${i} has an entry of an unknown kind`,
              ),
            },
          };
        chain.push({ folder, name: segments[i] as string, author: v.selected.author, target });
        if (last) return { ok: true, value: { status: "PRESENT", last: v, chain } };
        if (target.kind !== "folder")
          return { ok: true, value: { status: "NOT_A_FOLDER", segment: i, chain } };
        folder = target;
      }
      throw new Error("unreachable: a path has at least one segment");
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) return { kind: "efs.path", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const v = r.value;
  if (v.status === "PRESENT") {
    const lastStep = v.chain[v.chain.length - 1] as PathStep;
    return {
      kind: "efs.path",
      status: "PRESENT",
      target: lastStep.target,
      entry: {
        kind: "efs.entry",
        entry: { folder: lastStep.folder, name: lastStep.name },
        ...v.last,
        basis,
        evidence,
      },
      chain: v.chain,
      basis,
      evidence,
    };
  }
  if ("chain" in v)
    return {
      kind: "efs.path",
      status: v.status,
      segment: v.segment,
      chain: v.chain,
      basis,
      evidence,
    };
  return {
    kind: "efs.path",
    status: v.status,
    segment: v.segment,
    reason: v.reason,
    basis,
    evidence,
  };
}

// ---- what an id is

export type ObjectOpen =
  /** A files-directory/1 record: a folder, with the principal that created it (the record's word 0). */
  | {
      kind: "efs.object";
      status: "FOLDER";
      folder: FolderRef & { owner: PrincipalId };
      basis: Basis;
      evidence: Evidence;
    }
  /**
   * A created subject: a file, with the principal that created it, and the file opened under the Lens (`open`: its
   * HEAD may still be ABSENT_PROVEN under this Lens, which is "no author in your Lens has a HEAD", not "no file").
   * `open` is read at this answer's basis, its HEAD in the same batch as the kind, with every openFile check. When
   * that read fails on every endpoint after a consistent endpoint read the kind (its own failure unreachable, a
   * JSON-RPC error or BASIS_STALE, never a reply that failed validation), the answer is still FILE, `open` UNKNOWN.
   */
  | {
      kind: "efs.object";
      status: "FILE";
      file: FileRef;
      creator: PrincipalId;
      open: OpenResult;
      basis: Basis;
      evidence: Evidence;
    }
  /** Neither a folder record nor a created subject: nothing has this id. */
  | { kind: "efs.object"; status: "ABSENT_PROVEN"; basis: Basis; evidence: Evidence }
  /**
   * INVALID: a record of another Type (a revision, say), or not a 32-byte id. UNKNOWN: the kind itself could not be
   * read (or endpoints disagreed on it): nothing decided.
   */
  | {
      kind: "efs.object";
      status: "UNKNOWN" | "INVALID";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

/**
 * What an object link's id is, from one batched read: a files-directory/1 record is a FOLDER; else a created
 * subject is a FILE (then opened under the Lens); else ABSENT_PROVEN. The kind is fixed by the id itself (a folder's
 * id is its record, which only its creator may publish), so the answer never changes after the fact.
 */
/** A session that notes whether any call it carried failed at the transport (unreachable or a JSON-RPC error). */
function watchCalls(s: Session): { session: Session; callFailed: () => boolean } {
  let failedCall = false;
  const note = (o: RpcOutcome) => {
    if (!o.ok) failedCall = true;
    return o;
  };
  return {
    session: {
      port: s.port,
      chainId: s.chainId,
      send: async (requests) => (await s.send(requests)).map(note),
      request: async (method, params) => note(await s.request(method, params)),
    },
    callFailed: () => failedCall,
  };
}

export async function openObject(efs: Efs, id: Hex, o: ReadOpts = {}): Promise<ObjectOpen> {
  const none: Evidence = { attempts: [], requests: 0 };
  if (!/^0x[0-9a-fA-F]{64}$/.test(id ?? ""))
    return {
      kind: "efs.object",
      status: "INVALID",
      reason: reason("UNSUPPORTED_PROFILE", "never", "an object id is 32 bytes of hex"),
      evidence: none,
    };
  const target = lower(id);
  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.object",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const dirType = lower(efs.deployment.typeIds["files-directory/1"] as Hex);
  const lens = o.lens ?? efs.lens.default;
  type Kind =
    | { kind: "folder"; owner: PrincipalId }
    | { kind: "file"; creator: PrincipalId; open: RevisionOpen }
    | { kind: "absent" }
    | { kind: "other"; typeId: Hex };
  // The file kind as a consistent endpoint read it, kept across failover: when every endpoint then fails the HEAD or
  // revision read, the answer is still FILE (routing needs the kind) with its open UNKNOWN. Endpoints that disagree on
  // the creator leave nothing kept, and the whole answer is UNKNOWN.
  let fileKind: { creator: PrincipalId } | "conflict" | null = null;
  const keepFile = (creator: PrincipalId) => {
    if (fileKind === null) fileKind = { creator };
    else if (fileKind !== "conflict" && fileKind.creator !== creator) fileKind = "conflict";
  };
  const r = await onEndpoint<Kind>(
    efs._internal.pool,
    async (s) => {
      // One round trip for the kind and, speculatively, the file's HEAD under the Lens: a file link then costs what
      // openFile does. The HEAD answer is read only when the kind is FILE, and discarded otherwise.
      ctx.requests += 3;
      const [rec, sub, head] = await callsAt(s, basis.blockHash, [
        recordsCall(efs, [target]),
        subjectInfoCall(efs, target),
        headCall(efs, lens, target),
      ]);
      if (!rec?.ok) return failed(rec);
      let statuses: readonly number[];
      let headers: readonly { typeId: Hex; length: number; word0: Hex }[];
      try {
        [statuses, headers] = decodeFunctionResult({
          abi: ledgerViewsAbi,
          functionName: "records",
          data: rec.result as Hex,
        }) as unknown as [number[], { typeId: Hex; length: number; word0: Hex }[]];
      } catch {
        return badReply("records");
      }
      const st = chainStatus(statuses[0] as number);
      const h = headers[0];
      if (st === "PRESENT" && h) {
        if (lower(h.typeId) === dirType && Number(h.length) === 64)
          return { ok: true, value: { kind: "folder", owner: lower(h.word0) as PrincipalId } };
        return { ok: true, value: { kind: "other", typeId: lower(h.typeId) } };
      }
      if (st !== "ABSENT_PROVEN") return badReply(`records (${st})`);
      const c = decodeCreator(sub);
      if (!c.ok) return c;
      if (!c.value) return { ok: true, value: { kind: "absent" } };
      const creator = c.value;
      // The kind is kept for the fallback only when this endpoint's open failed the way a healthy endpoint can
      // (unreachable, a JSON-RPC error, a different basis). An endpoint whose reply failed validation in this step is
      // not consistent, and its kind is dropped.
      const fail = (
        f: { ok: false; retryElsewhere: boolean; reason: Reason },
        transport: boolean,
      ) => {
        if (transport || f.reason.code === "BASIS_STALE") keepFile(creator);
        return f;
      };
      // A created subject: its file, opened from the batched HEAD at this basis on this endpoint (every openFile check,
      // the HEAD law included, runs in openSelected).
      const sel = decodeHead(head);
      if (!sel.ok) return fail(sel, !head?.ok);
      const watched = watchCalls(s);
      const open = await openSelected(ctx, watched.session, basis, target, sel.value);
      if (!open.ok) return fail(open, watched.callFailed());
      return { ok: true, value: { kind: "file", creator, open: open.value } };
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok) {
    const kept = fileKind as { creator: PrincipalId } | "conflict" | null;
    if (kept !== null && kept !== "conflict")
      return {
        kind: "efs.object",
        status: "FILE",
        file: { kind: "file", subject: target as SubjectId },
        creator: kept.creator,
        open: { kind: "efs.open", status: "UNKNOWN", reason: r.reason, basis, evidence },
        basis,
        evidence,
      };
    return { kind: "efs.object", status: "UNKNOWN", reason: r.reason, basis, evidence };
  }
  const v = r.value;
  if (v.kind === "folder")
    return {
      kind: "efs.object",
      status: "FOLDER",
      folder: { kind: "folder", directory: target as RecordId, owner: v.owner },
      basis,
      evidence,
    };
  if (v.kind === "absent") return { kind: "efs.object", status: "ABSENT_PROVEN", basis, evidence };
  if (v.kind === "other")
    return {
      kind: "efs.object",
      status: "INVALID",
      reason: reason(
        "UNSUPPORTED_PROFILE",
        "never",
        `a record of Type ${v.typeId}, not a file or a folder`,
      ),
      basis,
      evidence,
    };
  const file: FileRef = { kind: "file", subject: target as SubjectId };
  const open = openResult(v.open, basis, evidence);
  return { kind: "efs.object", status: "FILE", file, creator: v.creator, open, basis, evidence };
}

// ---- a path link: names below a folder named by its id

export interface OpenPathOpts extends Omit<ResolvePathOpts, "lens"> {
  /** Who is reading: first in the default Lens. Leave it out for a reader with no account. */
  reader?: Address | PrincipalId;
  /** What follows the reader and the folder's creator in the default Lens (default: the client's default Lens). */
  base?: Lens;
}

export type PathOpen =
  /** resolvePath's answer for the names, with the Lens they were resolved under. */
  | (PathResolution & { lens: Lens })
  /** The id could not be read, or is not a folder (a file included): no name was resolved, so no Lens. */
  | {
      kind: "efs.path";
      status: "INVALID" | "UNKNOWN";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    }
  /** Nothing has the link's id, neither a folder nor a file: openObject's own answer, at its basis. */
  | Extract<ObjectOpen, { status: "ABSENT_PROVEN" }>;

// ---- a home: an address as a folder parent

export type HomeOpen =
  | {
      kind: "efs.home";
      /** A home always exists (any address but zero): PRESENT with its owner, read at `basis`. */
      status: "PRESENT";
      home: HomeRef & { owner: PrincipalId };
      /** The default Lens to show it under: the reader, then the home's owner, then `base` (efs.lens.place). */
      lens: Lens;
      basis: Basis;
      evidence: Evidence;
    }
  | { kind: "efs.home"; status: "UNKNOWN"; reason: Reason; basis?: Basis; evidence: Evidence };

/**
 * Open a home (`/0x<address>`, a HomeLink with no names): the address's author identity at one block (the gateway's
 * Keys.principalFor: a key account's key principal, a contract's Realm contract principal), and the Lens to list it
 * under, the reader first, then that owner, then `base`. List it with listFolder(efs, home, { lens }).
 */
export async function openHome(
  efs: Efs,
  address: Address,
  o: CallOpts & { reader?: Address | PrincipalId; base?: Lens } = {},
): Promise<HomeOpen> {
  const home = checkParent({ kind: "home", address }) as HomeRef;
  const { reader, base, ...read } = o;
  const pin = await efs.at("latest", read);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.home",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  let requests = pin.evidence.requests;
  const r = await onEndpoint<PrincipalId>(
    efs._internal.pool,
    async (s) => {
      requests += 1;
      const [out] = await callsAt(s, basis.blockHash, [principalProbe(home.address)]);
      return decodePrincipal(efs, home.address, out);
    },
    read,
  );
  const evidence: Evidence = { attempts: [...pin.evidence.attempts, ...r.attempts], requests };
  if (!r.ok) return { kind: "efs.home", status: "UNKNOWN", reason: r.reason, basis, evidence };
  const lens = efs.lens.place({
    ...(reader !== undefined ? { reader } : {}),
    owner: r.value,
    ...(base ? { base } : {}),
  });
  return {
    kind: "efs.home",
    status: "PRESENT",
    home: { ...home, owner: r.value },
    lens,
    basis,
    evidence,
  };
}

/**
 * Open a path link: names below a folder named by its id (`~efs/o/<folder>/<name>/…`, a PathLink) or below a home
 * (`/0x<address>/<name>/…`, a HomeLink with names). For a folder, the id's kind first (openObject), then its names
 * (resolvePath); for a home, its owner (openHome), then its names. The Lens is the link's own when it carries one,
 * used as it is; else the reader, then the folder's creator or the home's owner, then `base` (efs.lens.place). Any id
 * that is not a folder, a file included, is INVALID: a file has no names below it, so the file itself is never what
 * the link opens. An id nothing has is openObject's ABSENT_PROVEN (`kind: "efs.object"`), never a missing name.
 * `evidence` covers both reads. Every answer for the names carries `lens`, the Lens they were resolved under, so the
 * entry opens the same way.
 */
export async function openPath(
  efs: Efs,
  link: PathLink | HomeLink,
  o: OpenPathOpts = {},
): Promise<PathOpen> {
  if (link.names.length === 0)
    throw misuse(
      link.kind === "home"
        ? "openPath: a home link with no names is the home itself: open it with openHome"
        : "openPath: a path link has at least one name (with none, open it with openObject)",
    );
  const { reader, base, ...read } = o;
  if (link.kind === "home" && link.lens) {
    // The link's own Lens: no owner to read. resolvePath checks the home itself at its first name.
    const lens = link.lens;
    const r = await resolvePath(
      efs,
      { from: { kind: "home", address: link.address }, segments: link.names },
      { ...read, lens },
    );
    return { ...r, lens };
  }
  if (link.kind === "home") {
    const h = await openHome(efs, link.address, o);
    if (h.status !== "PRESENT")
      return {
        kind: "efs.path",
        status: "UNKNOWN",
        reason: h.reason,
        ...(h.basis ? { basis: h.basis } : {}),
        evidence: h.evidence,
      };
    const lens = link.lens ?? h.lens;
    const r = await resolvePath(efs, { from: h.home, segments: link.names }, { ...read, lens });
    const evidence: Evidence = {
      attempts: [...h.evidence.attempts, ...r.evidence.attempts],
      requests: h.evidence.requests + r.evidence.requests,
    };
    return { ...r, lens, evidence };
  }
  const obj = await openObject(efs, link.folder, read);
  if (obj.status === "ABSENT_PROVEN") return obj;
  const at = obj.basis ? { basis: obj.basis } : {};
  if (obj.status === "UNKNOWN")
    return {
      kind: "efs.path",
      status: "UNKNOWN",
      reason: obj.reason,
      ...at,
      evidence: obj.evidence,
    };
  if (obj.status !== "FOLDER")
    return {
      kind: "efs.path",
      status: "INVALID",
      reason:
        obj.status === "FILE"
          ? reason(
              "UNSUPPORTED_PROFILE",
              "never",
              "the link's id is a file, and a file has no names below it",
            )
          : obj.reason,
      ...at,
      evidence: obj.evidence,
    };
  const lens =
    link.lens ??
    efs.lens.place({
      ...(reader !== undefined ? { reader } : {}),
      owner: obj.folder.owner,
      ...(base ? { base } : {}),
    });
  const r = await resolvePath(efs, { from: obj.folder, segments: link.names }, { ...read, lens });
  const evidence: Evidence = {
    attempts: [...obj.evidence.attempts, ...r.evidence.attempts],
    requests: obj.evidence.requests + r.evidence.requests,
  };
  return { ...r, lens, evidence };
}
