// SPDX-License-Identifier: MIT
// Shareable links to EFS objects, as one fragment-safe string an app puts in its route after the realm, as in
// `#/r/<realm>/<link>` (tag model spec §5):
//
//   ~efs/o/<id>[?lens=<p>,<p>…]        an object link: a subject id (stable across renames). It opens the current
//                                      head under a Lens: the route's default, or the ordered principals given
//   ~efs/o/<folder>/<name>/…[?lens=…]  a path link: folder and file names below a folder named by its id, which
//                                      keep their case (files-name/3). Any folder can start one, the shared root
//                                      included. The string can't say that the id is a folder: the reader checks
//   ~efs/v/<record>                    a revision link: one immutable revision record (exact bytes; no Lens)
//   0x<40 hex>[/<name>/…]              a home (an address; 0X and hex of either case read too, as the gateway does),
//                                      then folder and file names, which keep their case
//                                      (files-name/3): a lookup, which a rename or a move can break
//   <word>[/<word>/…]                  a topic, a path of words; one word alone is that word's page. Words are
//                                      folded before lookup: the fold is the caller's (`ParseLinkOpts.fold`), so
//                                      the grammar works before the fold rule is chosen
//
// Every first segment starting with `~` is reserved for the system; only `~efs` is defined (the shared root has no
// named link such as `~root`, and `~home` is never defined: a home is its address). A leading "/" and one
// trailing "/" are ignored; an empty segment is refused. Segments are split first and decoded once each
// (percent-decoding before folding), so an escaped `%2F` is never a separator. Topic and home segments are written
// in the canonical wire form (RFC 3986 percent-encoding, uppercase %HH).
//
// A Lens principal is written as its 20-byte address when it is a key principal (an account), else as its 32-byte
// principal id. Names (such as ENS) in a Lens are not supported in 0.1.
//
// Ids are 0x + 64 lowercase hex. `~efs` is a prefix the name profile reserves, so no name can look like an object
// link, and the word rules refuse `~` anywhere and the address shape, so no topic can look like one either. A first
// segment that starts `0x` and is not 0x/0X and 40 hex digits is a word (`0xsplits`), as on the chain.
import type { Lens } from "../client.js";
import { EfsFault, misuse } from "../core/errors.js";
import type { Address, PrincipalId, RecordId, SubjectId } from "../core/hex.js";
import { utf8Encode } from "../core/platform.js";
import { TOPICS } from "../generated/constants.js";
import { foldWord } from "./fold.js";
import { checkName, decodeScalars, NAME_PROFILE, type NameRule } from "./name.js";
import { parseSegment, wireSegment } from "./segment.js";
import { checkWord } from "./word.js";

/** An object by subject id. Files open from it today; folders will reuse the same form. */
export interface ObjectLink {
  kind: "object";
  subject: SubjectId;
  /** The sharer's Lens, when it differs from the route's default. Pass it to reads as `{ lens }`. */
  lens?: Lens;
}
/** One exact revision. */
export interface RevisionLink {
  kind: "revision";
  recordId: RecordId;
}
/**
 * A topic: a path of words. `segments` are the decoded segments as typed. `words` are the folded words (the topic's
 * identity), present when the link was parsed with a fold or built from folded words.
 */
export interface TopicLink {
  kind: "topic";
  segments: readonly string[];
  words?: readonly string[];
  /** The sharer's Lens (`?lens=`), when it differs from the route's default. */
  lens?: Lens;
}
/** A home (an address, lowercase), then folder and file names below it, which keep their case. */
export interface HomeLink {
  kind: "home";
  address: Address;
  names: readonly string[];
  /**
   * The sharer's Lens (`?lens=`). Without one, a home opens under the reader, then the address's author identity
   * (openHome / openPath in `@efs/sdk/files`, the gateway's Keys.principalFor: the address itself for a key account).
   */
  lens?: Lens;
}
/**
 * A path from a folder named by its id (`~efs/o/<folder>/<name>/…`): that folder's object link, then at least one
 * folder or file name, which keep their case (files-name/3). Any folder can start one, the shared root included (it
 * has no named link of its own). It is its own kind, never an object link with names, so a router that only opens
 * objects can't open the folder in place of the entry the link names.
 *
 * The string can't say whether the id is a folder, so the reader decides: open it with `openPath` (`@efs/sdk/files`),
 * which reads the id's kind, then the names under `lens`, or else under the reader then the folder's creator. Any id
 * that is not a folder, a file included, makes the link INVALID: a file has no names below it.
 */
