# EFS SDK 0.1 — API draft (types only)

**Status:** revision 2. The client dev's review is applied (must-fixes A–D plus the smaller asks). Implementation is in progress.

> **Provisional until James rules on tags vs directories (PM, 2026-11-24; expected in about a day).** James may change the data model, possibly so that directories are tags. Everything folder-, directory- and path-shaped (§4 path links, §5 `resolve`/`list`/`lookup`/`placements`/`pathsOf`/`changedSince`, `DirectoryEntry`/`DirectoryPage`, and the folder operations in §7 `Planner`) is **not frozen**. Model-independent parts are stable enough to build against: client creation and pinning (§2), the vocabulary and evidence (§3), name checks, the byte reads (`open`/`read`/`stream`/`bytes`, grades, locations), caches (§6), the write lifecycle (`review`/`send`/`reconcile`/`run`, journal, lock, BUSY), errors (§8) and fixtures (§9). In the code, all folder-specific API lives in one module so it can be reshaped.
**Date:** 2026-11-24
**Inputs:**
- The client dev's asks of 2026-11-24.
- The accepted SDK plan (results, wallet lifecycle, resume tokens).
- The contracts surface (working tree at 2026-11-24).
- Lessons from the earlier SDK. The main one: ship fewer calls, each one fully built. Nothing in the API throws "not implemented".

**Rules every type below follows**
- **Plain data only.** Results survive `structuredClone`, so a result can cross a worker boundary or go into IndexedDB unchanged. Nothing carries meaning through a class instance, a function or a symbol. `bigint` and `Uint8Array` are allowed.
- **Ids** are lowercase `0x` hex strings. The brands below exist only at compile time.
- **Discriminants:** every result has a `kind` string, and most have a `status`.
- **Uncertainty is data, not an exception.** `UNKNOWN`, `PARTIAL`, `MASKED`, `CONFLICT` and unavailable bytes are values in the result. A call throws only for misuse, for cancellation (an `AbortError`) or when a resource bound is exceeded.
- **Every call** accepts `{ signal?: AbortSignal }`.
- **No UI or Signals dependency.** No hidden caches: the stores are passed in by the caller.
- **Adding later is non-breaking.** Optional fields, new union members (string unions are open) and new namespaces can be added without breaking callers. Tags, properties, lists and homes will arrive that way, once the contracts model them. Until then they do not exist; there are no stubs that throw.

---

## 1. Entry points and subpaths

| Import | Contains | Guest-safe? |
|---|---|---|
| `@efs/sdk` | `createEfs`, the result and evidence types, names and paths, `validateDeploymentManifest` | yes |
| `@efs/sdk/links` | the route and link grammar alone (`link`, `parseLink`, `formatRealm`, `splitRealm`): no runtime dependencies, for startup routers | yes |
| `@efs/sdk/files` | the Files reader (`resolve`, `list`, `lookup`, `open`, `read`, `stream`, `history`, …) | yes |
| `@efs/sdk/actions` | `createWriter`, plans, `review`, `send`, `reconcile`, `memoryJournal` | no |
| `@efs/sdk/web` | browser helpers (no journal) | yes |
| `@efs/sdk/web/journal` | `indexedDbJournal`, submission lock (Web Locks) | no |
| `@efs/sdk/node` | `fileJournal`, file-system stores (Node condition only) | no |
| `@efs/sdk/testing` | `guestProbe`, fixture helpers | dev only |
| `@efs/sdk/fixtures/*.json` | recorded result fixtures (§9) | dev only |
| `@efs/sdk/protocol-inputs.json` | the contracts commit (later, the release digest) this build targets | — |

## 2. Creating a client and pinning the deployment

```ts
import { createEfs } from "@efs/sdk";

export function createEfs(config: EfsConfig): Efs;

export interface EfsConfig {
  /** Ordered. A logical read is pinned to ONE endpoint and ONE basis; on failure it restarts on the next
   *  endpoint at a fresh basis and records the attempt. Results are never stitched across endpoints. */
  rpcs: readonly RpcEndpoint[];
  /** efs-deployment.json, the object (fetched by the app; the SDK does no network I/O at import time). */
  deployment: DeploymentManifest;
  /** release.json, the expected code hashes and Type ids used for the cold pin. */
  release: ReleaseManifest;
  gateways?: GatewayConfig;
  cache?: { bytes?: ByteStore; results?: ResultStore };
  /** Called once per RPC request (or HTTP batch envelope) and once per gateway fetch. For metering. */
  onRequest?: (event: RequestEvent) => void;
  /** Injected for tests or proxies. Defaults to globalThis.fetch, looked up at call time, never at import. */
  fetch?: FetchLike;
  limits?: Partial<ReadLimits>;
}

export type RpcEndpoint =
  | string                                         // http(s) JSON-RPC URL; labelled by its origin
  | { url: string; label?: string }
  | { provider: Eip1193Like; label?: string };     // a wallet, or the user's own node via an extension
// Every endpoint is checked against deployment.chainId before it serves a read. A mismatched endpoint becomes a
// FAILED attempt (reason CHAIN_MISMATCH), never data. An Efs instance is immutable: build a new one when the RPC
// list changes. The byte and result stores can be shared safely across instances, because every key includes the
// deployment and the basis.

export interface Eip1193Like {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...a: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...a: unknown[]) => void): unknown;
}

export interface GatewayConfig {
  ipfs?: readonly string[];     // ordered gateway origins, user-configurable
  arweave?: readonly string[];
  /** Which location schemes may be fetched at all (default: https, ipfs, ar, web3, data). */
  allowSchemes?: readonly string[];
  maxBytes?: bigint;            // per file (default 50 MiB)
  timeoutMs?: number;           // per attempt (default 10 000)
}

export interface Efs {
  readonly deployment: DeploymentInfo;           // validated from the manifest at creation; not yet pinned
  readonly limits: ProtocolLimits;               // so the UI can warn "this takes N prompts" before planning
  readonly capabilities: Capabilities;           // plain data, e.g. { tags: false, properties: false }
  /** The cold pin: chain id, block, describe(), proxy implementation slot and five code hashes, compared with
   *  `release`. Runs once, then reuses its result. Every read calls it implicitly. */
  pin(o?: CallOpts): Promise<PinResult>;
  /** A view pinned to one basis. Reads made through `view.files` share that basis. */
  at(basis: BasisPolicy | Basis, o?: CallOpts): Promise<ViewResult>;
  /** Shorthand for `(await at("latest")).files`, re-pinned per call. */
  readonly files: FilesReader;
  readonly names: Names;
  readonly paths: PathCodec;
  readonly lens: LensTools;
}

export interface ProtocolLimits {
  maxInlineBytes: number;            // largest inline file body (maxBody minus the header)
  maxActionsPerPublication: number;  // 64
  maxBodyBytesPerPublication: number;// 16 384 on the fixture
  spanChunkBytes: number;            // 8 160 (efs/chunking/1)
  maxLensPrincipals: number;         // 64
}
export interface Capabilities { tags: boolean; properties: boolean; lists: boolean; homes: boolean; web3Gateway: boolean }

export interface LensTools {
  readonly default: Lens;                                     // from the manifest (defaultLensPrincipals)
  from(input: readonly (PrincipalId | Address)[]): Lens;      // addresses become EOA principals; dedupe; ≤ 64
  mineFirst(me: Address | PrincipalId, base?: Lens): Lens;    // [me, ...default without me]
  principalOf(account: Address): PrincipalId;                 // EOA/7702 rule; contract principals need code (async variant below)
  principalOfAccount(account: Address, o?: CallOpts): Promise<PrincipalId>;
}
export function checksumAddress(address: Hex): Address;      // EIP-55

export type BasisPolicy = "latest" | "safe" | "finalized";

export interface Basis {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp?: bigint;       // the block's time (unix seconds); absent in results recorded before 0.1 carried it
  executionSet: Hex;        // from describe()
  /** The endpoint's LABEL, or its origin only when no label was given. A raw URL never appears in a result,
   *  cache, journal or export: URLs often carry API keys. */
  endpoint: string;
}

export type PinResult =
  | { kind: "efs.pin"; status: "VERIFIED"; basis: Basis; deployment: DeploymentInfo; evidence: Evidence }
  | { kind: "efs.pin"; status: "MISMATCH"; basis: Basis; mismatches: PinMismatch[]; evidence: Evidence }
  | { kind: "efs.pin"; status: "UNKNOWN"; reason: Reason; evidence: Evidence };

export interface DeploymentInfo {
  chainId: number;
  realmId: Hex;
  ledger: Address;
  readers: { ledgerReads: Address; ledgerViews: Address; lens: Address; filesPage: Address };
  root: FolderRef;
  defaultLens: Lens;
  typeIds: Readonly<Record<string, Hex>>;     // "files-root/1" → id; always read, never hardcoded
  contractsCommit: string;
}
```

## 3. Shared vocabulary

