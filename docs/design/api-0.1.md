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
  spanChunkBytes: number;            // 8 160 (efs2/chunking/1)
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

/** Why something is unknown, unsupported or failed. */
export interface Reason {
  code: ReasonCode;
  retry: "never" | "transient" | "after-reconcile" | "after-replan";
  detail?: string;
}
export type ReasonCode =
  | "RPC_UNAVAILABLE" | "RPC_ERROR" | "BASIS_STALE" | "REORGED" | "LIMIT_EXCEEDED"
  | "NOT_VERIFIED_DEPLOYMENT" | "UNSUPPORTED_PROFILE" | "GATEWAY_UNAVAILABLE" | "DIGEST_MISMATCH"
  | "POLICY_BLOCKED" | "INVALID_RESUME_TOKEN" | "TOO_LARGE" | "CHAIN_MISMATCH"
  | (string & Record<never, never>);    // open union
```

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

- The first segment is `~efs`. The name profile reserves that prefix, so no path can look like a link. This
  departs from the naming review's `o/<id>` and `v/<id>`, which collide with root folders named `o` or `v`.
- `link()` emits lowercase ids. `parseLink()` accepts any hex case and one percent-decode per segment, and returns
  `canonical` so a router can redirect to the canonical form. `%2F` is never a separator.
- `parseLink()` returns `{ status: "OK", target: ObjectLink | RevisionLink, canonical }`,
  `{ status: "INVALID", rule }`, or `{ status: "UNSUPPORTED", kind: "path" }` for anything that does not start with
  `~efs`. Path links wait for the folder model.
- **Lens** (naming review §6): only object links carry one, as the single parameter `lens`. Its value is an ordered,
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
  size: bigint; sha256: Hex; mediaType: string | null; mediaTypeSource: "extension" | "property" | null;
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

## 6. Caches (passed in by the caller; async, so IndexedDB can back them later)

```ts
/** Exact verified bytes, keyed by content digest or record id. Eviction is a cache miss, never "absent". */
export interface ByteStore {
  get(key: Hex): Promise<Uint8Array | undefined>;
  put(key: Hex, bytes: Uint8Array): Promise<void>;
}
/** Results qualified by basis, keyed by deployment + basis + query. */
export interface ResultStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export function memoryByteStore(o?: { maxBytes?: number }): ByteStore;      // the default
export function memoryResultStore(o?: { maxEntries?: number }): ResultStore;
```

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
  | { kind: "efs.send"; status: "NOT_SENT"; planId: Hex; reason: Reason }          // a definite wallet refusal (4001)
  | { kind: "efs.send"; status: "AMBIGUOUS"; planId: Hex; reason: Reason }         // lost response or timeout
  | { kind: "efs.send"; status: "STALE"; planId: Hex; reasons: readonly string[] } // account/chain/precondition changed
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

## 8. Errors that do throw

```ts
export interface EfsFault extends Error {
  name: "EfsFault";
  code: "MISUSE" | "ABORTED" | "LIMIT" | "INVARIANT" | (string & Record<never, never>);
  details?: Readonly<Record<string, unknown>>;
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
`pin-verified`, `open-inline` (followed by `readBytes`), `open-absent`, and `open-span` (followed by `readRange` across
a chunk edge and `readBytes`). `ids.file` names the subject each one opens. `@efs/sdk/testing` exports the matcher:
`createRpcReplay(t).answer(body)` and `replayFetch(t)` for `createEfs({ fetch })`. It matches each call on
`[method, params]` and ignores the JSON-RPC id. Calls inside a batch are matched one by one, and an unmatched call
gets a JSON-RPC error and is listed in `misses`.

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