export interface PathLink {
  kind: "path";
  /** The id the link names, as a folder's record id. Unchecked until a reader opens it. */
  folder: RecordId;
  names: readonly string[];
  /** The sharer's Lens (`?lens=`), when it differs from the default above. */
  lens?: Lens;
}
/** One fold step, supplied by the caller until the fold rule is chosen: a word, or the rule the segment breaks. */
export type FoldStep = (
  segment: string,
) => { ok: true; word: string } | { ok: false; rule: string };
export interface ParseLinkOpts {
  /**
   * Fold each topic segment to its word. Default: foldWord (interim until the rule is ruled), so a typed `Cars/Tesla`
   * opens `cars/tesla` and `canonical` is the folded link. `null`: no fold, `segments` only and no `words`.
   */
  fold?: FoldStep | null;
}

/**
 * What `link` accepts: an object, path, revision, topic or home link, or a FileRef / RevisionRef from
 * `@efs/sdk/files`.
 */
export type LinkTarget =
  | ObjectLink
  | PathLink
  | RevisionLink
  | TopicLink
  | HomeLink
  | { kind: "file"; subject: SubjectId }
  | { kind: "revision"; recordId: RecordId; file?: SubjectId };

export type LinkParse =
  /**
   * `canonical` is the link in canonical form; routers can redirect to it when it differs from the input. A topic
   * parsed without a fold has no `words`, and its `canonical` keeps the typed form: redirect only once it is folded.
   */
  | {
      status: "OK";
      target: ObjectLink | PathLink | RevisionLink | TopicLink | HomeLink;
      canonical: string;
    }
  /**
   * A topic segment the word rules refuse, or the caller's fold refused. `segment` (0-based) is the segment; `word` is
   * its text as the link spelled it, percent-decoded and not folded, so a page can name it ("… doesn't accept:
   * Straße"). It may hold the very characters that broke the rule (a control or bidi character, a slash): show it
   * escaped or isolated, never as markup. `detail` is a closed union (WordDetail), so a client's message map can be
   * keyed on it and a rename is a type error. `code` is the chain's own refusal code (checkWord, TopicProfile: 1
   * length, 2 malformed UTF-8, 3 an ASCII byte outside a–z 0–9 - _ ., 4 ends with `.`, 6 address-shaped, 7 a refused
   * character, 9 starts with `-`; 5 is unused since the list release) whenever the word grammar refused it; absent,
   * with `detail` "fold-refused" and the fold's own `foldRule`, when the caller's fold refused it (foldWord never does).
   */
  | {
      status: "INVALID";
      rule: "bad-word";
      segment: number;
      word: string;
      detail: WordDetail;
      code?: number;
      foldRule?: string;
    }
  /** A home's or path link's folder or file name breaks files-name/3: `detail` is the name rule. */
  | {
      status: "INVALID";
      rule: "bad-name";
      segment: number;
      detail: NameRule | "UNSUPPORTED_BY_PROFILE";
      word?: undefined;
      code?: undefined;
    }
  /** `segment` (0-based) is the segment that breaks `rule`, where one does. */
  | {
      status: "INVALID";
      rule: PlainRule;
      segment?: number;
      detail?: undefined;
      word?: undefined;
      code?: undefined;
    };

/**
 * Why a topic segment is refused (LinkParse `detail` for `bad-word`): the chain's word rules (each with its `code`)
 * and the link grammar's own fold-independent ones, or "fold-refused" when the caller's fold refused the segment.
 */