```ts
export type Hex = `0x${string}`;
export type Address = Hex;
export type PrincipalId = Hex & { readonly __efs?: "principal" };  // compile-time brand only
export type RecordId = Hex & { readonly __efs?: "record" };
export type SubjectId = Hex & { readonly __efs?: "subject" };

export interface FolderRef { kind: "folder"; recordId: RecordId }              // a folder IS a directory record
export interface FileRef { kind: "file"; subject: SubjectId }                  // a stable file identity
export interface RevisionRef { kind: "revision"; recordId: RecordId; file: SubjectId }

export interface Lens { principals: readonly PrincipalId[] }                    // ordered, ≤ 64
export type LensInput = Lens | readonly (PrincipalId | Address)[] | "default";

export interface CallOpts { signal?: AbortSignal }
export interface ReadOpts extends CallOpts { lens?: LensInput }

/** Every result has one. Reading it is never required; it's there for an Inspector. */
export interface Evidence {
  attempts: readonly Attempt[];       // one per endpoint or gateway attempt, in order
  requests: number;                   // RPC requests made for this result
  raw?: readonly RawRead[];           // exact return data, kept when requested ({ keepRaw: true })
}
export interface Attempt { endpoint: string /* label or origin, never the URL */; outcome: "OK" | "FAILED" | "ABANDONED"; reason?: Reason; ms: number }
export interface RawRead { call: string; to: Address; data: Hex; result: Hex; basis: Hex }

/** Why something is unknown, unsupported or failed. Branch on code, retry and the structured fields, never on detail. */
export interface Reason {
  code: ReasonCode;
  retry: "never" | "transient" | "after-reconcile" | "after-replan";
  detail?: string;          // free text for logs and support: not a contract
  revert?: RevertInfo;      // the ledger refused the call (a simulated revert)
  wallet?: WalletMismatch;  // on WALLET_MISMATCH
}
export interface RevertInfo {
  selector: Hex;                // always
  error?: string;               // the name from the vendored errors table ("E_CAS"); absent when unknown, never guessed
  args?: readonly unknown[];    // only when they decode cleanly as that error (uints as bigint: serialize with toJson)
}
export interface WalletMismatch {
  expected: { chainId: number; account: Address };        // what the plan needs
  actual: { chainId: number; account: Address | null };   // the wallet's chain and first account now
}
export type ReasonCode =
  | "RPC_UNAVAILABLE" | "RPC_ERROR" | "BASIS_STALE" | "REORGED" | "LIMIT_EXCEEDED"
  | "NOT_VERIFIED_DEPLOYMENT" | "UNSUPPORTED_PROFILE" | "GATEWAY_UNAVAILABLE" | "DIGEST_MISMATCH"
  | "POLICY_BLOCKED" | "INVALID_RESUME_TOKEN" | "TOO_LARGE" | "CHAIN_MISMATCH"
  | "JOURNAL_UNAVAILABLE" | "OVER_TX_GAS_CAP" | "STALE" | "WALLET_MISMATCH" | "USER_REJECTED" | "BUSY"
  | "NOT_YET_DECIDABLE" | "REORGED_DROPPED" | "EXPIRED"
  | "WALLET_UNAUTHORIZED" | "WALLET_UNSUPPORTED" | "WALLET_INVALID_PARAMS"        // NOT_SENT
  | "WALLET_DISCONNECTED" | "WALLET_CHAIN_DISCONNECTED"                         // AMBIGUOUS
  | (string & Record<never, never>);    // open union
```

`retry` says what can move a stopped operation forward. **transient:** try the same thing again (for a save,
Continue). **after-reconcile:** settle from the ledger first, then try again. **after-replan:** this plan cannot go
as it stands; plan again from fresh state, and for a save abandon the old sequence. Continue never helps here, even
when the save is PARTIAL. **never:** nothing will.

**The SDK never sends again on its own.** Continue (`resume`), Send again and every other retry is always the
person's click. A wallet decline is `USER_REJECTED` with `retry: "transient"`: the plan is still good, and they may
approve it next time. Map by `code` first, then use `retry` for codes the UI does not name.

## 4. Names, paths, links

```ts
export interface Names {
  /** files-name/2 rules. NFC normalization is the SDK's job (the contract cannot check it). */
  check(name: string): NameCheck;
  normalize(name: string): string;      // NFC
}
export type NameCheck =
  | { status: "VALID"; normalized: string; bytes: Uint8Array }
  | { status: "INVALID"; rule: string }                  // e.g. "bidi-control", "leading-whitespace"
  | { status: "UNSUPPORTED_BY_PROFILE"; profile: string };

export interface PathCodec {
  /** Wire form: RFC 3986 percent-encoding, uppercase %HH. Display form: IRI with a small escape set. */
  parse(path: string): PathParse;                        // "/docs/read me.txt" or "/docs/read%20me.txt"
  formatWire(segments: readonly string[]): string;
  formatDisplay(segments: readonly string[]): string;
  /** Links: by path (Lens-dependent; may carry the sender's Lens so "share my view" reproduces it; off by
   *  default), by object (stable across renames), by revision (exact). */
  link(target: PathLink | ObjectLink | RevisionLink): string;
  parseLink(link: string): LinkParse;
}
```

**Object and revision links (shipped in 0.1, root exports `link` / `parseLink`).** A link is one fragment-safe
string that an app places in its route, for example after `#/files/`:

| Link | Form | Opens | Lens |
|---|---|---|---|
| object | `~efs/o/0x<64 hex subject id>[?lens=<p>,<p>…]` | the current head of that subject (a file today; folders reuse the form) | the route default, or the given ordered principals |
| revision | `~efs/v/0x<64 hex revision record id>` | exactly that revision's bytes | no |
| home | `0x<40 hex address>[/<name>/…][?lens=…]` | a place under an address, then folder and file names (files-name/2, case kept) | the route default, or the given ordered principals |
| topic | `<word>[/<word>/…][?lens=…]` | a topic; one word alone is that word's page. Words are folded before lookup | the route default, or the given ordered principals |

- The first segment is `~efs`. The name profile reserves that prefix, so no path can look like a link. This
  departs from the naming review's `o/<id>` and `v/<id>`, which collide with root folders named `o` or `v`.
- `link()` emits lowercase ids. `parseLink()` accepts any hex case and one percent-decode per segment, and returns
  `canonical` so a router can redirect to the canonical form. `%2F` is never a separator.
- `parseLink(input, { fold? })` returns `{ status: "OK", target: ObjectLink | RevisionLink | HomeLink | TopicLink,
  canonical }` or `{ status: "INVALID", rule, segment?, detail? }`. Every first segment starting with `~` is the
  system's (only `~efs` is defined); a first segment that is an address is a home; anything else is a topic (tag
  model spec §5). One trailing "/" is ignored, an empty segment is refused, and each segment is percent-decoded once
  before folding. Home and topic segments are written in the canonical wire form (RFC 3986, uppercase %HH).
