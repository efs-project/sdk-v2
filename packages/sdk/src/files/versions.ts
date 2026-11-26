// SPDX-License-Identifier: MIT
// Everyone's versions of a file (tag model spec §3.9; contracts 04526b1 item 49, the `head-authors` list). The index
// keeps, per file, one entry for each author's FIRST HEAD statement of either sign (creating it, saving one's own
// version of another's, or a first "not this"), in that order, with `count` (authors who ever made a HEAD statement)
// and `live` (authors whose HEAD is BOUND now). No reader enforces the list's rules, so this read does, at one block:
//   - the Lens decision, from the same LensReader walk openFile uses (a MASKED Lens head stops it: "hidden by");
//   - the Lens tier: each Lens author's own head, a kernel read, so it is exact whatever the list's coverage;
//   - the creator's row, after the Lens tier, when the creator (the subject's CREATE principal, never list position)
//     is not in the Lens;
//   - the public tier: the list read from its newest end, Lens authors and a creator shown apart skipped. It is a
//     public-tier list (anyone can add an entry with one HEAD statement), so it is UNKNOWN unless its coverage is
//     COMPLETE, and it is paged by absolute list position so appends never shift a page.
// An author who only ever said "not this" (targetKind 0) has an entry but no version: never listed. A version hidden
// or taken back is listed only with `includeRemoved`, and without a revision (its head shows target 0).
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { type CallRequest, callsAt } from "../chain/basis.js";
import { type Basis, onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { RpcOutcome } from "../chain/rpc.js";
import type { Efs, Lens } from "../client.js";
import { type CallOpts, misuse, type Reason, reason } from "../core/errors.js";
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
import { PURPOSES } from "../generated/constants.js";
import { GAS_READS } from "../generated/gas.js";
import { positionKey } from "../protocol/keys.js";
import { chainStatus, headState, strictlyIncreasing } from "../protocol/status.js";
import { type Ctx, decodeHead, type Evidence, type FileRef, headCall } from "./bytes.js";
import { decodeCreator, subjectInfoCall } from "./folders.js";

const callOf = (
  to: Hex,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): CallRequest => ({
  to: to as `0x${string}`,
  data: encodeFunctionData({ abi: abi as never, functionName, args } as never),
});
const badReply = (what: string): Step<never> => ({
  ok: false,
  retryElsewhere: true,
  reason: reason("RPC_ERROR", "transient", `${what} did not decode`),
});
/** A reply decoded, or the failure that moves the read to the next endpoint. */
function decoded<T>(
  abi: readonly unknown[],
  functionName: string,
  out: RpcOutcome | undefined,
): Step<T> {
  if (!out?.ok)
    return {
      ok: false,
      retryElsewhere: true,
      reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
    };
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

/** The most public-tier entries scanned in one call, and the default `limit` (the topic readers' row bound). */
export const MAX_VERSIONS_PAGE: number = GAS_READS.recommended.prague.maxRows;
const COMPLETE = 3; // Coverage.COMPLETE

export interface FileVersionsOpts extends CallOpts {
  /**
   * The Lens the file was opened under, the app's fallback Lens included ("you, then its creator, then that Lens"):
   * only then is `decision` what the file view shows. Default: the client's default Lens.
   */
  lens?: Lens;
  /** Continue the public tier from an earlier result's `public.next` (same file, Lens and includeRemoved). */
  cursor?: FileVersionsCursor;
  /** The most list entries scanned for the public tier in this call (1 to MAX_VERSIONS_PAGE; default the most). */
  limit?: number;
  /**
   * Also list authors who once had a version and hid it (MASKED) or took it back (RELEASED). Never an author who only
   * said "not this". The public tier then pages to the list's start (no early stop).
   */
  includeRemoved?: boolean;
}

/** One author's version. A hidden or removed one carries no revision: its head shows none. */
export type FileVersion =
  | { author: PrincipalId; state: "PRESENT"; revision: RecordId; creator: boolean }
  | { author: PrincipalId; state: "MASKED" | "RELEASED"; creator: boolean };
/** A Lens author's version, with their place in the Lens. */
export type LensVersion = FileVersion & { lensIndex: number };

/**
 * What the file shows under the Lens (LensReader.resolve, as openFile reads it): the first Lens author with a BOUND or
 * MASKED head decides; UNSET and RELEASED heads fall through. `hidden` is a Lens author's MASKED head: their own
 * version hidden, or a lone "not this", either way "hidden for you by" them. `none`: no Lens author decides. `unknown`:
 * a head could not be read; never shown as "none".
 */
export type VersionsDecision =
  | { kind: "version"; author: PrincipalId; revision: RecordId; lensIndex: number }
  | { kind: "hidden"; author: PrincipalId; lensIndex: number }
  | { kind: "none" }
  | { kind: "unknown"; reason: Reason };

/** Where the public tier carries on: an absolute list position and what the earlier pages saw. Opaque; plain data. */
export interface FileVersionsCursor {
  kind: "efs.fileVersionsCursor";
  file: SubjectId;
  /** The next call scans the entries before this list position, newest first. */
  before: number;
  /** Standing public versions returned by the earlier pages. */
  found: number;
  /** The list head the first page read: if it moved, `changed` is set and the scan carries on. */
  count: number;
  live: number;
  lens: string;
  includeRemoved: boolean;
}

/**
 * The public tier: everyone else, newest first author first (by first HEAD statement, never by latest edit).
 * UNKNOWN unless the index vouches for the list (coverage COMPLETE): then there is no count either, never "no other
 * versions". A page can be short or empty while `next` is set: only a missing `next` is the end.
 */
export type PublicVersions =
  | { status: "UNKNOWN"; reason: Reason }
  | {
      status: "PRESENT";
      rows: readonly FileVersion[];
      /** Standing public versions in all (everyone's standing versions less the Lens tier's and the creator row's). */
      total: number;
      /** Everyone's standing versions: the "N versions" a view shows. */
      live: number;
      /** Authors who ever made a HEAD statement on the file, of either sign. Never a count of versions. */
      count: number;
      /** List entries this call read. */
      scanned: number;
      /** The list moved since the first page: offer a refresh. */
      changed: boolean;
      next?: FileVersionsCursor;
    };

export type FileVersionsResult =
  | {
      kind: "efs.fileVersions";
      status: "PRESENT";
      file: SubjectId;
      decision: VersionsDecision;
      /** The Lens authors' versions, in Lens order (exact whatever the list's coverage). */
      lens: readonly LensVersion[];
      /** The creator's version when the creator is not in the Lens (shown after the Lens tier). */
      creator?: FileVersion;
      public: PublicVersions;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.fileVersions";
      status: "ABSENT_PROVEN";
      file: SubjectId;
      basis: Basis;
      evidence: Evidence;
    }
  | {
      kind: "efs.fileVersions";
      status: "UNKNOWN";
      reason: Reason;
      basis?: Basis;
      evidence: Evidence;
    };

type RawHead = { state: number; targetKind: number; target: Hex };

/** headsAt's status, as every headsAt read in the SDK accepts it (src/files/entries.ts): anything else is the endpoint's fault. */
const headsAtOk = (st: number): boolean => {
  const cs = chainStatus(st);
  return cs === "PRESENT" || cs === "MASKED" || cs === "ABSENT_PROVEN";
};

/** A head as a version, or null when it is none: UNSET, a lone no (never bound), or removed without includeRemoved. */
function versionOf(
  author: PrincipalId,
  h: RawHead,
  creator: PrincipalId | null,
  includeRemoved: boolean,
): FileVersion | null {
  const state = headState(h.state);
  const isCreator = author === creator;
  if (state === "BOUND")
    return { author, state: "PRESENT", revision: lower(h.target) as RecordId, creator: isCreator };
  if ((state === "MASKED" || state === "RELEASED") && Number(h.targetKind) !== 0 && includeRemoved)
    return { author, state, creator: isCreator };
  return null;
}

const lensKey = (ps: readonly PrincipalId[]): string => ps.join(",");

/**
 * Everyone's versions of a file under a Lens: the Lens decision, the Lens tier, the creator's row and a page of the
 * public tier, read at one block. "N versions" is `public.live`, never `count`. Pass the Lens the file was opened
 * under (FileVersionsOpts.lens). ABSENT_PROVEN when the subject was never created; UNKNOWN when the deployment is not
 * verified, every endpoint is behind, or the reads fail.
 */
export async function fileVersions(
  efs: Efs,
  file: FileRef,
  o: FileVersionsOpts = {},
): Promise<FileVersionsResult> {
  const subject = lower(file.subject) as SubjectId;
  const principals = uniquePrincipals((o.lens ?? efs.lens.default).principals).map(
    (p) => lower(p) as PrincipalId,
  );
  if (principals.length === 0) throw misuse("a Lens names at least one principal");
  const limit = o.limit ?? MAX_VERSIONS_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERSIONS_PAGE)
    throw misuse(`limit must be 1 to ${MAX_VERSIONS_PAGE}`);
  const includeRemoved = o.includeRemoved === true;
  const c = o.cursor;
  if (
    c &&
    (c.kind !== "efs.fileVersionsCursor" ||
      lower(c.file) !== subject ||
      c.lens !== lensKey(principals) ||
      c.includeRemoved !== includeRemoved ||
      ![c.before, c.found, c.count, c.live].every((n) => Number.isInteger(n) && n >= 0))
  )
    throw misuse("this cursor is for another file, Lens or includeRemoved setting");

  const pin = await efs.at("latest", o);
  const ctx: Ctx = { efs, requests: pin.evidence.requests };
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.fileVersions",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
      evidence: pin.evidence,
    };
  const basis = pin.basis;
  const d = efs.deployment;
  const position = positionKey(PURPOSES.head, subject, ZERO_WORD);
  const family = d.index.headAuthorsFamily;
  const indexAddr = d.index.address;

  type Read =
    | { absent: true }
    | {
        absent: false;
        decision: VersionsDecision;
        lens: LensVersion[];
        creator?: FileVersion;
        public: PublicVersions;
      };
  const r = await onEndpoint<Read>(
    efs._internal.pool,
    async (s: Session) => {
      const at = basis.blockHash;
      // 1. The subject's creator, the Lens walk, each Lens author's head; and the live index and the list's head.
      const calls1: CallRequest[] = [
        subjectInfoCall(efs, subject),
        headCall(efs, { principals }, subject),
        callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [d.ledger, principals, position]),
        ...(family && indexAddr
          ? [
              callOf(d.ledger, ledgerAbi, "index", []),
              callOf(indexAddr, indexAbi, "postingHeadOf", [family, ZERO_WORD, 0, position]),
            ]
          : []),
      ];
      ctx.requests += calls1.length;
      const out1 = await callsAt(s, at, calls1);
      const cr = decodeCreator(out1[0]);
      if (!cr.ok) return cr;
      if (cr.value === null) return { ok: true, value: { absent: true } };
      const creator = cr.value;
      const sel = decodeHead(out1[1], { principals });
      if (!sel.ok) return sel;
      const lensHeads = decoded<[number, unknown, number, readonly RawHead[]]>(
        ledgerViewsAbi,
        "headsAt",
        out1[2],
      );
      if (!lensHeads.ok) return lensHeads;
      if (!headsAtOk(lensHeads.value[0]))
        return badReply(`headsAt (the Lens heads read ${chainStatus(lensHeads.value[0])})`);
      if (lensHeads.value[3].length !== principals.length)
        return badReply("headsAt (one head per Lens author)");
      const heads = lensHeads.value[3];

      const lens: LensVersion[] = [];
      for (const [i, p] of principals.entries()) {
        const v = versionOf(p, heads[i] as RawHead, creator, includeRemoved);
        if (v) lens.push({ ...v, lensIndex: i });
      }
      const h = sel.value;
      // The deciding author must be one of the Lens's principals: a reply naming anyone else is the endpoint's fault,
      // so the read moves to the next endpoint.
      const lensAt =
        h.status === "PRESENT" || (h.status === "MASKED" && h.author)
          ? principals.indexOf(h.author as PrincipalId)
          : -1;
      if ((h.status === "PRESENT" || h.status === "MASKED") && lensAt < 0)
        return badReply("LensReader.resolve (a decision by an author outside the Lens)");
      const decision: VersionsDecision =
        h.status === "PRESENT"
          ? {
              kind: "version",
              author: h.author,
              revision: lower(h.target) as RecordId,
              lensIndex: lensAt,
            }
          : h.status === "MASKED"
            ? { kind: "hidden", author: h.author as PrincipalId, lensIndex: lensAt }
            : h.status === "ABSENT_PROVEN"
              ? { kind: "none" }
              : {
                  kind: "unknown",
                  reason:
                    ("reason" in h ? h.reason : undefined) ??
                    reason("NOT_YET_DECIDABLE", "transient", `the Lens walk reads ${h.status}`),
                };

      // 2. The creator's head, when the creator is not in the Lens.
      const creatorApart = !principals.includes(creator);
      let creatorRow: FileVersion | undefined;
      let creatorBound = false;
      if (creatorApart) {
        ctx.requests += 1;
        const [out] = await callsAt(s, at, [
          callOf(d.readers.ledgerViews, ledgerViewsAbi, "headsAt", [d.ledger, [creator], position]),
        ]);
        const ch = decoded<[number, unknown, number, readonly RawHead[]]>(
          ledgerViewsAbi,
          "headsAt",
          out,
        );
        if (!ch.ok) return ch;
        if (!headsAtOk(ch.value[0]))
          return badReply(`headsAt (the creator's head reads ${chainStatus(ch.value[0])})`);
        const head = ch.value[3][0];
        if (!head || ch.value[3].length !== 1) return badReply("headsAt (the creator's head)");
        creatorRow = versionOf(creator, head, creator, includeRemoved) ?? undefined;
        creatorBound = headState(head.state) === "BOUND";
      }

      // 3. The public tier.
      const unknown = (why: Reason): PublicVersions => ({ status: "UNKNOWN", reason: why });
      const done = (pub: PublicVersions): Step<Read> => ({
        ok: true,
        value: {
          absent: false,
          decision,
          lens,
          ...(creatorRow ? { creator: creatorRow } : {}),
          public: pub,
        },
      });
      if (!family || !indexAddr)
        return done(
          unknown(
            reason("UNSUPPORTED_PROFILE", "never", "the deployment keeps no head-authors list"),
          ),
        );
      const ix = decoded<Hex>(ledgerAbi, "index", out1[3]);
      if (!ix.ok) return ix;
      if (lower(ix.value) !== indexAddr)
        return done(
          unknown(
            reason(
              "UNSUPPORTED_PROFILE",
              "never",
              "the live index is not the one the deployment names",
            ),
          ),
        );
      const lh = decoded<[number, bigint, bigint, bigint, boolean]>(
        indexAbi,
        "postingHeadOf",
        out1[4],
      );
      if (!lh.ok) return lh;
      const [coverage, countRaw, liveRaw] = lh.value;
      if (Number(coverage) !== COMPLETE)
        return done(
          unknown(
            reason(
              "NOT_YET_DECIDABLE",
              "transient",
              `the index does not vouch for this file's head-authors list (coverage ${coverage})`,
            ),
          ),
        );
      const count = Number(countRaw);
      const live = Number(liveRaw);
      const shownApart = new Set<string>([...principals, ...(creatorApart ? [creator] : [])]);
      const standingApart =
        heads.filter((x) => headState(x.state) === "BOUND").length + (creatorBound ? 1 : 0);
      const total = Math.max(0, live - standingApart);
      const changed = c !== undefined && (c.count !== count || c.live !== live);
      const start = Math.min(c ? c.before : count, count);
      let found = c ? c.found : 0;
      const n = Math.min(limit, start);
      const from = start - n;
      const rows: FileVersion[] = [];
      if (n > 0) {
        ctx.requests += 1;
        const [sl] = await callsAt(s, at, [
          callOf(indexAddr, indexAbi, "postingSliceOf", [family, ZERO_WORD, 0, position, from, n]),
        ]);
        const slice = decoded<[number, readonly bigint[], boolean]>(indexAbi, "postingSliceOf", sl);
        if (!slice.ok) return slice;
        if (Number(slice.value[0]) !== COMPLETE)
          return done(
            unknown(reason("NOT_YET_DECIDABLE", "transient", "the list's slice is not COMPLETE")),
          );
        const admissions = slice.value[1];
        if (admissions.length !== n) return badReply("postingSliceOf (length)");
        if (!strictlyIncreasing(admissions))
          return badReply("postingSliceOf (entries out of order)");
        ctx.requests += 1;
        const [ah] = await callsAt(s, at, [
          callOf(d.readers.ledgerViews, ledgerViewsAbi, "authorHeads", [
            d.ledger,
            position,
            admissions,
          ]),
        ]);
        const got = decoded<[readonly number[], readonly Hex[], readonly RawHead[]]>(
          ledgerViewsAbi,
          "authorHeads",
          ah,
        );
        if (!got.ok) return got;
        const [st, authors, hs] = got.value;
        if (st.length !== n || authors.length !== n || hs.length !== n)
          return badReply("authorHeads (one row per entry)");
        // newest first
        for (let k = n - 1; k >= 0; k--) {
          const cs = chainStatus(st[k] as number);
          if (cs !== "PRESENT" && cs !== "MASKED" && cs !== "RELEASED")
            return badReply(`authorHeads (a listed entry reads ${cs})`);
          const author = lower(authors[k] as Hex) as PrincipalId;
          if (shownApart.has(author)) continue;
          const v = versionOf(author, hs[k] as RawHead, creator, includeRemoved);
          if (!v) continue;
          rows.push(v);
          if (v.state === "PRESENT") found++;
        }
      }
      // The early stop: every standing public version found, the list unmoved, removed rows not asked for.
      const allFound = !includeRemoved && !changed && found >= total;
      const next: FileVersionsCursor | undefined =
        from > 0 && !allFound
          ? {
              kind: "efs.fileVersionsCursor",
              file: subject,
              before: from,
              found,
              count: c ? c.count : count,
              live: c ? c.live : live,
              lens: lensKey(principals),
              includeRemoved,
            }
          : undefined;
      return done({
        status: "PRESENT",
        rows,
        total,
        live,
        count,
        scanned: n,
        changed,
        ...(next ? { next } : {}),
      });
    },
    o,
  );
  const evidence: Evidence = {
    attempts: [...pin.evidence.attempts, ...r.attempts],
    requests: ctx.requests,
  };
  if (!r.ok)
    return { kind: "efs.fileVersions", status: "UNKNOWN", reason: r.reason, basis, evidence };
  if (r.value.absent)
    return { kind: "efs.fileVersions", status: "ABSENT_PROVEN", file: subject, basis, evidence };
  const v = r.value;
  return {
    kind: "efs.fileVersions",
    status: "PRESENT",
    file: subject,
    decision: v.decision,
    lens: v.lens,
    ...(v.creator ? { creator: v.creator } : {}),
    public: v.public,
    basis,
    evidence,
  };
}