export type WordDetail =
  | "length"
  | "malformed-utf8"
  | "slash"
  | "control"
  | "forbidden-ascii"
  | "unfolded"
  | "trailing-dot"
  | "leading-dash"
  | "address-shaped"
  | "refused-character"
  | "fold-refused";
/** Every WordDetail once: a Record over the union, so a member missing here or extra is a type error. */
const WORD_DETAIL_SET: Readonly<Record<WordDetail, true>> = {
  length: true,
  "malformed-utf8": true,
  slash: true,
  control: true,
  "forbidden-ascii": true,
  unfolded: true,
  "trailing-dot": true,
  "leading-dash": true,
  "address-shaped": true,
  "refused-character": true,
  "fold-refused": true,
};
/** Every WordDetail, for a client that wants to check its message map at runtime too. */
export const WORD_DETAILS: readonly WordDetail[] = Object.keys(WORD_DETAIL_SET) as WordDetail[];

export type LinkRule =
  | "empty"
  | "fragment"
  | "bad-escape"
  | "reserved-name"
  | "unknown-link-kind"
  | "bad-id"
  | "unsupported-parameter"
  | "bad-lens"
  | "lens-name-unsupported"
  /** An empty segment (`a//b`); one trailing "/" is ignored. */
  | "empty-segment"
  /** A home's folder or file name breaks files-name/3 (`detail` is the name rule). */
  | "bad-name"
  /** A topic segment breaks a word rule, or the caller's fold refused it (`detail` says which). */
  | "bad-word";

/** The first segment of every system link (`~efs`); the name profile reserves it, so no path can look like a link. */
export const LINK_PREFIX = "~efs";
const ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A link's first segment that names a home: `0x` or `0X` and 40 hex digits of either case, as the gateway reads it. */
const HOME_SEGMENT = /^0[xX][0-9a-fA-F]{40}$/;
/** The most principals a link's Lens may name (the deployment may allow fewer; reads enforce its limit). */
export const MAX_LINK_LENS = 64;
const KEY_PREFIX = `0x${"0".repeat(24)}`;

const lensEntry = (p: PrincipalId): string => {
  const x = p.toLowerCase();
  return x.startsWith(KEY_PREFIX) ? `0x${x.slice(KEY_PREFIX.length)}` : x;
};

/** The link string for an object or revision. Throws MISUSE for an id that is not 32-byte hex, or a bad Lens. */
export function link(target: LinkTarget): string {
  if (target.kind === "topic") {
    if (!target.words || target.words.length === 0)
      throw misuse("link: a topic link is built from its folded words");
    const path = target.words
      .map((w, i) => {
        const r = wordRule(w, false);
        if (r) throw misuse(`link: topic word ${i} breaks a word rule (${r})`, { segment: i });
        return wireSegment(utf8Encode(w));
      })
      .join("/");
    return path + lensQuery(target.lens);
  }
  if (target.kind === "home") {
    if (!ADDRESS.test(target.address)) throw misuse("link: a home is a 20-byte address");
    const names = wireNames(target.names, "home");
    return [target.address.toLowerCase(), ...names].join("/") + lensQuery(target.lens);
  }
  const id =
    target.kind === "revision"
      ? target.recordId
      : target.kind === "path"
        ? target.folder
        : target.subject;
  if (typeof id !== "string" || !ID.test(id))
    throw misuse("link: the id must be 0x followed by 64 hex digits", { kind: target.kind });
  if (target.kind === "revision") return `${LINK_PREFIX}/v/${id.toLowerCase()}`;
  if (target.kind === "path") {
    if (target.names.length === 0)
      throw misuse("link: a path link has at least one name (with none, it is an object link)");
    const names = wireNames(target.names, "path");
    return [`${LINK_PREFIX}/o/${id.toLowerCase()}`, ...names].join("/") + lensQuery(target.lens);
  }
  const base = `${LINK_PREFIX}/o/${id.toLowerCase()}`;
  return base + lensQuery(target.kind === "object" ? target.lens : undefined);
}