- **The fold is the caller's** until the fold rule (`efs/fold/1`) is chosen: `fold(segment)` returns the word or the
  rule it breaks. Without a fold, a topic parses with `segments` only and no `words`, and its `canonical` keeps the
  typed form (don't redirect on it). Either way the fold-independent word rules apply: 1–255 bytes, no `/`, no
  control, not `.` or `..`, no leading `~`, not address-shaped. The folded word is checked again, including for
  space and `A–Z`. Vectors: `packages/sdk/test/vectors/links.json`.
- `link()` formats home links from the address and names, and topic links from folded `words` (MISUSE for anything
  the grammar refuses).
- **Lens** (naming review §6): object, home and topic links carry one, as the single parameter `lens` (revision
  links never do). Its value is an ordered,
  comma-separated list of 1 to 64 principals without duplicates. An account (key principal) is written as its
  20-byte address and any other principal as its 32-byte id. `target.lens` is a `Lens` to pass to reads. Names such
  as `alice.eth` are INVALID with rule `lens-name-unsupported` in 0.1. A revision link with a query, or any other
  parameter, is INVALID with rule `unsupported-parameter`.
- **Routes** are `#/r/<realm>/<link>`. `<realm>` is either an app-configured alias (`sepolia`, `local-1`: lowercase
  letters, digits and hyphens, resolved by the app) or the full form `eip155:<chainId>/0x<ledger>`, which apps
  always accept. In the full form `<ledger>` is the deployment's ledger proxy, the "core" in
  `realmOrigin(genesisChainId, core, realmSalt)`. One ledger is one Realm, so links carry no realm id.
  `formatRealm({ chainId, ledger })` writes the full form, and `splitRealm(path)` takes the realm off the front of
  a route. It returns `{ status: "FULL", realm, canonical, rest }`, `{ status: "ALIAS", alias, rest }` or
  `{ status: "INVALID", rule }`, and `rest` is passed to `parseLink`. A colon always means a chain namespace, and
  only `eip155` is supported. Apps cross-check a full-form realm against the deployment document they fetch.

## 5. Files reader (`@efs/sdk/files`)

```ts
export interface FilesReader {
  resolve(path: string | readonly NameInput[], o?: ReadOpts): Promise<ResolveResult>;  // segments are already decoded
  list(dir: FolderRef, o?: ListOpts): Promise<DirectoryPage>;
  listAll(dir: FolderRef, o: ListAllOpts): Promise<DirectoryListing>;    // bounded by o.maxPages
  lookup(dir: FolderRef, name: NameInput, o?: ReadOpts): Promise<EntryResult>;
  open(target: FileRef | RevisionRef | DirectoryEntry, o?: ReadOpts): Promise<OpenResult>;
  read(opened: OpenedFile, range: { offset: bigint; length: bigint }, o?: CallOpts): Promise<ByteRangeResult>;
  /** Verified chunks only. Pull-based (respects backpressure); cancel() or the AbortSignal stops gateway fetches. */
  stream(opened: OpenedFile, o?: StreamOpts): ReadableStream<Uint8Array>;
  bytes(opened: OpenedFile, o?: BytesOpts): Promise<BytesResult>;          // one-shot, size-capped
  history(file: FileRef, o?: HistoryOpts): Promise<HistoryPage>;
  placements(object: FileRef | FolderRef, o?: ReadOpts): Promise<PlacementsResult>; // parents one level up
  pathsOf(object: FileRef | FolderRef, o?: ReadOpts & { limit?: number }): Promise<PathsResult>; // up to N root chains
  changedSince(dirs: readonly FolderRef[], basis: Basis, o?: ReadOpts): Promise<ChangeResult>; // one multicall
  locations(revision: RevisionRef, o?: ReadOpts): Promise<LocationsResult>; // every carrier for the sha256
}

**Streaming (shipped in 0.1).** The portable core compiles without DOM types, so streaming ships in two layers:
`fileChunks(efs, opened, o)` in `@efs/sdk/files` is an async iterator of verified chunks that works in every runtime,
and `streamFile(efs, opened, o)` in `@efs/sdk/web` wraps it as a pull-based `ReadableStream<Uint8Array>` (one window
per pull). `StreamOpts`: `offset`, `length`, `windowBytes` (rounded up to whole 8,160-byte chunks; default 16
chunks), `maxBytes` (the buffering cap for external files) and `signal`.
- Ledger layouts stream window by window, and each chunk record is verified before its bytes are emitted. A
  whole-file stream also checks the author's sha256 claim at the end, so it can never disagree with `bytes()`.
- External files have a single digest for the whole body, so they are fetched and verified first, then emitted.
  Bytes that fail are never emitted.
- A stream that cannot continue throws or errors with `EfsFault("STREAM_FAILED")`, with details
  `{ grade, reason, emitted }`. Resume with `offset + emitted`. Cancel (`return()`, `cancel()` or the signal) aborts
  the requests in flight.
- **Opt-in unverified playback**: `streamUnverified(efs, opened, o)` in `@efs/sdk/web` returns `{ stream, result }`,
  and `unverifiedChunks` in `@efs/sdk/files` is the iterator form. External bytes are emitted as they arrive, before
  they can be verified, and `result` (which never rejects) settles to VERIFIED or MISMATCH once the whole body has
  been read. A MISMATCH also errors the stream. Fail-over to the next location happens only before the first byte.
  Whole files only. Nothing is buffered, so `maxBytes` does not apply. `gateways.timeoutMs` bounds the time to the
  headers and the idle time between chunks. Ledger layouts are verified per chunk and settle VERIFIED. Verified
  seeking into IPFS content will come from per-block CID verification, never from unverified ranges.

/** A name as text (encoded to UTF-8 as given; the SDK never re-normalizes it) or as exact bytes. */
export type NameInput = string | Uint8Array;

export interface ListOpts extends ReadOpts {
  limit?: number;                         // ≤ 64 rows per page
  resume?: ResumeToken;
  filter?: {
    kinds?: readonly ("folder" | "file" | "masked")[];    // on-chain kinds bitmask; default folder + file
  };                                     // filter by Type: waits for James's ruling (no unbuilt surface)
  include?: { header?: boolean };         // size, media type, admission (default true)
}

export interface ResolveResult {
  kind: "efs.resolve";
  status: "PRESENT" | "ABSENT_PROVEN" | "MASKED" | "CONFLICT" | "UNKNOWN" | "INVALID" | "NOT_A_FOLDER";
  /** One link per segment, root first. Drives the breadcrumb. Stops at the first non-PRESENT segment. */
  chain: readonly { name: string; entry: DirectoryEntry }[];
  target?: FolderRef | FileRef;
  failedAt?: number;                      // segment index
  reason?: Reason;
  basis: Basis; lens: Lens; evidence: Evidence;
}

/** Common to every entry. `name` is the decoded text; `nameBytes` are the exact on-chain bytes, which rename,
 *  lookup and remove reuse. Render `name` in a translate="no" element. */
interface EntryBase { name: string; nameBytes: Hex; position: Hex }

/** One winning author. */
interface Winner {
  author: PrincipalId; lensIndex: number;
  binding: { revision: bigint; admission: bigint; block?: bigint };
}

export type DirectoryEntry =
  | (EntryBase & Winner & { status: "PRESENT"; kind: "folder"; target: FolderRef;
                            children?: { count: bigint } | { count: "UNKNOWN" } })
  | (EntryBase & Winner & { status: "PRESENT"; kind: "file"; target: FileRef;
                            head?: FileHead })                        // absent when include.header is false
  /** The winner masked this position (a "whiteout"): it hides every lower author's entry. `target` is what the
   *  winner had bound, if known. */
  | (EntryBase & Winner & { status: "MASKED"; kind: "masked"; target?: FolderRef | FileRef })
  /** No single winner: several Lens principals at equal priority disagree (resolveNoTiebreak). */
  | (EntryBase & { status: "CONFLICT"; candidates: readonly Candidate[] })
  /** The position could not be resolved at this basis (e.g. a reader returned UNKNOWN). Never "absent". */
  | (EntryBase & { status: "UNKNOWN"; reason: Reason })
  /** An on-chain row that fails Files rules (returned, never dropped). */
  | (EntryBase & { status: "INVALID"; reason: Reason; raw?: Hex });

export interface FileHead {
  revision: RevisionRef; size: bigint; admission: bigint;
  /** Syntax-validated `type/subtype` (≤ 127 bytes) or null. Untrusted: never use it for rendering decisions.
   *  Until contracts ship properties (C4/C5), it is derived from the name's extension (`source: "extension"`). */
  mediaType: string | null; mediaTypeSource: "extension" | "property" | null;
}
export interface Candidate { author: PrincipalId; lensIndex: number; target?: FolderRef | FileRef; revision: bigint }

export interface DirectoryPage {
  kind: "efs.directoryPage";
  status: "PRESENT" | "UNKNOWN" | "BASIS_STALE" | "UNSUPPORTED" | "LIMIT_EXCEEDED" | "INVALID";
  dir: FolderRef;
  /** Order: within each Lens principal, the order positions were first bound (binding ordinal), principals in
   *  Lens order, deduplicated by position. Stable across pages of one scan. Across bases it is stable for
   *  unchanged positions; new ones append. Sorting by name, date or size is client-side over loaded entries. */
  entries: readonly DirectoryEntry[];
  /** COMPLETE only for a scan this SDK ran from the origin to the end at ONE basis. A page reached from a
   *  resume token is at most PARTIAL. An empty page with PARTIAL coverage means "nothing on this page", not "empty". */
  coverage: Coverage;
  resume?: ResumeToken;
  reason?: Reason;
  basis: Basis; lens: Lens; evidence: Evidence;
}
export type Coverage =
  | { state: "COMPLETE" }
  | { state: "PARTIAL"; why: "MORE_PAGES" | "RESUMED" | "LIMIT" | "GAS" | "FILTERED" }
  | { state: "UNKNOWN"; reason: Reason };

/** Resumes a query. Plain, serializable data. It carries NO evidence about the rows before it. */
export interface ResumeToken { v: 1; query: Hex; basis: Hex; position: Hex; scanned: number }

export interface EntryResult {
  kind: "efs.entry";
  status: "PRESENT" | "ABSENT_PROVEN" | "MASKED" | "CONFLICT" | "UNKNOWN" | "INVALID";
  entry?: DirectoryEntry;      // present for every status except ABSENT_PROVEN
  reason?: Reason; basis: Basis; lens: Lens; evidence: Evidence;
}

export interface OpenedFile {
  file: FileRef; revision: RevisionRef; author: PrincipalId;
  size: bigint; sha256: Hex;
  /** 0.1 (contracts C4): the media type the revision's descriptor declares, lowercase type/subtype as the chain
   *  admits it. A hint about the bytes, never their identity. Absent when none is declared, and always for inline
   *  revisions (no descriptor carries one): fall back to the name's extension. */
  mediaType?: string;
  layout: "inline" | "span" | "external";
  locations: readonly Location[];          // the carriers to try, in policy order
  span?: { root: RecordId; chunkSize: number };
}
export type OpenResult =
  | { kind: "efs.open"; status: "PRESENT"; file: OpenedFile; basis: Basis; lens: Lens; evidence: Evidence }
  | { kind: "efs.open"; status: "ABSENT_PROVEN" | "MASKED" | "CONFLICT" | "UNKNOWN" | "INVALID";
      reason?: Reason; basis: Basis; lens: Lens; evidence: Evidence };

export interface Location {
  scheme: "inline" | "ledger" | "ipfs" | "ar" | "https" | "web3" | (string & Record<never, never>);
  uri?: string; author?: PrincipalId; descriptor?: RecordId;
}

export type ByteGrade =
  | "VERIFIED"            // checked against sha256 (whole file) or per span chunk
  | "UNVERIFIED_RANGE"    // bytes returned but cannot be verified yet (whole-file digest, partial read); never show as content
  | "MISMATCH"            // returned bytes failed the check; they are NOT handed back
  | "UNAVAILABLE"         // every location failed
  | "UNSUPPORTED_LOCATOR"
  | "POLICY_BLOCKED"
  | "UNKNOWN";

export interface ByteRangeResult {
  kind: "efs.bytes.range";
  grade: ByteGrade;
  offset: bigint; length: bigint;
  bytes?: Uint8Array;                     // present only for VERIFIED, or for UNVERIFIED_RANGE when opted in
  location?: Location;                    // where the bytes came from
  attempts: readonly LocationAttempt[];
  evidence: Evidence;
}
export interface BytesResult extends Omit<ByteRangeResult, "kind"> { kind: "efs.bytes" }

export interface HistoryPage {
  kind: "efs.history";
  status: "PRESENT" | "UNKNOWN" | "ABSENT_PROVEN";
  revisions: readonly { revision: RevisionRef; author: PrincipalId; admission: bigint; block?: bigint;
                        size: bigint; mediaType: string | null; parent?: RecordId }[];
  coverage: Coverage; resume?: ResumeToken; basis: Basis; lens: Lens; evidence: Evidence;
}

export interface ChangeResult {
  kind: "efs.changed";
  dirs: readonly { dir: FolderRef; status: "UNCHANGED" | "CHANGED" | "UNKNOWN"; reason?: Reason }[];
  since: Basis; now: Basis; evidence: Evidence;
}
```

### Gateway policy and publisher locations (0.1)

The default `gateways.allowSchemes` is `["ipfs", "ar", "data", "web3"]`: a publisher's `https://` location is fetched only
when the app allows it. The reason is that the author chose that server, and it sees the reader's IP address.
- `gateways.allowSchemes` including `"https"` allows such locations for the whole client.
- `allowOrigins: ["https://host[:port]"]` on `readBytes`, `readRange`, `fileChunks`, `streamFile`,
  `streamUnverified` and `unverifiedChunks` allows exact origins for one call. A fetch allowed that way never
  follows a redirect to another origin (each hop is checked outside browsers; `redirect: "error"` in browsers).
  Entries with a path, credentials, http (without `allowInsecureHttp`) or a private host (without
  `allowPrivateHosts`) are MISUSE.
- Blocked locations: `blockedOrigins` lists the origins `allowOrigins` can unblock, and `reason.detail` names every
  blocked location with the option that would allow it (`allowOrigins`, `gateways.allowSchemes`,
  `gateways.allowInsecureHttp`, `gateways.allowPrivateHosts`; credentials never). Stream failures carry the same
  `blockedOrigins`.

### web3:// locations (0.1)

`web3://0x<address>[:<chainId>]/<path>[?query]` locations (ERC-6860) are read through the client's own RPC endpoints,
so no new party sees the reader, and `web3` is in the default `allowSchemes`.
- The contract must answer `resolveMode()` with "5219" (ERC-6944). The SDK calls the standard ERC-5219
  `request(resource, params)` and decodes the body slot as bytes, so binary content survives. It follows ERC-7617
  `web3-next-chunk` until the header is absent. Header names are matched case-insensitively.
- One read runs on one endpoint at one block. It stops early when `Content-Length` (the whole file's length on every
  chunk) disagrees with the file, when the body runs past the file or `maxBytes`, or when a chunk makes no
  progress. A 307's `Location` is tried next, planned through the same gateway policy (at most 5 hops). Any status
  other than 200 or 307 is a failure of that location, and a reverting call is a fault of the call, never "not
  found".
- The whole body is verified against the file's sha256 before any byte is emitted, as for every external location.
- Unsupported in 0.1, reported as UNSUPPORTED_LOCATOR with a reason: names (ENS), a userinfo "from" address,
  contracts in manual mode, and other chains (the client has endpoints for its own chain only).
- Fixtures: `bytes-web3-verified`, `bytes-web3-no-contract` (the seed's locator names the zero address), and
  `bytes-external-unsupported` (web3:// on another chain).

## 6. Caches (shipped in 0.1)

```ts
/** Exact verified bytes, keyed by content id. Eviction is a cache miss, never "absent". */
export interface ByteStore {
  get(key: Hex): Promise<Uint8Array | undefined>;
  put(key: Hex, bytes: Uint8Array): Promise<void>;
}
export function memoryByteStore(o?: { maxBytes?: number }): ByteStore;       // default, 32 MiB
// @efs/sdk/web/cache (opt-in, persistent):
export function indexedDbByteStore(o?: { name?: string; maxBytes?: number }): WebByteStore; // 256 MiB, LRU
```

Pass a store as `createEfs({ cache: { bytes } })`. The default lives in memory only, so a guest visit writes
nothing to storage. The persistent store, like the journal, creates no database on reads.
- **Ledger records** are cached as `typeId ‖ body` under a key scoped to the chain and ledger. On every read the
  entry is re-hashed against its record id, so a tampered or corrupted entry is a miss. The scoping means that
  only records this ledger itself returned as PRESENT are reused: a body cached from another deployment can never
  make a file read here while this ledger lacks its records. A second read of a span file needs no record calls.
- **External content** is cached by sha256 and checked against the digest and size on every read. A hit makes no
  request, so no gateway policy is involved: nobody learns anything from it. The PM ruled on this (#19).
  Consequences: bytes allowed once with `allowOrigins` are reused by the same client without asking, and with a
  persistent store they are also reused after a reload. The permission itself is never remembered. Span files are
  never cached whole under their sha256 claim, so a lying claim still grades MISMATCH.
- **Pins** are security decisions, so they are never read from a caller's store. Each client remembers its
  verified pins privately in memory, per deployment, endpoint and block hash. `efs.at("latest")` at a block that
  endpoint already verified costs one call, and a new block or another endpoint is verified in full.
- A cache that throws is a miss on read and is ignored on write. It never fails a read.
- `ResultStore` (caching other results) is deferred: every result cached so far is either content-addressed
  (bytes) or a security decision (pins).

## 7. Writes (`@efs/sdk/actions`)

```ts
import { createWriter } from "@efs/sdk/actions";
import { indexedDbJournal } from "@efs/sdk/web/journal";

export function createWriter(efs: Efs, config: WriterConfig): Promise<EfsWriter>;

export interface WriterConfig {
  authorizer: Authorizer;
  journal: Journal;                       // durable before resolve; memoryJournal() is for tests only
}

/** 0.1 supports the direct profile: one wallet prompt per publication (eth_sendTransaction). The signed and
 *  session profiles come later; adding a variant here is non-breaking. */
export type Authorizer =
  | { kind: "eip1193"; profile: "direct"; provider: Eip1193Like; account?: Address }
  | { kind: "local"; profile: "direct"; account: LocalAccountLike };

export interface EfsWriter {
  readonly account: Address;
  readonly principal: PrincipalId;
  readonly plan: Planner;
  /** For the consent screen: a human-readable list of effects, a gas estimate (indexFloor plus execution), the
   *  number of prompts, and a staleness check. */
  review(plan: Plan | PlanSet, o?: CallOpts): Promise<Review>;
  /** Journals SUBMISSION_POSSIBLE, then makes the single wallet call that authorizes and broadcasts. */
  send(plan: Plan, o?: SendOpts): Promise<SendResult>;
  /** No prompt, no rebroadcast. Reads publicationAt(principal, nonce) at a fresh basis. */
  reconcile(planId: Hex, o?: CallOpts): Promise<ReconcileResult>;
  /** send, then reconcile, for each plan in order. Never retries on its own. */
  run(plan: Plan | PlanSet, o?: SendOpts & { onProgress?: (p: RunProgress) => void }): Promise<RunResult>;
  /** Unresolved attempts for this (chain, realm, deployment, account), read under the submission lock. */
  pending(o?: CallOpts): Promise<readonly AttemptRecord[]>;
}

export interface Planner {
  mkdir(parent: FolderRef, name: string, o?: PlanOpts & { parents?: boolean }): Promise<PlanResult>;
  put(dir: FolderRef, name: string, content: PutContent, o?: PlanOpts): Promise<PlanResult>;
  update(file: FileRef, content: PutContent, o?: PlanOpts): Promise<PlanResult>;  // new revision
  rename(entry: DirectoryEntry, newName: string, o?: PlanOpts): Promise<PlanResult>;
  move(entry: DirectoryEntry, to: FolderRef, o?: PlanOpts & { name?: string }): Promise<PlanResult>;
  link(target: FileRef | FolderRef, dir: FolderRef, name: string, o?: PlanOpts): Promise<PlanResult>; // hardlink
  copy(file: FileRef, dir: FolderRef, name: string, o?: PlanOpts): Promise<PlanResult>;               // new identity
  remove(entry: DirectoryEntry, o?: PlanOpts): Promise<PlanResult>;           // mask: hides lower authors too
  restore(entry: DirectoryEntry, o?: PlanOpts): Promise<PlanResult>;
  revertToInherited(entry: DirectoryEntry, o?: PlanOpts): Promise<PlanResult>; // release: lower authors show
  hide(entry: DirectoryEntry, o?: PlanOpts): Promise<PlanResult>;             // mask another author's entry
  /** Staged save: combine many edits into one publication when they fit the limits; otherwise a PlanSet
   *  labelled non-atomic. */
  batch(steps: readonly PlanResult[], o?: PlanOpts): Promise<PlanResult>;
}

export interface SendOpts extends CallOpts {
  /** If another tab or process holds the submission lock: false (default) returns BUSY at once; true waits; a
   *  number waits at most that many milliseconds. */
  waitForLock?: boolean | number;
}
export interface RunProgress { planIndex: number; of: number; planId: Hex; stage: "SENDING" | "SUBMITTED" | "RECONCILING" | "DONE" }

export type PutContent =
  | { bytes: Uint8Array; mediaType?: string }               // inline if it fits, otherwise a span tree on-chain
  | { external: string; size: bigint; sha256: Hex; mediaType?: string }   // ipfs://, ar://, https://, web3://
  | { external: string; bytes: Uint8Array; mediaType?: string };          // the SDK hashes the bytes

export interface PlanOpts extends ReadOpts { deadlineSeconds?: number }

export type PlanResult =
  | { kind: "efs.planResult"; status: "PLANNED"; plan: Plan | PlanSet }
  | { kind: "efs.planResult"; status: "REFUSED"; reason: Reason }   // e.g. INVALID name, a stale head, too large
  | { kind: "efs.planResult"; status: "UNKNOWN"; reason: Reason };  // the preconditions could not be read

/** Plain, journal-safe data. `digest` is the native intent digest, the thing a wallet approval covers. */
export interface Plan {
  kind: "efs.plan"; v: 1;
  id: Hex;                                // = digest
  digest: Hex;
  chainId: number; realmId: Hex; ledger: Address;
  principal: PrincipalId; account: Address;
  nonce: bigint; deadline: bigint; executionSet: Hex; acceptanceProfile: Hex;
  actions: readonly ActionData[]; bodies: readonly Hex[];
  effects: readonly Effect[];             // human-readable, for review and reconcile
  preconditions: readonly Precondition[]; // e.g. head revision at the basis
  basis: Basis;
}
export interface PlanSet {
  kind: "efs.planSet"; atomic: false; plans: readonly Plan[];
  why: "BODY_LIMIT" | "ACTION_LIMIT";
}

export interface Review {
  kind: "efs.review";
  effects: readonly EffectView[];
  prompts: number;                        // the wallet prompts this profile needs
  gas: { estimate: bigint; floor: bigint; schedule: string };
  fee?: { maxFeePerGas: bigint; totalWei: bigint };
  wouldRevert: RevertInfo | null;         // the simulated revert, if the plan would fail now (error? is the vendored
                                          // name; absent for an unknown selector, where 0.0 said "unknown")
  stale: boolean;                         // a precondition no longer holds; re-plan first
  atomic: boolean;
}

/** Stable codes for the client's message catalog. `text` is English, for logs only. */
export interface EffectView {
  code: "files.mkdir" | "files.put" | "files.update" | "files.rename" | "files.move" | "files.link" | "files.copy"
      | "files.remove" | "files.restore" | "files.revert" | "files.hide" | "files.name" | (string & Record<never, never>);
  args: Readonly<Record<string, string>>;   // e.g. files.update → { path, fromRevision, toRevision }
  text?: string;
}

export type SendResult =
  | { kind: "efs.send"; status: "SUBMITTED"; planId: Hex; txHash: Hex }
  | { kind: "efs.send"; status: "NOT_SENT"; planId: Hex; reason: Reason }          // nothing broadcast: see "Wallet errors"
  | { kind: "efs.send"; status: "AMBIGUOUS"; planId: Hex; reason: Reason }         // lost response or timeout
  | { kind: "efs.send"; status: "STALE"; planId: Hex; reasons: readonly string[]; revert?: RevertInfo }
                                                                                   // the ledger refuses the plan (e.g. E_CAS)
  | { kind: "efs.send"; status: "BUSY"; planId: Hex; holder?: Hex };              // the lock is held (another tab)

export interface ReconcileResult {
  kind: "efs.reconcile";
  planId: Hex;
  outcome: "COMMITTED" | "NOT_COMMITTED_PROVEN" | "UNKNOWN";
  publication?: bigint;                   // ordinal when committed
  effects: readonly { effect: Effect; state: "COMMITTED" | "NOT_COMMITTED_PROVEN" | "UNKNOWN" }[];
  basis: Basis; evidence: Evidence;
}
```

**Journal (`@efs/sdk/web/journal`, `@efs/sdk/node`):**
- The lock key is `(chainId, realmId, deploymentId, account)`. The lock is taken *before* an attempt is created, and the journal is re-read once it is held.
- Each record stores the plan, every stage transition (including the write-ahead `SUBMISSION_POSSIBLE`), the tx hash and the nonce.
- Unknown fields are preserved.
- JSON codecs are exported: `encodeJournalRecord` / `decodeJournalRecord`, with bigint written as decimal strings.

### Splitting a save into publications (0.1, model-independent part)

`splitPublications(actions, { model, limits, txGasCap, headroom?, blockGasLimit?, firstWrite? })` in
`@efs/sdk/actions` packs an ordered list of `PlannedAction`s (`{ action, body, shape?, exists?, bindRow?, group? }`)
into publications that each fit one transaction.
- **Batch limits** come from the kernel's own checks (`LedgerCore._bounds`): actions ≤ `maxActionsPerPublication`;
  BIND, UNBIND and RELEASE ≤ `maxBindsPerPublication`; summed body bytes ≤ `maxBodyBytesPerPublication`; each
  body ≤ `maxBodyBytes`.
- **Gas** comes from the contracts' fitted model (release.json `gasModel`, generated as `GAS_SCHEDULES`):
  `fixed + Σ actions`, a new PUBLISH being `publishNew[shape] + perWord × ceil(bytes/32) + perByte × bytes`, with
  shapes keyed as the release keys them (`files-child/1 form 0`, `files-content/1 carrier 2`, …). A BIND is priced
  at its `bindRow` (`bindHeadFresh`, `bindHeadRebind`, `bindFolderFreshFile`, …), or the largest row when unknown;
  `firstWrite` adds `firstWriteSurcharge` to the first part. The SDK adds the 21,000 intrinsic gas and the calldata
  (every byte priced as non-zero), which the model excludes. Plans aim at `txGasCap × (1 − headroom)`, the
  contracts' budget rule with their 15%.
- **Which model:** `gasPlanFor(deployment)` takes the schedule `efs-deployment.chain.feeSchedule` names, else the one
  whose hardforks include `chain.hardfork`, with `chain.txGasCap` (always enforced; 2^24 when not stated). It
  refuses (`UNSUPPORTED_PROFILE`) rather than guess when the document has no `chain` block or names a schedule this
  SDK was not generated with. Where the cap counts execution gas only (amsterdam), `model` is the execution-gas fit
  and `model.total` the whole, which must also fit `blockGasLimit`.
- **Order and grouping:** order is kept, so a record is never published after something that references it.
  Consecutive actions sharing a `group` are never split, so a file's finish appears atomically.
- **Refusals** name the index: a body over the record limit is `LIMIT_EXCEEDED`, and a group too big for any
  transaction is `OVER_TX_GAS_CAP`. eth_estimateGas on the exact call stays the authority (see `send`).

`writer.planSequence(parts)` plans the parts as consecutive native nonces: part 0 takes the next nonce, and part i
takes that nonce + i. Each part is its own plan, journal record and exactly-once identity, so the parts are sent in
order and a failure is reconciled part by part. `writer.runSequence(parts)` carries a split save, resumably:
- **One approval where possible:** an atomic EIP-5792 wallet (`wallet_getCapabilities` reports atomic) gets every
  remaining part in one `wallet_sendCalls` request. Only there are parts pre-planned with consecutive native
  nonces.
- **Part by part otherwise:** each part is planned just before it is sent and sent only after the previous one
  committed. The EFS native nonce is inside the intent, and the wallet assigns only the transaction nonce, so a
  native-nonce gap cannot happen.
- **The record:** the sequence record (`efs-sdk-sequence/1`, journal storage v2) holds every part. The result,
  `SequenceProgress`, gives `state`, `total`, `committed`, `current` (index, plan, attempt stage), `mode` and a
  `reason`.
- **The states:** COMPLETE is the only success. PARTIAL means some parts committed and the save stopped. For an
  upload, the file appears only when its last part, the finish, commits. IN_FLIGHT means a part was sent and is not
  decided yet.
- **`settleMs` (default 60 s)** bounds each wait for a sent part (its receipt, then its ledger decision). It
  never turns "no receipt yet" into a failure: a part still undecided when it runs out stays SUBMITTED in the
  journal, the save answers IN_FLIGHT (reason NOT_YET_DECIDABLE, "Saved · confirming"), and `reconcileSequence` or
  `resume` settles it from the ledger later, sending nothing again. With the default, one call carries a
  part-by-part save through every part, one prompt per part; `0` returns right after the first send.
- **`onProgress(p, e)`** (runSequence and resume) is for live UI only, e.g. "Approve part 2 of 5 in your wallet".
  `e` is `{ kind: "wallet-request"; parts }` just before each wallet prompt (after the write-ahead record, so
  `p.current.stage` is SUBMISSION_POSSIBLE; several parts in one EIP-5792 request; never for a local account or a
  part that is not sent), or `{ kind: "committed"; index }` as each part commits. It is advisory: not awaited,
  anything it throws is ignored, and a missed or extra event changes nothing. The returned `SequenceProgress`, the
  journal and reconcile stay the truth about what was sent.
- **A wallet that moves:** before each send the wallet's chain and accounts are re-read. If they are not the
  plan's, nothing is sent and the journal is untouched: NOT_SENT with reason WALLET_MISMATCH (`retry: "transient"`,
  `reason.wallet` = expected vs actual). Remaining parts are never sent under another account. Switch the wallet
  back, then `resume(id)`.
- **A throw is never "nothing was saved":** every fault thrown out of `runSequence` or `resume` is an `EfsFault`
  with plain properties `sequenceId?`, `mayHaveSent` and `sequenceMayHaveSent`. `mayHaveSent` means this call may have
  broadcast something: it wrote a part's write-ahead record before the throw (e.g. IndexedDB went away while the
  person was in the wallet app, or the caller aborted after the wallet sent). `sequenceMayHaveSent` means some part
  of this save may be on chain, from this call or an earlier one, and is true when the record could not be read.
  `sequenceId` is there once the record exists (always for resume). A missing record (cleared, or written to
  another journal) proves nothing either: `sequenceMayHaveSent` is false only when the record was read and shows no
  part ever past its write-ahead. When either flag is true, say "may have been
  saved — checking" and `reconcileSequence(sequenceId)` once the cause is fixed: the ledger decides, and nothing is
  sent twice. Journal failures up to and including the write-ahead write are not thrown: they return NOT_SENT
  JOURNAL_UNAVAILABLE. A non-EfsFault error is rethrown as INVARIANT with the original as `cause`.
- **Each part keeps its `deadlineSeconds`:** it is applied each time the part is planned, including on resume.
- **Wallet errors:** NOT_SENT only for errors that mean the request was refused before signing; the attempt is
  stamped NOT_SENT, so nothing waits on it. They are 4001 USER_REJECTED and 4100 WALLET_UNAUTHORIZED
  (`retry: "transient"`), and 4200 WALLET_UNSUPPORTED and -32602 WALLET_INVALID_PARAMS (`retry: "never"`: the same
  wallet request will not work; for wallet_sendCalls, send part by part with `batch: "never"`). A disconnect, 4900
  WALLET_DISCONNECTED or 4901 WALLET_CHAIN_DISCONNECTED, can be raised after the wallet relayed, so it is AMBIGUOUS
  with that named reason (`retry: "after-reconcile"`: "Your wallet lost its connection; checking whether the save
  went out"), as is any other wallet error or a lost response: the part stays in flight until reconcile decides.
- **EXPIRED:** a part that was sent and never committed, then proven not committed (a finalized block past its
  deadline, or its nonce finalized for another plan) without a reorg, is NOT_STARTED or PARTIAL with reason EXPIRED
  (`retry: "transient"`), never a bare "not sent": "This save didn't go through — Send again" (resume, the
  person's click). It clears when the part is planned again.
- **`current.deadline`, `current.checkedAt`, `current.pastDeadline`:** for a planned part, its plan's deadline
  (unix seconds, bigint), the latest block the last reconcile read (`{ blockNumber, timestamp }`), and whether that
  block is past the deadline with the part not committed there. Judged at the latest block, not a finalized one: a
  reorg could in principle still bring back an inclusion from before the deadline, so it is a reason to release a
  hold, never "not saved". EXPIRED, which waits for a finalized block past the deadline, is the proof. All three
  come from the sequence record, with no journal or chain read of their own.
- **`effect`:** `SequenceProgress.effect` names what the save is for, `{ kind: "files.edit", file, revision }` when
  its parts carry one file edit (planEditFile's `files.edit` effect). It is stored when runSequence starts, so
  `pendingSequences` names the file after a reload ("readme.txt: Partially saved") and a client can hold new saves
  per file. Display and blocking data only: it never changes what resume sends. Saves started before it have none
  (hold account-wide for those).
- **The other calls:** `pendingSequences()` lists open saves (the "2 of 5 saved — Continue" state).
  `reconcileSequence(id)` settles from the ledger and never prompts, so it is safe on every app start.
  `resume(id)` continues, and is the only sequence call that may prompt. `abandon(id)` stops offering to continue:
  committed parts stay on chain, and abandoning is not undoing.

### Finality, reorgs and the wallet-free view (0.1)

- **Finality:** a COMMITTED reconcile carries `final`. While it is false, the admission is not yet at a finalized
  block, the attempt stays in `pending()`, and reconcile keeps re-checking it. Sequences carry the same `final`, and
  a COMPLETE sequence stays in `pendingSequences` until it is final. Client vocabulary: "Saved · confirming" for
  COMPLETE with `final: false`, then "Saved".
- **Reorgs:** if a re-check no longer finds the admission at the latest block, reconcile answers UNKNOWN with
  reason REORGED. The attempt goes back to SUBMISSION_POSSIBLE, and a COMPLETE sequence becomes IN_FLIGHT. The
  part remembers the reorg, so every later progress for that save (`reconcileSequence`, `pendingSequences`,
  `resume`) carries the reason:
  - **REORGED** (`retry: "after-reconcile"`): the part is in flight again and may be re-included. Wait: "This save
    was undone by the network — checking". `resume` sends nothing while it is in flight.
  - **REORGED_DROPPED** (`retry: "transient"`): a finalized block past the plan's deadline proves it was not
    committed. Offer "This save was undone by the network — Send again"; `resume` re-plans and sends that part, and
    only when the person clicks.
  The reason clears when the part commits again (re-included) or is sent again.
- **Unreadable finalized block:** if the finalized-block read fails (an endpoint without the "finalized" tag, or a
  finalized block from before the deployment), COMMITTED at latest is still decided, with `final: false`, and
  NOT_COMMITTED_PROVEN still requires a successful finalized read.
- **`openJournal(efs, { journal })`:** sequences with no wallet. `pendingSequences({ account? })` covers one
  account, or every account on this deployment, and `reconcileSequence(id)` settles from the ledger alone. Both
  never prompt and create nothing. Each `SequenceProgress` names its `account`. Continue means: connect, create a
  writer for that account, and `resume(id)`. A writer for another account refuses with MISUSE.

### Editing a file (`planEditFile`, 0.1)

`planEditFile(efs, writer, { file, base, content, lens?, mediaType? }, opts?)` in `@efs/sdk/files` plans a new revision
of an existing file, opened by object link. It touches only the file and its HEAD: no name, folder or path, so it
does not wait on the tags-vs-directories ruling. Planning reads the chain at one basis and never calls the wallet
(only `writer.principal` is used).

```ts
type EditPlanResult =
  | { status: "PLANNED"; parts: SequencePartInput[]; review: EditReview; basis }   // always parts: runSequence(parts)
  | { status: "BASE_CHANGED"; head: RevisionRef | null; basis }  // HEAD under the Lens is not `base` (null: no HEAD)
  | { status: "TOO_LARGE"; reason }                              // more than maxParts publications, or a huge locator
  | { status: "UNKNOWN"; reason; basis? };                        // the chain could not be read: nothing decided
```
- **What is published:** a `files-child/1` revision whose parent is `base`, and `BIND(HEAD, file, 0 → revision)`.
  `content` is bytes or `{ kind: "external", length, sha256, locator }`. Bytes that fit one record body
  (`maxBodyBytes − 96`) go inline in the revision; larger bytes are chunked canonically (`efs/chunking/1`) under a
  `files-content/1` descriptor (layout `chunk` for one chunk, `span` for a tree). External content is a
  `files-external/1` locator over the empty sentinel chunk.
- **Media type (contracts C4):** a descriptor declares it as the rest of its body (`files-content/1` after its ten
  words, `files-external/1` after the locator; at most 255 bytes, `""` = unknown). Omitted, the edit keeps the base
  revision's type, read at the same basis (a base that cannot be read is UNKNOWN, never "no type"). `mediaType`
  names one: the type and subtype are lowercased, parameters kept as given, and a string the chain's grammar refuses
  throws MISUSE (`details: { mediaType, code }`, the chain's refusal code) before anything is read, so it is never a
  revert. `""` declares none. Only a descriptor carries a type, so bytes small enough to sit inline are stored as one
  chunk (layout `chunk`: two more records and their gas, shown in the review) when the edit declares or keeps one;
  `mediaType: ""` keeps a small file inline. `review.mediaType` is what the new revision declares, and
  `OpenedFile.mediaType` reads it back.
- **Never a silent overwrite:** first the base check (the file's HEAD under the Lens must still be `base`), then a
  compare-and-swap. The bind carries the editor's own HEAD binding revision as `expectedRevision`, so if another
  save by the same account lands first, the ledger refuses this one: `runSequence` reports reason STALE,
  `retry: "after-replan"`, `revert.error === "E_CAS"`. In a split edit whose content parts already committed, this
  is PARTIAL, and Continue cannot succeed (the same bind would be refused again). The client abandons that sequence
  ("This file changed since you opened it") and plans again from the new base. When `base` is another author's revision
  (`review.guard: "lens"`), only the planning-time base check covers it.
- **Splitting:** chunks and spans go through `splitPublications` under the per-transaction gas cap. The finish
  (descriptor, revision and HEAD bind) stays in one publication, so the edit appears atomically when the last part
  commits. The model is `gasPlanFor(efs.deployment)` (`opts.gasModel` overrides; without either, planning is
  UNKNOWN). `opts.maxParts` (default 64) bounds the save.
- **`review`:** `file`, `base`, the new `revision` id, `author` (the writer's principal), `size`, `sha256`,
  `layout` (`inline` | `chunk` | `span` | `external`), `mediaType` (`""`: none), `parts`, `prompts { sequential, atomicBatch: 1 }`,
  `gas { perPart, schedule }`, `records`, `expectedRevision`, `guard` and `visibleInLens`. `visibleInLens` is false
  when the edited Lens leaves the author out, or puts an earlier author of this HEAD first: the save still lands,
  but that view keeps showing the other revision (`efs.lens.mineFirst(account)` puts the author first).
- **Effects:** every part carries one `files.edit` effect with the same facts as strings (`mediaType` only when one is
  declared), plus `part`, `parts` and
  `stage` (`content` stores bytes only; `finish` moves HEAD), so a resumed save can still describe itself.
- **BASE_CHANGED** also carries `headAuthor` and `headAdmission` (the admission that last set that HEAD). Compare
  `headAdmission` with `basis.admissions` of the read the edit began from (`OpenResult.basis`): at or below it, the
  head was already there (for example your own version, now first because you connected); above it, someone saved
  after you opened the file. Every `Basis` from the pin now carries `admissions` (describe().admissions).

### Folders (0.1)

A folder is a `files-directory/1` record (`FolderRef { kind: "folder", directory, owner? }`): its body is
`(creatorPrincipal, salt)` and only its creator may publish it, so its id is its permanent link and names one folder
of one owner forever (never REUSE another principal's folder record: the chain refuses it). Its entries
are FOLDER bindings, one per author: `(FOLDER, directory, keccak(name)) → target`, where the target is a file
subject or another folder's directory record. The Lens decides which author's entry a name shows (the first author
in Lens order with a bound entry; an earlier author's mask hides the name). Every read and planner takes the parent
explicitly: there is no default root, and no link format names one (the Realm's shared root is a stand-in parent in
fixtures; folder paths will live under an address once homes land). `openObject(efs, id, { lens? })` says what an
object link's id is, in one batched read: a folder record is `FOLDER { folder, owner }`, a created subject is
`FILE { file, creator, open }` (opened under the Lens), anything else `ABSENT_PROVEN`; a record of another Type is
INVALID. The kind is fixed by the id, so the answer never changes. `efs.lens.place({ reader, owner, base })` builds a place's
Lens: the reader, then the owner (`FolderRef.owner`; `owner: null` leaves it out), then `base`, each once.

**Reads** (`@efs/sdk/files`, all at one block):
- `listFolder(efs, folder, { lens?, kinds?, limit?, cursor?, withSize? })` → `PRESENT { folder, rows, skipped,
  coverage, next? }` | `ABSENT_PROVEN` (no such folder: never "empty") | `UNKNOWN` | `INVALID`. One row per name.
  A row has `name`, `position`, `kind` (`folder` | `file` | `other` | `invalid`), `typeId` (files-directory/1, or the
  HEAD revision's Type), `target`, `author`, `admission`, `head?` and, with `withSize`, `size`. `kinds` is a kind
  filter run by the SDK, counted in `skipped.filtered`; names an earlier author hid are `skipped.hidden`. In this
  generation the chain admits only files and folders as entries, so the kind is the Type; a filter by Type id comes
  with tag and topic views, where items of any Type appear. `coverage` is COMPLETE only for a listing scanned from its
  start to its end on one page; a page from a cursor is at most PARTIAL (`RESUMED`); a fresh scan that ended but that
  the index cannot vouch for is PARTIAL `INDEX_PARTIAL`; an empty PARTIAL page with a `next` means "keep reading". A
  page with no rows is PRESENT only when COMPLETE (or the end of a resumed listing): a fresh scan that found nothing
  but cannot vouch for it is UNKNOWN, never an empty folder. A fresh listing whose readers saw the chain move
  (BASIS_STALE) is read again from the start, at most three times, and says so (`rereads`, with every attempt in
  `evidence.attempts`: on a real chain it should stay absent; anvil does it while mining bursts, see
  `tools/anvil-blockhash-repro`); a stale cursor is UNKNOWN with BASIS_STALE,
  `after-replan`: list again from the start. A row with no name record is returned as `invalid`, and the rest of the
  page stands. Cost: three
  round trips per page (the page, its authors, the rows' Types and owners); `withSize` adds one read per file row and
  one more round trip for files stored under a descriptor.
- `lookupEntry(efs, { folder, name }, { lens? })` → `PRESENT { selected, candidates, conflict }` | `MASKED { by,
  candidates }` | `ABSENT_PROVEN` | `UNKNOWN` | `INVALID`. `candidates` is every author in the Lens with an entry at
  that name, in Lens order, each with `firstBound` (when it was first placed); `conflict` when there are several. An
  app that shows same-named entries as a list orders them itself.
- `resolvePath(efs, { from, segments }, { lens?, maxSegments? })` → `PRESENT { target, entry, chain }` |
  `ABSENT_PROVEN` / `MASKED { segment, chain }` | `NOT_A_FOLDER { segment }` | `INVALID { segment?, rule? }` |
  `UNKNOWN`. A `from` (or a lookupEntry folder) that is not a files-directory/1 record is INVALID, never
  ABSENT_PROVEN. Each segment follows the Lens's choice, with its author in `chain`. No depth limit: a path costs one
  round trip per segment, so object links are the fast (and rename-proof) way to open a file; a path is a lookup that
  a rename or move can break.
- Each reply is cross-checked: the folder must be a files-directory/1 record, the heads' selection must be the Lens
  law's, the page and Lens readers must agree on every row, and COMPLETE must hold locally.

- `listRemoved(efs, { folder, author }, { limit?, cursor? })` ("Show removed"): one author's removed entries in a
  folder, RELEASED or MASKED, each with `name`, `position`, `state`, the `target` it had before (what Restore binds
  again), its binding `revision` and `removedAt`. Lens-independent: it reads only that author's own scope list (the
  index's kind-10 list of the positions they ever bound there, in first-bind order), a page of up to 64 entries at a
  time. The live index and its bitmap store must be the ones the deployment names, or the page is UNKNOWN. COMPLETE
  only for the whole list read from its start; an empty page that is not COMPLETE is UNKNOWN, never "nothing
  removed". Restore any row with `planRestoreEntries`.
  `target` is always known, never null or guessed. The ledger hides (UNBIND) only a bound entry and releases only a
  bound or hidden one, so every removed entry had a target, at most two versions back (released, hidden, bound).
  The SDK walks that history with those rules. A history that can't be read back (`NOT_YET_DECIDABLE`) or that breaks
  them (`RPC_ERROR`: a version that can't precede the next, another admission than asked, a target kind no folder
  entry carries) is the endpoint's fault: the read moves to the next endpoint, and if none answers, the page is
  UNKNOWN. A page never holds a row whose target is unknown, so an app never has to tell "can't say" apart from
  "nothing to restore"; on UNKNOWN it shows the list as unavailable right now.

**Writes** (each `PLANNED { parts, review }` for `runSequence` | `REFUSED { refused }` | `TOO_LARGE` | `UNKNOWN`):
- `planCreateFile(efs, w, { folder, name, content, mediaType?, lens?, salt? })`: CREATE, the root revision (inline,
  or chunks under a descriptor; a declared type means a descriptor), the name record if new, BIND(HEAD), BIND(FOLDER).
- `planCreateFolder(efs, w, { folder, name, lens?, salt? })`: PUBLISH(files-directory/1 (writer, salt)), the name
  if new, BIND(FOLDER). No CREATE. The salt is random and never zero; a reused one is MISUSE. `review.created` is the
  new FolderRef with its owner.
- `planMoveEntries(efs, w, { moves: [{ from, to: { folder?, name?, via? } }], lens? })`: rename (a new name) and move
  (a new folder). Each move RELEASEs the old place (the Lens falls through to the next author there) and BINDs the new
  one, atomically in one publication; links to the file or folder keep working. Moving a folder needs
  `via: { from, segments }` (MISUSE without it): the destination's path from a folder you name, such as the start of
  your view. The planner resolves that path again itself at the planning block, under the same Lens, and it must end
  at the destination (REFUSED `PATH_CHANGED` otherwise). A move that puts the folder on that path, into itself or below
  itself, is MISUSE (`details.code: "INTO_ITSELF"`). There are no parent pointers, so this path is the only check. In a
  batch, each destination's ancestry is followed through the batch's other folder moves, so no batch can close a
  cycle.
- `planRemoveEntries(efs, w, { entries, hide?, lens? })`: RELEASE by default (you no longer put anything there: the
  next author's entry shows). `hide: true` UNBINDs (a mask: nothing shows there for a reader who ranks you above the
  entry's author). The chain lets anyone mask their own position; offering hide only to a place's owner is an app rule.
  Nothing is destroyed: the file stays reachable by its link.
- `planRestoreEntries(efs, w, { entries, lens? })`: BIND a released or hidden entry back to the target it had before,
  read from the binding's history by the same walk listRemoved uses, so a row's `target` is exactly what Restore
  binds. When that history can't name the target, the plan is UNKNOWN; it never binds a guessed one. Restoring a
  folder needs `via` (the path to its folder), with the same cycle checks as a move. Each review item carries
  `alsoPlaced`: how many live placements point at the target now, by anyone (the index's backlink count, from the
  generation the ledger names). Above 0, restoring puts it in one more place, for example after it was moved. Null
  when the index can't vouch.
- Every planner writes only the writer's own entries, each with a compare-and-swap on its revision. Refusal codes:
  `NAME_TAKEN_MINE` (your own entry holds the name), `NOT_YOURS` (with `author` and `admission`), `FOLDER_ABSENT`,
  `ENTRY_ABSENT`, `NOT_REMOVED`, `PATH_CHANGED`. A batch refuses as a whole and lists every refusal by `index`
  (a move's source and destination refusals both). A `salt` the writer already used is MISUSE. Another author's
  entry at the name is not a refusal: the review says what this Lens will show (`visibleInLens`, `shownInstead`,
  `hiddenBy`, and `shownAfter` for the place an entry leaves). Invalid names (checkName) and media types throw MISUSE
  before any read.
- `SequenceRecord.effect` names the save: `files.create`, `files.createFolder`, `files.move` (its moves),
  `files.remove` (`hide` and its entries) or `files.restore`, each listing the names it touches.

## 8. Errors that do throw

```ts
export interface EfsFault extends Error {
  name: "EfsFault";
  code: "MISUSE" | "ABORTED" | "LIMIT" | "INVARIANT" | "JOURNAL_UNAVAILABLE" | "STREAM_FAILED"
    | (string & Record<never, never>);
  details?: Readonly<Record<string, unknown>>;
  // Set on every fault out of runSequence / resume (see "A throw is never 'nothing was saved'"), else undefined:
  sequenceId?: Hex;
  mayHaveSent?: boolean;          // this call may have broadcast something
  sequenceMayHaveSent?: boolean;  // some part of the save may be on chain (true when its record is unreadable)
}
```
Nothing else throws. Transport and provider failures, missing data, wallet refusals and data-dependent limits (`LIMIT_EXCEEDED`, `TOO_LARGE`) all come back as result values. `LIMIT` is thrown only for a bad caller argument, e.g. `limit: 1000` on a page. `ABORTED` is the caller's own AbortSignal.

## 9. Recorded fixtures (`@efs/sdk/fixtures/*.json`)

Everything here is recorded from the real fixture chain by `pnpm record:fixtures`, in one run, so all the files agree
with each other.

**Result fixtures** carry `{ "schema": "efs-sdk-fixture/1", "contractsCommit", "case", "note", "result" }`. `result`
is the SDK's return value encoded with `toJson`, so decode it with `fromJson`. They are for chain-free unit tests of UI
logic. The current set:
- pin: `pin-verified`, `pin-mismatch`, `pin-unknown`
- open: `open-inline`, `open-span`, `open-external`, `open-absent` (ABSENT_PROVEN), `open-unknown`
- bytes: `bytes-inline-verified`, `bytes-span-range-verified`, `bytes-external-verified`, `bytes-external-mismatch`,
  `bytes-external-unavailable`, `bytes-external-unsupported`, `bytes-policy-blocked`
- writes: `send-ambiguous`, `journal-ambiguous-before`, `journal-ambiguous-after`, `reconcile-committed`

Folder fixtures (root page, partial page, lens conflict, masked entry, lookup absent, history) wait for the folder
read API.

**RPC transcripts** (`@efs/sdk/fixtures/rpc/*.json`, `{ "schema": "efs-sdk-rpc-transcript/1", "case", "note",
"contractsCommit", "ids", "steps", "calls" }`) hold the JSON-RPC traffic of the real SDK, as ordered
`{ request, response }` bodies. `rpc/deployment.json` is the matching `efs-deployment/1` document. With them the real
SDK runs end to end with no chain, for example behind a Playwright `page.route` on a fake RPC origin. The cases are
`pin-verified`, `open-inline` (followed by `readBytes`), `open-absent`, `open-span` (followed by `readRange` across
a chunk edge and `readBytes`), and `open-external-https`. That last one opens a file whose only location is a
publisher's https URL, reads it with the default policy (POLICY_BLOCKED, nothing fetched), then reads it with
`allowOrigins`. Its https half is plain fetch, not RPC: route `ids.httpsUrl` to serve `ids.httpsText`.
`ids.file` names the subject each case opens. `@efs/sdk/testing` exports the matcher:
`createRpcReplay(t).answer(body)` and `replayFetch(t)` for `createEfs({ fetch })`. It matches each call on
`[method, params]` and ignores the JSON-RPC id. Calls inside a batch are matched one by one, and an unmatched call
gets a JSON-RPC error and is listed in `misses`.

**Edit-flow transcripts** carry a second half, `wallet`: every EIP-1193 request the writer made of the wallet, in
order, as `{ method, params, result | error }`. `replayProvider(t)` (`@efs/sdk/testing`) answers them by the same
matching rule as the RPC half, and throws recorded errors with their `code`. So a page wired to
`createEfs({ fetch: replayFetch(t) })` and a wallet backed by `replayProvider(t)` replays a whole edit with no chain and
no wallet, provided it follows `steps` exactly: the same calls in the same order, with the same options. Blocks mined
between steps are already in the recorded answers. The cases edit `ids.file` (docs/readme.txt) as `ids.account` (the
fixture principal) from `ids.base` to the bytes of `ids.text`, giving `ids.revision`:
- `edit-one-approval`: open → planEditFile → runSequence → COMPLETE (`final: false`, "Saved · confirming") → the new
  HEAD reads back.
- `edit-reload-resume`: the wallet broadcasts but its response is lost, and the page reloads while the transaction is
  pending. `runSequence(parts, { settleMs: 0 })` → IN_FLIGHT. After the reload, `pendingSequences()` lists it, and
  `resume(id)` settles it from the ledger to COMPLETE with no second wallet request.
- `edit-confirming-final`: an edit saves with `final: false`, its block is finalized, and `reconcileSequence(id)` →
  `final: true`. `pendingSequences()` is then empty. Neither call uses the wallet.
`recordingProvider(inner)` is the recording side. The SDK's own `test/replay.test.ts` replays all three exactly as
above. (`settleMs: 0` there only forces IN_FLIGHT for the recording; apps use the default.) Replays answer repeated
identical calls in recorded order, so a transcript matches only the call order it was recorded with: these are the
SDK's contract tests. An app records its own flows with `recordingFetch` and `recordingProvider` against
`@efs/fixture`, and re-records whenever its call order changes.

**A live chain (`@efs/fixture`, Node only):** a second private tarball, packed from the same commit as `@efs/sdk`,
for live-chain tests such as the client's required e2e job and a dev chain. `startFixtureChain({ anvilPath?, port?,
ttlSeconds?, home?, chainId?, name? })` → `{ name, rpcUrl, chainId, deployment, deploymentPath, accounts: { fixture,
unlocked }, seed, contracts, stop() }`. `chainId` defaults to 31337 (what the recorded transcripts use); another id
builds the deployment for that chain (its realm, domain and activation carry it). `stopFixtureChain({ name, home })`
stops a chain left running under a sticky name (no-op when none), signalling only the anvil its lease names.
- **What it runs:** the contracts' own fixture tool, from the lock-verified snapshot it carries (`contracts/`, with
  `contracts/PROVENANCE.json`). That means anvil (osaka, with the EIP-7825 cap enforced), the genesis deployment, the
  Files Types and the seed. It needs `anvil` on PATH (or `anvilPath`) and `perl` (the ttl watchdog).
- **Wallet path:** anvil's ten default accounts are unlocked, so a test EIP-1193 provider forwards
  `eth_sendTransaction` for `accounts.fixture.address` (the seed's author, anvil #0) to anvil. That is the same call
  the writer's `eip1193` "direct" profile makes with a real wallet.
- **Proof:** `examples/smoke-fixture` installs both tarballs as a plain npm consumer, starts a chain, edits the
  seeded `readme.txt` and reads the edit back. CI runs it in the integration job.

## 10. Decisions from the client review (2026-11-24)

1. Both are available: `efs.at(...)` views, and the convenience `efs.files`.
2. Entries carry no `href`. The client's router calls `paths.link`.
3. Review effects are `{ code, args }` plus optional English `text`.
4. `stream()` returns a pull-based `ReadableStream`; cancel or abort stops the fetches.

## 11. Earlier questions (answered)

1. `efs.files` re-pins a fresh `latest` basis on every call. Your list-then-open flows probably want `efs.at(...)` views. Is having both fine, or do you want only views?
2. Should a `DirectoryEntry` include an `href` (the wire link), or will you call `paths.link` yourself?
3. `review()` returns `EffectView` strings in English. Do you want message keys plus arguments instead, for your MF2 catalog? I'd lean towards keys plus arguments.
4. `stream()` returns a `ReadableStream`. Everything else is plain data. Is that acceptable for your worker plan? A stream is transferable but not clonable.