/** Folder and file names in the canonical wire form, or MISUSE for one that is not a files-name/3 name. */
function wireNames(names: readonly string[], what: "home" | "path"): string[] {
  return names.map((n, i) => {
    const c = checkName(n);
    if (c.status !== "VALID")
      throw misuse(`link: ${what} name ${i} is not a ${NAME_PROFILE} name`, { segment: i });
    return wireSegment(c.bytes);
  });
}

/** `?lens=<p>,<p>…` for a Lens, or "" for none: 1 to 64 principals, each once. */
function lensQuery(lens: Lens | undefined): string {
  if (!lens) return "";
  const ps = lens.principals;
  if (ps.length === 0 || ps.length > MAX_LINK_LENS || ps.some((p) => !ID.test(p)))
    throw misuse(`link: a Lens holds 1 to ${MAX_LINK_LENS} principal ids (0x + 64 hex)`);
  const entries = ps.map(lensEntry);
  if (new Set(entries).size !== entries.length)
    throw misuse("link: a Lens names each principal once");
  return `?lens=${entries.join(",")}`;
}

/** The query of a link: nothing, or exactly one `lens=` parameter (the only one defined). */
/** A refusal that names no segment detail: every LinkRule but the bad-word and bad-name refusals. */
type PlainRule = Exclude<LinkRule, "bad-word" | "bad-name">;

function queryLens(query: string | undefined): Lens | undefined | PlainRule {
  if (query === undefined) return undefined;
  const m = /^lens=([^&]*)$/.exec(query);
  if (!m) return "unsupported-parameter";
  const value = decodeOnce(m[1] as string);
  if (value === null) return "bad-escape";
  return parseLens(value);
}

/** Parse a `lens=` value into principal ids, or the rule it breaks. */
function parseLens(value: string): Lens | PlainRule {
  const entries = value.split(",");
  if (entries.length > MAX_LINK_LENS || entries.some((e) => e === "")) return "bad-lens";
  const principals: PrincipalId[] = [];
  for (const e of entries) {
    if (ADDRESS.test(e)) principals.push(`${KEY_PREFIX}${e.slice(2).toLowerCase()}` as PrincipalId);
    else if (ID.test(e)) principals.push(e.toLowerCase() as PrincipalId);
    else if (!/^0x[0-9a-fA-F]*$/.test(e)) return "lens-name-unsupported";
    else return "bad-lens";
  }
  if (new Set(principals).size !== principals.length) return "bad-lens";
  return { principals };
}

/** Decode %HH escapes once. Null when an escape is malformed. */
function decodeOnce(s: string): string | null {
  if (!s.includes("%")) return s;
  if (/%(?![0-9a-fA-F]{2})/.test(s)) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // escapes that are not UTF-8
  }
}

/**
 * Parse a link string from a route. A leading "/" is ignored. Splitting happens before decoding (one decode per
 * segment, as for paths), so an escaped `%2F` is never a separator.
 */
export function parseLink(input: string, o: ParseLinkOpts = {}): LinkParse {
  const raw = input.startsWith("/") ? input.slice(1) : input;
  if (raw === "") return { status: "INVALID", rule: "empty" };
  if (raw.includes("#")) return { status: "INVALID", rule: "fragment" };
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const wire = path.split("/");
  if (wire.length > 1 && wire[wire.length - 1] === "") wire.pop(); // one trailing "/" is ignored
  if (wire.some((x) => x === "")) return { status: "INVALID", rule: "empty-segment" };
  // Route on the decoded first segment, so `%7Eefs` is the system's too.
  const head = parseSegment(wire[0] as string);
  const headText = head.ok ? (decodeScalars(head.bytes)?.text ?? "") : "";
  const query = q >= 0 ? raw.slice(q + 1) : undefined;
  if (!headText.startsWith("~")) return parsePlace(wire, query, o);
  // `~efs/<kind>/<id>`; after an object id, names may follow (a path link).
  const sys = wire.slice(0, 3).map(decodeOnce);
  if (sys.some((x) => x === null)) return { status: "INVALID", rule: "bad-escape" };
  const [first = "", kind, id] = sys as string[];
  if (first !== LINK_PREFIX) return { status: "INVALID", rule: "reserved-name" }; // every `~` segment is the system's
  if (kind !== "o" && kind !== "v") return { status: "INVALID", rule: "unknown-link-kind" };
  if (id === undefined || !ID.test(id)) return { status: "INVALID", rule: "bad-id" };
  const rest = wire.slice(3);
  if (kind === "v") {
    if (rest.length > 0) return { status: "INVALID", rule: "bad-id" }; // names follow only an object link
    if (q >= 0) return { status: "INVALID", rule: "unsupported-parameter" }; // a revision needs no Lens
    const target: RevisionLink = { kind: "revision", recordId: id.toLowerCase() as RecordId };
    return { status: "OK", target, canonical: link(target) };
  }
  const lens = queryLens(query);
  if (typeof lens === "string") return { status: "INVALID", rule: lens };
  if (rest.length === 0) {
    const target: ObjectLink = { kind: "object", subject: id.toLowerCase() as SubjectId };
    if (lens) target.lens = lens;
    return { status: "OK", target, canonical: link(target) };
  }
  const decoded = decodeSegments(rest, 3);
  if (!Array.isArray(decoded)) return decoded;
  const names = checkNames(decoded, 3);
  if (!Array.isArray(names)) return names;
  const target: PathLink = {
    kind: "path",
    folder: id.toLowerCase() as RecordId,
    names,
    ...(lens ? { lens } : {}),
  };
  return { status: "OK", target, canonical: link(target) };
}

/** Each wire segment decoded once to text (`at`: the first one's index in the link, for `segment`). */
function decodeSegments(wire: readonly string[], at: number): string[] | LinkParse {
  const out: string[] = [];
  for (const [j, w] of wire.entries()) {
    const p = parseSegment(w);
    if (!p.ok) return { status: "INVALID", rule: "bad-escape", segment: at + j };
    out.push(decodeScalars(p.bytes)?.text ?? "");
  }
  return out;
}

/** Folder and file names (files-name/3, case kept), or the first that breaks a name rule (`at` as above). */
function checkNames(decoded: readonly string[], at: number): string[] | LinkParse {
  const names: string[] = [];
  for (const [j, n] of decoded.entries()) {
    const c = checkName(n);
    if (c.status !== "VALID")
      return {
        status: "INVALID",
        rule: "bad-name",
        segment: at + j,
        detail: c.status === "INVALID" ? (c.rule as NameRule) : c.status,
      };
    names.push(c.text);
  }
  return names;
}

const ADDRESS_SHAPE = /^0x[0-9a-f]{40}$/i;

/** The link grammar's own fold-independent word rules (wordRule). */
type OwnRule = Exclude<WordDetail, "malformed-utf8" | "refused-character" | "fold-refused">;
/** The chain's code (checkWord) for each of the link grammar's own word rules, and a name for the codes it lacks. */
const RULE_CODE: Readonly<Record<OwnRule, number>> = {
  length: 1,
  slash: 3,
  control: 3,
  "forbidden-ascii": 3,
  unfolded: 3,
  "trailing-dot": 4,
  "leading-dash": 9,
  "address-shaped": 6,
};
// The chain's word codes (topic-word/1, contracts 04526b1 item 53); 5 is unused since the list release. Only 2 and 7
// can reach this table today (wordRule refuses the others first, typed or folded); every code is named anyway, and an
// unnamed one is an INVARIANT fault, never a raw code in `detail`.
/** @internal The detail for each of the chain's word codes (exported for the test that every code has one). */
export const CODE_NAME: Readonly<Record<number, WordDetail>> = {
  1: "length",
  2: "malformed-utf8",
  3: "forbidden-ascii",
  4: "trailing-dot",
  6: "address-shaped",
  7: "refused-character",
  9: "leading-dash",
};

/** Printable ASCII a word may hold, typed: a word's own (TOPICS.wordAscii), and A–Z and a space, which a fold changes. */
const TYPED_ASCII = new Set<string>([...TOPICS.wordAscii, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ "]);

/**
 * The fold-independent word rules (the chain's, on every word of a topic path), in the chain's order: 1–255 bytes;
 * then, scanning from the start, no `/`, no ASCII control and no other ASCII but a–z, 0–9, `-`, `_` and `.` (`~` and
 * every other punctuation character included: no fold changes them); then not ending with `.`, not starting with
 * `-`, not address-shaped. `typed` also allows what a fold changes (A–Z, a space). What a fold produced must also
 * pass the chain's whole grammar (checkWord), which these rules are a part of.
 */
function wordRule(w: string, typed: boolean): OwnRule | null {
  const n = utf8Encode(w).length;
  if (n === 0 || n > 255) return "length";
  for (const ch of w) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x80) continue;
    if (ch === "/") return "slash";
    if (c < 0x20 || c === 0x7f) return "control";
    if (!TYPED_ASCII.has(ch)) return "forbidden-ascii";
    if (!typed && (ch === " " || (c >= 0x41 && c <= 0x5a))) return "unfolded";
  }
  if (w.endsWith(".")) return "trailing-dot";
  if (w.startsWith("-")) return "leading-dash";
  if (ADDRESS_SHAPE.test(w)) return "address-shaped";
  return null;
}

/** A home path (first segment an address) or a topic path (anything else not starting with `~`). */
function parsePlace(wire: string[], query: string | undefined, o: ParseLinkOpts): LinkParse {
  const lens = queryLens(query); // the same single `lens=` parameter as object links
  if (typeof lens === "string") return { status: "INVALID", rule: lens };
  const decoded = decodeSegments(wire, 0);
  if (!Array.isArray(decoded)) return decoded;
  const first = decoded[0] as string;
  if (HOME_SEGMENT.test(first)) {
    const names = checkNames(decoded.slice(1), 1);
    if (!Array.isArray(names)) return names;
    const target: HomeLink = {
      kind: "home",
      address: first.toLowerCase() as Address, // 0X… becomes 0x…
      names,
      ...(lens ? { lens } : {}),
    };
    return { status: "OK", target, canonical: link(target) };
  }
  const step = o.fold === null ? undefined : (o.fold ?? foldWord);
  const words: string[] = [];
  const bad = (i: number, seg: string, detail: WordDetail, code?: number): LinkParse => ({
    status: "INVALID",
    rule: "bad-word",
    segment: i,
    detail,
    word: seg,
    ...(code !== undefined ? { code } : {}),
  });
  for (const [i, seg] of decoded.entries()) {
    const typed = wordRule(seg, true);
    if (typed) return bad(i, seg, typed, RULE_CODE[typed]);
    // Grammar only (fold: null): the typed text is not a word yet, and what the chain refuses in it depends on the
    // fold (one may remove a bidi control or a joiner), so only the fold-independent rules apply; every read and
    // planner folds and checks the word in full before it becomes an id.
    if (!step) continue;
    const f = step(seg);
    if (!f.ok) return { ...(bad(i, seg, "fold-refused") as object), foldRule: f.rule } as LinkParse;
    // What the fold produced is a word: the link grammar's names first, then the chain's whole grammar, so a link
    // never names a word the chain can't hold (a bidi override, a joiner, a backslash, a no-break space…).
    const after = wordRule(f.word, false);
    if (after) return bad(i, seg, after, RULE_CODE[after]);
    const chain = checkWord(f.word);
    if (!chain.ok) {
      const detail = CODE_NAME[chain.code];
      // checkWord returns only the chain's codes, each named here (test/link-vectors.test.ts): never a raw code
      if (!detail) throw new EfsFault("INVARIANT", `link: word code ${chain.code} has no detail`);
      return bad(i, seg, detail, chain.code);
    }
    words.push(f.word);
  }
  const target: TopicLink = {
    kind: "topic",
    segments: decoded,
    ...(step ? { words } : {}),
    ...(lens ? { lens } : {}),
  };
  const canonical = step
    ? link(target)
    : decoded.map((x) => wireSegment(utf8Encode(x))).join("/") + lensQuery(lens);
  return { status: "OK", target, canonical };
}

// ---- the realm part of a route (naming review §6)
//
//   #/r/<alias>/<link>                      an app-configured alias (sepolia, local-1): the app resolves it
//   #/r/eip155:<chainId>/0x<ledger>/<link>  the full form, always accepted: chain id + the deployment's ledger proxy
//
// One ledger is one Realm (the realm id derives from genesis chain, ledger and salt), so no realm id is needed.

export interface RealmRef {
  chainId: number;
  ledger: Address;
}

export type RealmSplit =
  /** The full form. `rest` is what follows it (the link), `canonical` the realm part in canonical form. */
  | { status: "FULL"; realm: RealmRef; canonical: string; rest: string }
  /** An alias the app resolves from its own configuration. */
  | { status: "ALIAS"; alias: string; rest: string }
  | { status: "INVALID"; rule: RealmRule };

export type RealmRule =
  | "empty"
  | "bad-escape"
  | "unsupported-namespace"
  | "bad-chain-id"
  | "bad-ledger"
  | "bad-alias";

const CHAIN_ID = /^[1-9][0-9]{0,15}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The full realm form for a deployment: `eip155:<chainId>/0x<ledger, lowercase>`. */
export function formatRealm(realm: RealmRef): string {
  if (!Number.isSafeInteger(realm.chainId) || realm.chainId <= 0)
    throw misuse("formatRealm: chainId must be a positive integer");
  if (!ADDRESS.test(realm.ledger)) throw misuse("formatRealm: ledger must be a 20-byte address");
  return `eip155:${realm.chainId}/${realm.ledger.toLowerCase()}`;
}

/**
 * Split the realm off the front of a route path (what follows `#/r/`). The full form spans two segments; an alias
 * is one. Aliases are lowercase letters, digits and hyphens; a colon always means a chain namespace, and only
 * `eip155` is supported.
 */
export function splitRealm(path: string): RealmSplit {
  const raw = path.startsWith("/") ? path.slice(1) : path;
  const at = (i: number) => {
    let n = -1;
    for (let k = 0; k < i; k++) {
      n = raw.indexOf("/", n + 1);
      if (n < 0) return raw.length;
    }
    return n;
  };
  const firstEnd = at(1);
  const first = decodeOnce(raw.slice(0, firstEnd));
  if (first === null) return { status: "INVALID", rule: "bad-escape" };
  if (first === "") return { status: "INVALID", rule: "empty" };
  const after = (end: number) => (end < raw.length ? raw.slice(end + 1) : "");
  if (!first.includes(":")) {
    if (!ALIAS.test(first)) return { status: "INVALID", rule: "bad-alias" };
    return { status: "ALIAS", alias: first, rest: after(firstEnd) };
  }
  const [ns, id] = first.split(/:(.*)/s, 2) as [string, string];
  if (ns !== "eip155") return { status: "INVALID", rule: "unsupported-namespace" };
  if (!CHAIN_ID.test(id) || !Number.isSafeInteger(Number(id)))
    return { status: "INVALID", rule: "bad-chain-id" };
  const secondEnd = at(2);
  const ledger = decodeOnce(raw.slice(firstEnd + 1, secondEnd));
  if (ledger === null) return { status: "INVALID", rule: "bad-escape" };
  if (firstEnd >= raw.length || !ADDRESS.test(ledger))
    return { status: "INVALID", rule: "bad-ledger" };
  const realm: RealmRef = { chainId: Number(id), ledger: ledger.toLowerCase() as Address };
  return { status: "FULL", realm, canonical: formatRealm(realm), rest: after(secondEnd) };
}
