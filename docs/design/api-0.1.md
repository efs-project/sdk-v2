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
| `@efs/sdk/tags` | topics, tags and homes: ids and the chain's word grammar, `planTag` / `planDeny` / `planUntag`, `planLabel` / `planSame` / `planBroader`, `topicItems` (Mine, Everyone, Raw; each row's kind, a `kinds` filter), `topicItemsMerged` (a topic with its Lens's synonyms), `tagsOf`, `topicChildren`, `wordPage`, `topicPath`, `labelOf` / `topicName`, `fileNames`, `topicSynonyms`, `topicBroader`, `lensTagsOf`, the counts (docs/design/tags-0.1.md) | reads yes, planners no |
| `@efs/sdk/web` | browser helpers (no journal) | yes |
| `@efs/sdk/web/journal` | `indexedDbJournal`, submission lock (Web Locks) | no |
| `@efs/sdk/node` | `fileJournal`, file-system stores (Node condition only) | no |
| `@efs/sdk/testing` | `guestProbe`, RPC transcript replay, `planLoneHide` (a lone hide, for Unhide tests), `planOtherEntry` (a junk row, for blocking tests), `planHeadNo` / `planHeadRelease` (a "not this" or a take-back on a file's HEAD, for fileVersions tests) | dev only |
| `@efs/sdk/fixtures/*.json` | recorded result fixtures (§9) | dev only |
| `@efs/sdk/protocol-inputs.json` | the contracts commit (later, the release digest) this build targets | — |

## 2. Creating a client and pinning the deployment

```ts
import { createEfs } from "@efs/sdk";

export function createEfs(config: EfsConfig): Efs;

export interface EfsConfig {
  /** Ordered. A logical read is pinned to ONE endpoint and ONE basis; on failure it restarts on the next
   *  endpoint at a fresh basis and records the attempt. Results are never stitched across endpoints.
   *  Trust model: every reply is checked for its shape, its consistency with the rest of the read and the ledger's
   *  rules, and a reply that fails a check fails over to the next endpoint. A well-formed lie (an answer that passes
   *  every check, such as a false "this id is a created file" with a matching "no HEAD") is out of scope without
   *  proofs or a quorum across endpoints, which 0.1 does not do: the first endpoint that answers consistently wins. */
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
  // Ordered gateway origins, tried in order (the first whose bytes match the descriptor's length and sha256 wins).
  // None by default: the SDK names no third party (which one sees a reader's IP and content ids is the app's visible
  // choice), so ipfs:// and ar:// are POLICY_BLOCKED (rule "no-gateway") until the app names its gateways.
  ipfs?: readonly string[];
  arweave?: readonly string[];
  /** Which location schemes may be fetched at all (default: ipfs, ar, web3, data; a publisher's https is off). */
  allowSchemes?: readonly string[];
  maxBytes?: bigint;            // per file (default 50 MiB)
  timeoutMs?: number;           // per attempt (default 10 000)
}

export interface Efs {
  readonly deployment: DeploymentInfo;           // validated from the manifest at creation; not yet pinned
  readonly limits: ProtocolLimits;               // so the UI can warn "this takes N prompts" before planning
  readonly capabilities: Capabilities;           // plain data, e.g. { tags: false, properties: false }
  /** The cold pin: chain id, block, describe(), proxy implementation slot and the code hashes of every contract the
   *  SDK reads through (the ledger implementation, LedgerReads, LedgerViews, the Lens and Files page readers, and,
   *  when the document names them, the index, its reads contract and the three topic readers), compared with
   *  `release`. One deployless eth_call returns all the hashes after a zero word (EIP-3541 refuses returned code
   *  that starts with 0xEF). Runs once, then reuses its result. Every read calls it implicitly. */
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
  // What a person should see for a principal (pure, no reads): a key principal is { kind: "address", address }
  // (EIP-55: "0xf39F…2266", never the padded "0x0000…2266"); a contract principal is { kind: "contract", address }
  // only for an address in `contracts` (recomputed in this Realm: a hash is never read back or guessed); anything
  // else { kind: "principal", id }. A match holds forever, so it can be cached. principalDisplay(p, realmOrigin, ...)
  // in @efs/sdk is the same without a client.
  displayOf(principal: PrincipalId, o?: { contracts?: readonly Address[] }): PrincipalDisplay;
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
  /** With `atLeast.blockHash`: the asked-for block is no longer canonical as this basis sees it (reconcile it). */
  reorgedSince?: { blockNumber: bigint; blockHash: Hex };
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

### The read floor (0.1)

A read is never served from a block older than one this client has already read (design: docs/design/read-floor.md,
accepted 2026-11-26). After a save commits, a re-read through an endpoint that is behind would otherwise show the
state from before the save, and the new tag would quietly not be there.
- **The floor:**
  - Each `Efs` instance keeps one floor per policy, raised by every VERIFIED pin to the block it served.
  - `latest` must be at or above every floor; `safe` at or above the safe and finalized floors; `finalized` at or
    above its own. A finalized read after a latest one is not held back: it asked for an older block.
  - Only a pin raises a floor. Calls pinned to a block hash (pages, bodies) never do.
  - The check runs in `efs.at` (`pinDeployment`), the one place every read and plan gets its block. It costs no
    request on the happy path.
- **Behind:** an endpoint whose head is below the floor fails over; that costs one `eth_getBlockByNumber` and none of
  the pin's other calls. When every endpoint is behind, the pin polls within `reads.behindWaitMs` (default 4000;
  polls at 0.5, 1, 2 and 3.5 s), then answers UNKNOWN with reason `BEHIND` (`retry: "transient"`). `reason.floor`
  is the block it must reach; `reason.served` is each endpoint's head. Never a quiet older read. Suggested copy:
  "This network hasn't caught up with your last save yet. Checking…", with Retry once it is UNKNOWN.
- **Reorgs:**
  - A block at the floor's height with another hash is served and becomes the floor.
  - A head above the floor is served without checking the floor's hash. Newer canonical state is right even if the
    floor's block was reorged out.
  - A chain shorter than the floor (every endpoint below its height) can't be told apart from lag. It happens in a
    shallow reorg after a missed slot (it clears at the next block), and on a dev chain that was reset or rewound.
    It stays BEHIND: there is no time-based reset, because a stuck node would then serve old reads again.
    `efs.resetReadFloor()` is the escape: for a local chain only, behind a "The test chain was reset? Start over"
    action. A new client starts with no floor.
- **A save's block:**
  - `SequencePart.committedAt` is the reconcile basis at which the part was first seen committed (at or after its
    inclusion), cleared when a reorg undoes it.
  - `SequenceProgress.visibleAt` (COMPLETE) is the highest of them: a read at or after it sees the whole save.
  - On this client the floor already holds it, because reconcile's pin raised the floor.
  - The record also stores the chain's genesis block hash (`genesisHash`). It is read once per client, at the first
    commit: one request.
- **The journal raises the floor by itself:** when `pendingSequences`, `reconcileSequence` or `resume` reads a save
  back (a reload, another tab), its highest `committedAt` becomes a floor on that client.
  - **Same chain only:** the record's chain id and ledger must match, and its genesis hash must match the current
    chain's. That hash is read once per client, and only when the save's block would hold a read back.
  - **Why the genesis:** a reset or restarted local chain (`pnpm dev:reset`, a fresh `pnpm demo`) keeps its chain id
    and deterministic addresses, but anvil sets the genesis timestamp at start, so the genesis hash is new. The old
    save is then ignored rather than holding every read BEHIND.
  - **Caveats:** two anvil starts in the same wall-clock second share a genesis; and an anvil fork reports the forked
    chain's genesis.
- **`atLeast`:** `CallOpts.atLeast?: { blockNumber: bigint; blockHash?: Hex }` holds any read or plan to a block this
  client can't know about: a worker, another tab (post `efs.readFloor()` or a save's `visibleAt`), or a link that
  carries a basis.
  - With `blockHash`, one `eth_getBlockByNumber` per new head checks that the block is still canonical. When it isn't,
    the read is served (newer and canonical) with `basis.reorgedSince`, so reconcile the save rather than say "not
    there".
  - A malformed `atLeast` is MISUSE.
- **Trust:** the floor guards against endpoints that are *behind*, not endpoints that *lie*.
  - Endpoints are already trusted for chain state: the SDK checks code hashes and record ids, not state proofs. An
    endpoint that lies about a block number, a block's ancestry or the genesis can serve old state with or without
    a floor.
  - So every judgement here fails toward "no floor", never toward a wrong read:
    - the genesis is read from one endpoint, once per client;
    - a mismatch makes a journal floor not count, rather than holding reads (that is what keeps a reset dev chain
      usable);
    - the floor compares heights, not ancestry (ancestry would cost a request on every read).
  - A journal record seeds a floor only when it is well formed: 32-byte genesis and block hashes, a block number
    from 0 to 2^53 − 1, this chain id and ledger. A damaged part is skipped, and the highest well-formed part still
    counts.
- **Replay:** the floor follows a transcript's recorded heads (epoch replay repeats an epoch's last head, never a
  lower one). The recorded edit flows include the one genesis read.

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
  floor?: { blockNumber: bigint; blockHash?: Hex };              // on BEHIND: the block the read must reach
  served?: readonly { endpoint: string; blockNumber: bigint }[]; // on BEHIND: each endpoint's head
  feeSchedule?: { document: string; chain: string | null; freshSlotGas: bigint }; // the document is not the chain's
  gas?: { estimate: bigint; cap: bigint; suggestedParts: number }; // on OVER_TX_GAS_CAP: how many publications
  funds?: { gasLimit: bigint };   // on INSUFFICIENT_FUNDS for a single send: the limit the wallet must cover
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
  | "WALLET_DISCONNECTED" | "WALLET_CHAIN_DISCONNECTED" | "INSUFFICIENT_FUNDS"   // AMBIGUOUS
  | "BEHIND"                    // every endpoint behind the read floor or atLeast (floor, served)
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
  /** files-name/3 rules. NFC normalization is the SDK's job (the contract cannot check it). */
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
| path | `~efs/o/0x<64 hex folder id>/<name>[/<name>…][?lens=…]` | a folder or file by name below a folder named by its id (files-name/3, case kept). Any folder, the shared root included | the given principals, else the reader then the folder's creator (`efs.lens.place`) |
| revision | `~efs/v/0x<64 hex revision record id>` | exactly that revision's bytes | no |
| home | `0x<40 hex address>[/<name>/…][?lens=…]` | a place under an address (parsed from `0x` or `0X` and hex of either case, as the gateway reads it; written lowercase), then folder and file names (files-name/3, case kept) | the given principals, else the reader then the address's own identity at the read (`openHome`: the key principal of a key account, a contract's Realm principal) |
| topic | `<word>[/<word>/…][?lens=…]` | a topic; one word alone is that word's page. Words are folded before lookup | the route default, or the given ordered principals |

- The first segment is `~efs`. The name profile reserves that prefix, so no path can look like a link. This
  departs from the naming review's `o/<id>` and `v/<id>`, which collide with root folders named `o` or `v`.
- `link()` emits lowercase ids. `parseLink()` accepts any hex case and one percent-decode per segment, and returns
  `canonical` so a router can redirect to the canonical form. `%2F` is never a separator.
- **Names (files-name/3, contracts 04526b1; `checkName`):** 1–255 bytes of strict UTF-8, byte-exact and
  case-sensitive; no control, none of `/ \ # ? % < > " | : * ;` (a pasted link keeps its meaning, and EFS URL
  syntax keeps its delimiters), no bidi, invisible or noncharacter scalar, no Unicode white space first or last, not
  starting with `~efs`, and not ending with `.` (a chat app trims a full stop after a pasted link). Inner spaces,
  `& ( ) ' , + = ! @ $ [ ] { } ^ ~`, a leading dot or `-` and Windows device names (`con`, `nul.txt`) are names.
  `NameRule` gives the chain's first failed check in its own order: `empty` / `too-long`, `reserved-prefix`, then
  from the first byte `reserved-character` (one of the twelve), `excluded-character` or `malformed-utf8` (with `at`,
  the scalar's index), then `trailing-dot`, `leading-whitespace`, `trailing-whitespace`. Copy: "A name can't use
  # ? % / \ < > " | : * ; or end with a dot."
- **The fold:** `foldWord` (from `@efs/sdk` and `@efs/sdk/links`) is the interim fold (docs/design/tags-0.1.md
  section 2). An all-ASCII word goes through the evaluation's white-space step (trimmed; a run of white space with the
  underscores touching it becomes one underscore), then A–Z become a–z. Any other word is left as typed.
  `checkStableWord(word)` is the write guard: a write that adds a statement refuses a word with any non-ASCII
  character that either candidate rule would change. It is MISUSE with `details: { rule: "unstable-until-ruled",
  check }`, and the copy "can't be used until the tag text rule is chosen". Apps can call it as a word is typed, like
  `checkWord`. Reads, links and taking a statement back pass such a word through.
  The fold and the guard keep the word's text stable across the ruling, not its id: topic ids can still move when the
  refused table is regenerated from the pinned Unicode version. The guard uses the engine's Unicode data, so very new
  characters can differ between engines until the pin. It is the default
  fold of the tag planners, the topic reads and `parseLink`, so a typed `Cars/Tesla` opens `cars/tesla` and its
  `canonical` is the folded link. Pass your own `fold` to override it, or `fold: null` to `parseLink` for the grammar
  alone. It is marked interim until Q53: the ruled rule replaces it, extending it and never contradicting it.
- `parseLink(input, { fold? })` returns `{ status: "OK", target: ObjectLink | PathLink | RevisionLink | HomeLink |
  TopicLink, canonical }` or an INVALID result. `{ status: "INVALID", rule: "bad-word", segment, word, detail, code?,
  foldRule? }`: `word` is the refused segment as the link spelled it (percent-decoded, not folded), so a page can say
  which word; it may hold the characters that broke the rule, so show it escaped or isolated. `{ status: "INVALID",
  rule: "bad-name", segment, detail }`: `detail` is the `NameRule`. Any other rule: `{ status: "INVALID", rule,
  segment? }`. For `bad-word`, `code` is the chain's own refusal code (`checkWord`: 1 length, 2 malformed UTF-8, 3 an
  ASCII character other than a–z, 0–9, `-`, `_` and `.`, 4 ends with `.`, 6 address-shaped, 7 a refused character, 9
  starts with `-`; 5 is unused since the list release), present whenever the word grammar refused. `detail` is a
  closed union, `WordDetail` (and `WORD_DETAILS` at runtime), so a message map keyed on it (`Record<WordDetail, …>`)
  makes a rename a type error: `length`, `malformed-utf8`, `slash`, `control`, `forbidden-ascii` (code 3: `~` and every
  other ASCII symbol; letters of other scripts and emoji are not ASCII, and the word rules judge them), `unfolded` (a
  caller's fold left a capital or a space), `trailing-dot`, `leading-dash`, `address-shaped`, `refused-character`, and
  `fold-refused` when the caller's own fold refused the segment (its rule in `foldRule`, no `code`; `foldWord` never
  refuses).
  - **A link names only words the chain can hold:** what the fold produced must pass `checkWord`, the chain's whole
    word grammar. So a bidi override, a zero-width joiner, a no-break space, a soft hyphen, a variation selector, a
    C1 control, a noncharacter or a backslash makes the link INVALID, never a page for a word that can't exist.
  - **Grammar only (`fold: null`) applies only the fold-independent rules** (length; a slash, an ASCII control or
    any other ASCII but a–z, A–Z, 0–9, a space, `-`, `_` and `.`; a trailing `.`; a leading `-`; the address
    shape). What the chain refuses in typed text depends on the fold: the recommended rule for Q53 (NFKC_Casefold)
    removes bidi controls and joiners, so a link refused under the interim fold may name a real word under the ruled
    one. A grammar-only parse has no `words`, and every read and planner folds and checks the word in full before it
    becomes an id: a read by words refuses a word `checkWord` refuses with MISUSE, before any request.
  - **Kinds:** every first segment starting with `~` is the system's (only `~efs` is defined); a first segment that
    is an address (`0x` or `0X` and exactly 40 hex digits) is a home; anything else is a topic (tag model spec §5), a
    first segment such as `0xsplits` or `0x` and 41 hex digits included (the gateway answers those 501, as it does
    every topic path). The shared root has no named link (no
    `~root`), and `~home` is never defined: both are INVALID with rule `reserved-name`, like any other `~` segment.
- **Path links** (`PathLink`, kind `path`): names after an object id are a path from that folder. It is its own
  kind, never an object link with names, so a router that only opens objects can't open the folder in place of the
  entry the link names. Without names the link is an object link, and `link()` refuses a path link with none. The
  string can't say whether the id is a folder, so the reader decides. `openPath(efs, link, { reader?, base? })` in
  `@efs/sdk/files` does it, so no client can open a file id that has names, or leave the creator out of the Lens:
  1. `openObject(efs, link.folder)`;
  2. on FOLDER, `resolvePath(efs, { from: open.folder, segments: link.names }, { lens })`, with `lens` the link's,
     used as it is, else `efs.lens.place({ reader, owner: open.folder.owner, base })` (the reader, then the folder's
     creator, then `base`, by default the client's default Lens);
  3. any other answer, a file included, makes the link INVALID: a file has no names below it.

  A revision link takes no names (rule `bad-id`). The app links and the web3:// gateway share this grammar
  (planning D12). One trailing "/" is ignored, an empty segment is refused, and each segment is percent-decoded once
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
  whole-file stream also checks the author's sha256 claim at the end, so it can never disagree with `readBytes`.
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
// The HEAD law: the revision a file's HEAD names must carry that file in its own file word. A HEAD bound to another
// file's revision (the ledger admits one until the tag release refuses it) is INVALID, never that file's bytes; the
// same for a revision link whose `file` the revision does not name. planEditFile always reads its base at the basis
// and answers UNKNOWN (with the INVALID reason) for such a base, whether or not a media type is named.

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

### Everyone's versions of a file (`fileVersions`, 0.1)

`fileVersions(efs, { kind: "file", subject }, { lens?, cursor?, limit?, includeRemoved? })` reads, at one block, every
author's version of a file from the contracts' `head-authors` list (contracts 04526b1 item 49; tag model spec §3.9).
The list holds one entry per author's FIRST HEAD statement of either sign, in order: creating the file, saving one's
own version of another's, or a first "not this". Anyone can add an entry with one HEAD statement, so it is a public
tier. The result has four parts:

- **`decision`**: what the file shows under the Lens, from the same LensReader walk `openFile` uses. The first Lens
  author with a BOUND or MASKED head decides; UNSET and RELEASED heads fall through. `{ kind: "version", author,
  revision, lensIndex }`; `{ kind: "hidden", author, lensIndex }` (a Lens author's MASKED head, their own version
  hidden or a lone "not this": "hidden for you by" them); `{ kind: "none" }`; `{ kind: "unknown", reason }` (a head
  that couldn't be read, never shown as "none"). Pass the Lens the file was actually opened under, an app's fallback
  Lens included ("you, then its creator, then that Lens"): only then is `decision` what the file view shows.
- **`lens`**: each Lens author's own version, in Lens order, with `lensIndex`. These are kernel reads, exact whatever
  the list's coverage. A Lens author never listed: one with no head, or one who only ever said "not this".
- **`creator`**: the creator's version (the subject's CREATE principal, never list position), when the creator is not
  in the Lens. A view shows it after the Lens tier and before the public tier.
- **`public`**: everyone else, newest first author first (by first HEAD statement: an edit writes nothing to the
  list, so "most recently edited" can't be read from it). Lens authors and a creator shown apart are skipped.
  `{ status: "UNKNOWN", reason }` unless the index vouches for the list (coverage COMPLETE): then there are no rows
  and no counts, never "no other versions" or "1 version". Otherwise `{ status: "PRESENT", rows, total, live, count,
  scanned, changed, next? }`:
  - `live` is everyone's standing versions, the "N versions" a view shows. `count` is the authors who ever made a
    HEAD statement on the file, of either sign: never a count of versions, and nothing should be derived from
    `count − live`, which mixes lone noes, hidden and removed versions, and which anyone can raise cheaply.
  - `total` is the standing public versions: `live` less the Lens authors' and the shown creator's standing ones.
  - Paging is by absolute list position: each call scans at most `limit` entries (1 to `MAX_VERSIONS_PAGE`, 150, the
    default) from the cursor's position toward the list's start, so appends never shift a page. Lone noes and
    removed versions are filtered after the read, so a page can be short or empty while `next` is set: only a
    missing `next` is the end. The scan ends early once every standing public version has been returned, unless
    `includeRemoved` is set (removed versions can lie further back) or the list moved since the first page.
  - `changed`: the list's `count` or `live` differs from the first page's (the cursor carries them): the scan
    carries on, and the view can offer a refresh. A remove and a restore that cancel out are not seen.
- **Rows**: `{ author, state: "PRESENT", revision, creator }` for a standing version; with `includeRemoved`, also `{
  author, state: "MASKED" | "RELEASED", creator }` for a version hidden or taken back, with no revision (its head
  names none; no history is read per row). An author who only ever said "not this" (targetKind 0) is never a row.
- `ABSENT_PROVEN`: the subject was never created. `UNKNOWN`: the deployment isn't verified, every endpoint is behind
  (`BEHIND`), or the reads failed. A cursor for another file, Lens or `includeRemoved` setting is MISUSE.

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

### The gas limit a send sets (0.1)

`send` (and a local account's signature) sets the transaction's gas limit from `eth_estimateGas` on the exact call
and the deployment's fee profile (`gasLimitOf`). A size refusal is NOT_SENT `OVER_TX_GAS_CAP` (`retry:
"after-replan"`, `gas: { estimate, cap, suggestedParts }`): nothing is sent, so split the save and send each part.
- **prague and osaka** (EIP-7825 caps tx.gas itself at 2^24): 25% over the estimate, at most the cap. An estimate
  over the cap is refused.
- **amsterdam** (EIP-8037, the state-gas reservoir). `reservoirProfile(deployment)` decides it, by the vendored fee
  schedule alone: a schedule with `executionGas` has the reservoir; a chain with no vendored schedule does not.
  - **What the cap bounds:** only the execution part. The rest of tx.gas, above 2^24, is the reservoir that state
    gas is drawn from first, and tx.gas may go up to 2^32 − 1. So the limit is **never clamped at 2^24**: a deep
    first tag (about 3.3M execution + 14.4M state) clamped there would pay its state gas out of its execution budget.
  - **The limit:** at least the estimate × 1.25, and at least the planner's whole gas × 1.15. Once that is over
    2^24, at least 2^24 + 1.15 × state gas, so the reservoir alone holds the state gas and the execution budget stays
    whole.
  - **The ceiling:** at most 2^32 − 1 and the deployment's `chain.blockGasLimit`. A block includes a transaction only
    while tx.gas is within its state gas still available. Any limit at or above the whole gas runs (state gas spills
    from the reservoir into execution gas); only the margin is lost.
  - **Refused:** when the execution part is over the cap (the estimate less the planner's state gas, or the planner's
    own execution figure), or when the planner's whole gas can't fit the ceiling.
  - **Why both readings:** a Glamsterdam node's eth_estimateGas counts state gas (measured on Sepolia below), and the
    rules are safe under either.
  - **The planner's figures:** a plan carries them as `plan.plannedGas` `{ execution, total }` (from
    `PlanInput.gas` / `.total`, which every planner's parts set; `total − execution` is the state gas; not part of
    the plan's id). A plan without them (`planActions` on bare actions) gets the estimate × 1.25 under the same
    ceiling and is not refused for size: a node estimates only a limit that runs.
  - **Funds:** the account must hold limit × maxFeePerGas up front. A large-state save asks for a limit well over
    2^24 (about 33M for the deep first tag), though only the gas used is paid.
  - **Sepolia runs Glamsterdam** (since 2026-11). The contracts dev measured it there on Geth 1.17.9 and reth 2.11.0,
    with read-only calls (contracts `tools/state-gas-probe.mjs`, results in `docs/GAS-SCHEDULES.md`):
    - over 2^24, a transaction starts with exactly the cap less intrinsic gas, and its state gas comes from the
      reservoir;
    - `eth_estimateGas` returns execution plus state gas, above 2^24 when it needs to be (22,204,258 for 200 fresh
      slots), the same on both clients;
    - a plain call's intrinsic gas is 15,000 there, so the headroom check's 21,000 is on the safe side.
  - **Never read the cap or the reservoir from plain `eth_call`:** Geth does not cap ordinary gas there (reth does).
    The SDK doesn't: the limit comes from `eth_estimateGas` and the gas model.
  - **A v2 deployment on Sepolia runs the amsterdam schedule, while the fixture runs prague.** The profile comes from
    the deployment document's `chain` block, so a Sepolia document must name `amsterdam` (`feeSchedule`, or
    `hardfork` alone). A name this SDK has no schedule for is refused by the planners (`UNSUPPORTED_PROFILE`), and a
    send keeps the 2^24 clamp, refusing an estimate over it.
  - **What hasn't run yet:** the SDK's own send path on Sepolia, because no v2 deployment exists there. The fixture's
    deployment named amsterdam tests it through the send path, and Foundry's amsterdam profile has no reservoir.
- **The fee-schedule check:** a client confirms that the chain prices storage the way the deployment document says,
  before its first plan or send. A document naming the wrong schedule is the silent-mismatch shape: prague on a chain
  that prices by EIP-8037 would plan every part with the wrong model and clamp every limit at 2^24.
  - **The probe:** one deployless `eth_call` with a gas limit of 2,000,000, under 2^24, so no client holds state
    gas in a reservoir. It measures a fresh, cold `SSTORE` with `GAS` before and after. A measured opcode price is the
    same whether or not a client applies the cap to `eth_call`.
  - **Classification:** within bands of each schedule's price (`FRESH_SLOT_GAS`, from the contracts'
    `test/vectors/gas-schedules.json`): prague about 22,100, amsterdam about 110,020 (12,100 + 97,920 state gas).
    Outside every band is no known schedule, never the nearest.
  - **A mismatch:** the planners (UNKNOWN), `planPublication` (REFUSED) and sends (NOT_SENT) refuse with
    `UNSUPPORTED_PROFILE` (`retry: "never"`), naming both (`document: prague, chain: amsterdam`), with
    `reason.feeSchedule: { document, chain, freshSlotGas }`. The measured schedule is never adopted.
  - **When it runs:** on the write path only (planners, `planPublication`, `send`, batches), never on reads.
  - **Caching:** a measurement is kept per client for 10 minutes, so a chain that forks under a long-lived page is
    measured again. A failed probe is UNKNOWN for that call, measured again next time, and never kept.
  - **Cost:** one request per client per 10 minutes on the write path. Recorded save flows carry it once.
- **EIP-5792 batches:** `wallet_sendCalls` carries no gas limits; the wallet sets each call's. The SDK refuses only by
  the same rule, on the first part. On Glamsterdam, a wallet that estimates its own gas must do the same as above:
  never clamp at 2^24, and leave the state gas room above it. A wallet that clamps runs large-state parts out of gas.

### Splitting a save into publications (0.1, model-independent part)

`splitPublications(actions, { model, limits, txGasCap, headroom?, blockGasLimit?, firstWrite?, typeNames? })` in
`@efs/sdk/actions` packs an ordered list of `PlannedAction`s (`{ action, body, shape?, exists?, bindRow?, levels?,
group?, firstStatement? }`) into publications that each fit one transaction, by the contracts' planning rule
(gas/model.json `planning`). The contracts' `tools/gas-plan.mjs` is the reference, and the SDK reproduces its verdicts
on all twenty-two shared shapes of `test/vectors/floor-plan.json`, on both schedules (`test/floor-plan.test.ts`;
where a shape's vector is planned with a short list the SDK is held to the reference given the same actions without
the count, and plans the same batch).
- **Batch limits** come from the kernel's own checks (`LedgerCore._bounds`): actions ≤ `maxActionsPerPublication`;
  BIND, UNBIND and RELEASE ≤ `maxBindsPerPublication`; summed body bytes ≤ `maxBodyBytesPerPublication`; each
  body ≤ `maxBodyBytes`.
- **The rule:** a publication is planned when it is inside the limits and `max(E, V) ≤ ⌊txGasCap × (100 −
  headroomPercent) / 100⌋` (14,260,633 at 2^24 and 15%):
  - **E**, the model's execution estimate (release.json `gasModel`, generated as `GAS_SCHEDULES`): `fixed + Σ
    actions`, plus `firstWriteSurcharge` on the first part. A new PUBLISH is `publishNew[shape] + perWord ×
    ceil(bytes/32) + perByte × bytes`, with shapes keyed as the release keys them (`files-child/1 form 0`,
    `files-content/1 carrier 2`, …). A bind-kind action is priced at its `bindRow` (`bindHeadFresh`,
    `bindFolderRebind`, `unbindFolder`, `releaseFolder`, `bindTagFresh`, `unbindTagLone`, …, plus a first tag's
    per-level `levels`), or the dearest row of its kind when unknown, its tiers included. The 15% headroom covers
    the 21,000 intrinsic gas, the calldata and the model's largest under-prediction of the gas the cap counts
    (`maxUnderErrorPercent` on prague, `maxUnderExecutionErrorPercent` on amsterdam; an over-prediction only plans
    less than the cap allows).
  - **The list tiers** (gas/model.json `laterLists`, contracts 6d11858; the list release adds the after-no and label
    restore tiers): a later statement (a mask, release, restore
    or re-bind) costs more when the author's list at its place (purpose, subject) is long, or when it is the first
    later statement at that place in the publication. The SDK never passes the author's entry count: a count read
    when the save is planned goes stale as soon as an earlier part of the same save, or another tab, lands at that
    place, and a stale low count under-prices by up to about 21%. So every later statement whose row has long tiers
    (TAG and FOLDER hides, removes, restores and yeses after a lone no; PROPERTY, SAME and BROADER masks, releases,
    restores and yeses after a lone no) is priced at
    the long tier: `<row>LongNewPlace` for the first later statement at its place in the part, `<row>LongSamePlace`
    after it. A re-bind (a tag's number change, a folder entry pointed elsewhere) never searches the list and has no
    long tier: `<row>NewPlace` when first at its place, else its row. HEAD statements have none. "First at its place"
    is worked out for each part the splitter weighs, so a re-cut or re-split part is priced on its own. This moves no
    largest batch: those batches are bound by V, not E (checked with the contracts' own planner on every later row,
    both schedules, count known or not). What it costs: on amsterdam a part's gas limit is at least 1.15 × the
    model's total, so it can be about 25% above what a save of tag masks uses. The person pays only the gas used,
    but the wallet must hold enough for the limit.
  - **Later rows by head, corrected by position** (gas/model.json `laterRows`, contracts 04526b1, the list release).
    The planner chooses each later statement's row from the head it already reads (`state`, and `targetKind`, which
    `headsAt` serves as stored): an UNBIND or RELEASE is `unbind<P>` / `release<P>`; a BIND on a BOUND head is a
    re-bind; a BIND on a MASKED or RELEASED head is `bind<P>AfterNo` when the head never bound (`targetKind` 0: a lone
    no, perhaps released or followed by another no; the row carries the kernel's fresh target slot) and `restore<P>`
    otherwise. The FOLDER, PROPERTY and HEAD restores are measured placing a NEW target (the kernel's rewrite of the
    stored target is in the row and in `floor.kernel`), so a restore of the same target is over-priced by about 2,900
    gas on prague and 10,100 on amsterdam, the safe side. A label set again after its removal is a restore, never the
    re-bind row (and the work model's later class, not the re-bind class).
    Each later row is measured at one position of its binding (`laterRows.rows[key]`: masks, releases, re-binds and
    yeses after a lone no as the 2nd statement, where the binding's history word opens; restores as the 3rd, where
    none does). A statement at another position is corrected by `historyWordOpen` (17,100 on prague; 97,920 of state
    gas and none of execution on amsterdam; no kernel share), both ways: added where the statement opens a word (head
    revision before it 1 or a positive multiple of 5: the 2nd, 6th, 11th, 16th … statement) and its row's did not,
    subtracted where its row's did and it opens none. The position is the statement's own `expectedRevision`, which
    the kernel checks exactly (`E_CAS`, nothing written), so a correction made from a stale revision is refused on
    chain and never admitted under-priced. A row with no `bindRow` takes the dearest of its kind, its tiers and
    position included.
    Every restore and yes-after-no row is measured with its target's backlink list at a word-opening count, which a
    planner cannot see; elsewhere it over-prices by one fresh slot (prague about 17,100; amsterdam 97,920 of state
    gas). So for these shapes the model's total can be up to about 1.18× of what amsterdam measures (its stated
    `maxOverErrorPercent` 18.42%, tag restores at revision 5); a gas limit taken from the total is that much above
    the gas used. The person pays only the gas used.
  - **V**, the visible gas the kernel's floor needs: `max(K + prefixNeed(P), E) + ⌈F·64/63⌉ + kernelTail`. K is the
    kernel's own share of E (`floor.kernel`, the same model fitted with the index's callbacks removed). P and F are
    the kernel's own quote (`kernelQuote`: prefix floor, final reserve, fresh slots, rewrites; work model formula
    3), priced with each Type's references and digest specs (`floor.types`) and, for each BIND, UNBIND or RELEASE,
    the work model's row of its class: a first statement (a bind is one unless its row is a later statement's;
    `firstStatement` overrides), a re-bind (a BIND on a BOUND head: `bindHeadRebind`, `bindFolderRebind`,
    `bindTagNumberChange`, `bindPropertyRebind`), or another later statement (a mask, release or restore; a RELEASE
    always). A later BIND with no row takes the larger of the re-bind and later rows, field by field. The surcharge's
    row of the same class is added when the action's purpose equals the work model's `surchargePurpose` (the kernel's
    own test, zero included; since the list release the surcharge is HEAD's: a first HEAD statement adds 10 fresh,
    10 rewrites and 4,500 compute, a later one 0, 10 and 10,000, for the everyone's-versions list), and every WITHDRAW
    after the first adds the later row.
  - `SplitPart.rule` keeps E, K, V and the quote; `SplitPart.gas` is the figure shown to people (the model plus
    intrinsic and calldata gas). `packBatches` sums each part's max(E, V) with its intrinsic and calldata gas, since
    each call in an atomic batch must still find its own floor.
  - `kernelQuote(actions, floor, { noPrincipal: true })` (`@efs/sdk/actions`) equals `LedgerIngress.indexFloor`,
    which has no principal and so prices every bind at the largest of the three rows, field by field: an upper bound,
    never planned from (tested against the chain).
  - **The deployment must price the floor the same way:** `gasPlanFor` refuses (`UNSUPPORTED_PROFILE`) when the
    deployment's `index.workModel` (32 words, `surchargePurpose` compared as a word) or floor limits differ from the
    gas model's in any field, or the formula is not 3.
  - Why it matters: on the release before this one (120,000 gas of final reserve per bind), 64-entry removes and
    moves were planned at about 9M gas and needed 18.9M to 22.2M, over the cap. This release reserves 7,400 per bind,
    and the rule fits each part to what the kernel actually checks. Formula 3 (contracts 6d11858) prices later
    statements at their real spend; the list release raises the later row (30, 50, 78,000), so prague's tag masks and
    releases plan 54 to a part (58 at 6d11858, 64 before) and restores 48 (51, 60); amsterdam 54 and 50. Re-binds stay
    (62 on prague, 64 and 61 on amsterdam); new files plan 9 a part on prague (10) for the HEAD surcharge; yeses after
    lone noes 45 and 48. These are corrections, not regressions.
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
- **Fewer approvals where they fit:** an atomic EIP-5792 wallet (`wallet_getCapabilities` reports atomic) gets
  consecutive remaining parts in one `wallet_sendCalls` request, but only while their summed gas fits ONE
  transaction (`packBatches`). An atomic batch may run as a single transaction (EIP-7702 and ERC-4337 accounts run
  it that way), so it is under the same per-transaction cap as one part.
  - Content parts each nearly fill a transaction, so they still go one at a time: a 5 MB file is about 324 parts
    and 324 approvals today, batch or not. Batches help when a save was split by the per-publication counts (64
    actions or binds, 16 KiB of body), not by gas.
  - Under the Glamsterdam schedule, where the cap counts only execution gas, a batch's whole gas must also fit
    the block budget; with no block gas limit in the deployment document, nothing is batched. With no gas model
    for the chain, nothing is batched either.
  - Only a batch's parts are pre-planned with consecutive native nonces.
  - **A failed batch makes the rest of that save's batches smaller.** The limit is kept on the sequence record
    (`batchMax`), so a retry or a resume never sends the same batch again.
    - It is halved when the wallet refuses the batch as too large (5740), answers an error it gives no reason
      for, or reports the batch failed (status 400 or above).
    - It drops to part by part when the wallet can't batch (4200, 5700, 5710, 5760, -32602) or the person
      declines the account upgrade (5750).
    - A refusal before anything went out (5740, or a wallet that can't batch) goes on at once in the smaller
      batches. Anything that may have gone out waits for reconcile as always.
    - A batch whose first part alone is over the per-transaction cap goes part by part from there, where the part
      can be re-split (below).
- **A part too large for one transaction is re-split, never lost.** The planners can't see how long the lists a
  statement lands in are. So a part planned full (say 58 tag masks on lists past the floor's claimed length) can
  need more execution gas than planned. Its estimate is then over 2^24, and the send is NOT_SENT
  `OVER_TX_GAS_CAP` before anything is sent.
  - **When it is cut:** `runSequence` and `resume` cut that part themselves, and go on, only when all of these hold:
    - **It has units:** the part carries `units`, the runs of actions that must stay together. The folder and tag
      planners record them. A part has none when it is a file's content (planned to the cap already) or was written
      before units existed.
    - **It never reached a wallet:** no attempt of its plan got past PLANNED or NOT_SENT.
    - **Within the bound:** at most 6 levels of re-splitting (`MAX_SPLIT_DEPTH`).
  - **How it is cut:** only between units, never inside a folder entry's move or between a statement and its
    registration, into `reason.gas.suggestedParts` pieces (at least 2) of near-equal unit counts, in order.
    - Each piece carries its units' effects, renumbered (`args.part` / `args.parts`), and no gas figures.
    - Each is planned just in time and prompts once. The refused part never reached the wallet.
    - The pieces' actions differ from each other and from the refused part, so the twin guard never holds one as
      another.
  - **What the person sees:** `SequenceProgress.total` grows mid-save ("approve part 4 of 6"). The record's history
    says why: "part 3 was too large for one transaction: split into 2".
  - **When it can't be cut:** the save stops as before (NOT_STARTED or PARTIAL), with `reason.gas`
    `{ estimate, cap, suggestedParts }` so a page can say "this needs N publications". A part of one unit (a single
    statement or entry over the cap) stops with `retry: "never"`.
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
  part that is not sent), `{ kind: "wallet-answer"; parts; reason }` as soon as a send comes back AMBIGUOUS after
  the wallet or its node answered (INSUFFICIENT_FUNDS above all, so the page can show "Your wallet needs enough to
  cover the gas limit" at once while the save checks the ledger for its settle window; also WALLET_DISCONNECTED,
  WALLET_CHAIN_DISCONNECTED and RESPONSE_LOST, and only these: `WALLET_ANSWER_CODES`, an allow-list, so a new
  AMBIGUOUS code reports nothing until someone decides it should; `reason.code` is typed `WalletAnswerCode`), or
  `{ kind: "committed"; index }` as each part commits. Narrow on `kind` for each: a handler written as
  "wallet-request, else a part index" must handle the new kind. It is advisory: not awaited,
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
- **One publication, one wallet request:** within one `runSequence` or `resume` a part is planned once, and resume never
  sends a part that is in flight. A second save of the same parts (a double submit, or the same parts saved again)
  is planned afresh, with a new plan id. Before the wallet, the journal checks it under the account's lock, for
  single parts and batches alike:
  - **While the first attempt is open** (SUBMISSION_POSSIBLE or SUBMITTED, or COMMITTED and not yet final):
    - the send is NOT_SENT and the save is NOT_STARTED, with reason ALREADY_ATTEMPTED (`retry: "after-reconcile"`);
    - the reason's `twin` names the earlier attempt, `{ planId, stage, sequenceId? }`, with `sequenceId` when the
      journal holds its save;
    - settle that one with `reconcileSequence(sequenceId)` (or `reconcile(planId)`), keep it tracked, and abandon the
      second.
    A committed attempt is held until it is final because a PUBLISH repeats without a revert: the record only gains
    an occurrence. A part of PUBLISHes alone would otherwise go out a second time.
  - **Once the first is final:** the journal lets go. Every planner part that binds, masks, releases or creates is
    refused by the ledger in simulation, so the save is STALE: E_CAS for BIND, UNBIND and RELEASE (each carries the
    revision it expects), and E_SUBJECT_EXISTS for a CREATE with the same salt. A part of PUBLISHes alone is not
    refused: saved again after its first attempt is final, it goes out, and its records gain an occurrence each
    (their bytes and ids don't change).
  - **NOT_SENT with ALREADY_ATTEMPTED means "this call sent nothing", never "nothing was saved".** The twin may
    land, or have landed already.
  - **When the hold ends:** a twin left at SUBMISSION_POSSIBLE (a tab that crashed, or a wallet popup whose answer
    was lost) holds the same publication until someone reconciles it. Reconcile then decides it from the ledger:
    COMMITTED (the ledger refuses the repeat, as above), or NOT_COMMITTED_PROVEN once its deadline has passed, and
    then the repeat may go out.

  Only the same publication (the same actions and bodies) from the same account is held back. Any other save goes
  out as usual.

  **Two different saves can share a publication.** A part of PUBLISHes alone is the same publication whenever the
  same bytes are saved twice: one image into two folders, or a big file uploaded again. The second save's identical
  part is then held too, until the first save's part is final.
  - `twin.sequenceId` tells the cases apart: the save the person just started again, or another save of the same
    bytes.
  - The planner publishes each record once per save (a repeated chunk or subtree is published at its first
    occurrence), so a save is never held by its own parts.
  - Final means the admission's block is at or below the endpoint's `finalized` block. On anvil (the fixture and
    local chains) that tag is 2 × 32 slots behind the latest block, 64 blocks. Anvil mines one block per transaction,
    so on a quiet local chain a hold lasts until 64 more blocks are mined. On Sepolia and mainnet it is about two
    epochs, roughly 13 minutes.

  Plan-time reuse (not built: LIMITATIONS.md) will satisfy such a part without a send.
- **Each part keeps its `deadlineSeconds`:** it is applied each time the part is planned, including on resume.
- **Wallet errors:** NOT_SENT only for errors that mean the request was refused before signing; the attempt is
  stamped NOT_SENT, so nothing waits on it. They are 4001 USER_REJECTED and 4100 WALLET_UNAUTHORIZED
  (`retry: "transient"`), and 4200 WALLET_UNSUPPORTED and -32602 WALLET_INVALID_PARAMS (`retry: "never"`: the same
  wallet request will not work; for wallet_sendCalls, the save goes on part by part). EIP-5792's own refusals of
  wallet_sendCalls are NOT_SENT too: 5740 LIMIT_EXCEEDED (`retry: "after-replan"`: smaller batches), 5700, 5710
  and 5760 WALLET_UNSUPPORTED, and 5750 USER_REJECTED (`retry: "transient"`: part by part). A disconnect, 4900
  WALLET_DISCONNECTED or 4901 WALLET_CHAIN_DISCONNECTED, can be raised after the wallet relayed, so it is AMBIGUOUS
  with that named reason (`retry: "after-reconcile"`: "Your wallet lost its connection; checking whether the save
  went out"), as is any other wallet error or a lost response: the part stays in flight until reconcile decides.
- **Insufficient funds:** a wallet or node that refuses the transaction because the account can't cover its gas
  limit at the current fees (the words "insufficient funds" in the error or one nested in it, whatever its code, on
  eth_sendTransaction, wallet_sendCalls or a local account's eth_sendRawTransaction) is AMBIGUOUS
  `INSUFFICIENT_FUNDS` (`retry: "after-reconcile"`): the refusal comes after signing, and a wallet that queued the
  signed transaction could still send it. A single send carries `reason.funds.gasLimit`, the limit it asked for; a
  batch carries none (the wallet sets each call's gas) and keeps its batch size. The detail says "the wallet needs
  enough to cover the gas limit of N; a save is charged only the gas it uses", and the copy should say the same: the
  limit, never the cost. The part stays in flight, and the attempt's journal entry records the refusal
  (`history[].refusal: "INSUFFICIENT_FUNDS"`).
  - **Sending it again is the same plan.** Once the account is topped up, Send again (`resume(sequenceId)`, or
    `send(plan)` with the same plan) sends the same plan, with the same ledger nonce and digest. It goes through the
    account lock, the twin guard and the estimate like a first send; the only rule relaxed is "this plan id is never
    sent twice". It applies only when the attempt's latest entry is the funds refusal and no wallet ever returned a
    hash for it (`fundsResendable`). Every other attempt in flight (a lost response, a disconnect) still waits for
    reconcile. A local account's refusal counts only when it came from the first endpoint that took the signed
    transaction: after a transport failure the original may be out, so a later endpoint's funds answer is a lost
    response.
  - **If the wallet had queued the original** and it landed meanwhile, the resend's estimate fails (`AlreadyAdmitted`):
    STALE, nothing is sent, and reconcile finds the attempt COMMITTED. At most one of them is ever admitted.
  - **Near the deadline:** with under a minute (`RESEND_MARGIN_SECONDS`, 60) between the latest block and the plan's
    deadline, it is not sent again; it waits for reconcile, then EXPIRED, then Send again with a new plan.
  - A save sent as an atomic batch goes again part by part, each part as its own same plan.

  A wallet that
  disables its confirm button instead (MetaMask) leaves the person only Reject, which is a plain 4001
  USER_REJECTED. eth_estimateGas is never asked with fee fields, so it never answers for funds.
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
  `content` is bytes or `{ kind: "external", length, sha256, locator }`. An external locator nobody could read is
  MISUSE before anything is read or sent (`details.why`: MALFORMED, UNSUPPORTED_LOCATOR); check one as it is typed
  with `checkLocator(locator)` (`@efs/sdk`). A location a reader's policy blocks (https off, no gateway named) is
  still writable: read policy is each reader's. Bytes that fit one record body
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
  `layout` (`inline` | `chunk` | `span` | `external`), `mediaType` (`""`: none), `parts`, `prompts { sequential, atomicBatch }` (approvals part by part, and with an
  atomic EIP-5792 wallet: the number of gas-packed batches, often equal to `sequential` for content),
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
explicitly: there is no default root, and no link format names one. A path link names its starting folder by id
(`~efs/o/<folder>/<name>/…`, opened with `openPath`), and the Realm's shared root is reached that way like any other
folder. `openObject(efs, id, { lens? })` says what an
object link's id is, in one batched read: a folder record is `FOLDER { folder, owner }`, a created subject is
`FILE { file, creator, open }` (opened under the Lens), anything else `ABSENT_PROVEN`; a record of another Type is
INVALID. The kind is fixed by the id, so the answer never changes. The kind read carries the file's HEAD read in the
same batch (discarded unless the id is a file), and `open` is read at that basis on that endpoint with every openFile
check, so a file link costs the round trips of openFile alone. The kind decides routing, so once an endpoint has read
it and its HEAD or revision read then failed the way a healthy endpoint can (unreachable, a JSON-RPC error, or a
different basis), a read that fails on every endpoint still answers `FILE` with `open` UNKNOWN ("couldn't load, retry"
on the file's own pane). An endpoint whose reply failed validation in that read is not consistent, and its kind is
dropped. The whole answer is UNKNOWN when no consistent endpoint read the kind, or when endpoints disagree on it.
`efs.lens.place({ reader, owner, base })` builds a place's
Lens: the reader, then the owner (`FolderRef.owner`; `owner: null` leaves it out), then `base`, each once.

**Homes.** Wherever a folder parent is taken, a home is too: `{ kind: "home", address }` (`HomeRef`; the union is
`ParentRef`). A home is an address as a folder parent: its entries are FOLDER bindings at the left-padded address,
the word the gateway's `/0x<address>/…` serves (FilesFinalValidator admits an address-shaped parent), so anyone can
attach files and folders to anyone's address and the Lens decides whose show. A home always exists (any address but
zero; zero or a malformed address is MISUSE), so it is never ABSENT_PROVEN or INVALID: an untouched home is an empty
COMPLETE page. Its `owner` is the address's author identity at the read's block, the gateway's `Keys.principalFor`:
the key principal (the padded address) of a key account, an EIP-7702 account with exactly the `ef0100 ‖ address`
designator included, and the Realm's contract principal of a contract, so a Safe's home shows the Safe's own entries.
It is true only as of that basis and can change: a counterfactual Safe's address is a key home until code lands
there, and a key home again if the code is removed (the standard 7702 designator keeps the key owner). Never cache it
across bases. The SDK reads it with one deployless probe in the same batch. `openHome(efs, address, { reader?, base? })` → `PRESENT { home (with owner), lens }` | `UNKNOWN`: the Lens to
show a home under is the reader, then its owner, then `base`. `openPath` takes a `HomeLink` with names
(`/0x<address>/photos/cat.jpg`) the same way, under the link's own `?lens=` (then it reads no owner first) or that
default. An address-shaped word (12 leading zero bytes) given as a folder's `directory` is MISUSE: it names a home. Every write planner
takes a home as a parent (create, move to or from it, `via` from it, remove, restore, hide, unhide), and
`listRemoved` lists a home's removed entries. In effects and reviews' `folder` words a home is its padded address.

**Kinds, one vocabulary in every view** (`VIEW_KINDS` and `ViewKind` from `@efs/sdk`). The same `kinds` array works
in `listFolder` (folders and homes), `topicItems` and `topicItemsMerged`, so one filter control serves them all. A
kind that can't occur in a view matches nothing there, and is counted with what the filter left out
(`skipped.filtered` in folders, `counts.filtered` in topic pages). A string outside the vocabulary is MISUSE: a typo
is never a filter that matches nothing, which a scan from the start would report as COMPLETE and empty.

| kind | folders and homes (`listFolder`) | topic pages (`topicItems`, `topicItemsMerged`) |
|---|---|---|
| `file` | a subject whose HEAD under the Lens is a Files revision | the exact tier: the creator's HEAD names a Files revision (`file` turns the tier on) |
| `folder` | a files-directory/1 record | a files-directory/1 record |
| `other` | a subject with no Files HEAD under the Lens | any other record (its `typeId`), or, with the exact tier, a subject that is not a file |
| `subject` | never | a created subject before the exact tier (can't be asked for with the tier on) |
| `revision` | never | a files-root/1 or files-child/1 record |
| `topic` | never | a topic-word/1 or topic/1 record |
| `address` | never | a padded address |
| `invalid` | a row that breaks a Files rule | never |

**Reads** (`@efs/sdk/files`, all at one block):
- `listFolder(efs, folder, { lens?, kinds?, limit?, cursor?, withSize? })` → `PRESENT { folder, rows, skipped,
  coverage, next? }` | `ABSENT_PROVEN` (no such folder: never "empty") | `UNKNOWN` | `INVALID`. One row per name.
  A row has `name`, `position`, `kind` (`folder` | `file` | `other` | `invalid`), `typeId` (files-directory/1, or the
  HEAD revision's Type), `target`, `author`, `admission`, `head?` and, with `withSize`, `size`. `kinds` is a kind
  filter run by the SDK, counted in `skipped.filtered`; names an earlier author hid are `skipped.hidden`. In this
  generation the chain admits only files and folders as entries, so the kind is the Type. `coverage` is COMPLETE only for a listing scanned from its
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
  ABSENT_PROVEN. Each segment follows the Lens's choice, with its author in `chain`. Every folder on the way
  carries its creator (`owner`, on each step's `folder` and on a folder `target`), read with the record that proves
  it is a folder, at no extra request. No depth limit: a path costs one
  round trip per segment, so object links are the fast (and rename-proof) way to open a file; a path is a lookup that
  a rename or move can break.
- `openPath(efs, link, { reader?, base?, maxSegments? })` → resolvePath's answers, `INVALID` when the link's id is
  not a folder (a file included), or openObject's `ABSENT_PROVEN` (`kind: "efs.object"`) when nothing has the id.
  The Lens is the link's own when it carries one, else the reader, then the folder's creator, then `base`, and every
  answer for the names returns it as `lens`, so the entry opens under the Lens it was chosen in. `evidence` covers
  both reads.
- Each reply is cross-checked: the folder must be a files-directory/1 record, the heads' selection must be the Lens
  law's, the page and Lens readers must agree on every row, and COMPLETE must hold locally.

- `listRemoved(efs, { folder, author }, { limit?, cursor? })` ("Show removed"): one author's removed entries in a
  folder, RELEASED or MASKED, each with `name`, `position`, `state`, its binding `revision`, `removedAt`, and what it
  pointed at before (`last`, below). Lens-independent: it reads only that author's own scope list (the
  index's kind-10 list of the positions they ever bound there, in first-bind order), a page of up to 64 entries at a
  time. The live index and its bitmap store must be the ones the deployment names, or the page is UNKNOWN. COMPLETE
  only for the whole list read from its start; an empty page that is not COMPLETE is UNKNOWN, never "nothing
  removed". Restore any row with `planRestoreEntries`.
  `last` is read from the binding's history, one version at a time back from the head, at most 32 versions:
  - `KNOWN` with `target`: the target of the last BIND, which Restore binds again;
  - `NEVER_BOUND`: a hide with no earlier bind by this author. Since the tag release UNBIND is admitted from every
    state, so an author can hide someone else's entry at a name they never placed anything at (a lone hide). There
    is nothing to restore; `planUnhideEntries` removes the hide. A released name never bound is not listed at all:
    it changes no read;
  - `UNKNOWN` with `reason` (`LIMIT_EXCEEDED`): a history deeper than the walk's bound (hides and releases can now
    alternate to any depth). Only that row says so; the page stands.
  A history that breaks the ledger's rules is the endpoint's fault (`RPC_ERROR`), the read moves to the next endpoint,
  and if none answers, the page is UNKNOWN. The rules: a mask may follow a bind, a mask or a release, a release a bind
  or a mask; each version's admission is the one asked for; revisions count down by one; a first version is revision
  1 and, being a hide, names no target; a FOLDER bind's target is a file or a folder. A history that can't be read
  back is `NOT_YET_DECIDABLE`. A target is never guessed.

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
  binds. A `NEVER_BOUND` entry is refused `NEVER_BOUND` (Unhide it instead) and one whose history is too deep
  `HISTORY_UNKNOWN` (with `reason`); a history the endpoint can't read makes the plan UNKNOWN. It never binds a
  guessed target. Restoring a
  folder needs `via` (the path to its folder), with the same cycle checks as a move. Each review item carries
  `alsoPlaced`: how many live placements point at the target now, by anyone (the index's backlink count, from the
  generation the ledger names). Above 0, restoring puts it in one more place, for example after it was moved. Null
  when the index can't vouch.
- `planUnhideEntries(efs, w, { entries, lens? })`: RELEASE your own hidden (MASKED) entries, so the Lens falls through
  to the next author's entry at each name again. It answers a `NEVER_BOUND` row and works on any of your hides;
  `NOT_HIDDEN` for an entry that isn't hidden, `ENTRY_ABSENT` where you have no entry. Effect `files.unhide`.
  To test it on a chain, `planLoneHide(efs, w, { folder, name, lens? })` from `@efs/sdk/testing` plans a lone hide
  (the name record when missing, then an UNBIND at your revision there; review kind `"efs.loneHideReview"`, effect
  `files.hide`). It throws MISUSE unless the name is lone for you: never stated, or released after lone hides only.
  `planOtherEntry(efs, w, { folder, name, salt?, lens? })` (also `@efs/sdk/testing`) places a subject with no file
  version at a name in a folder or a home (a CREATE, the name record when missing, the FOLDER bind; review
  `"efs.otherEntryReview"`): a listing shows it as kind `other`, the junk row an owner blocks with `planHideEntries`.
- `planHideEntries(efs, w, { entries, lens? })`: hide other authors' entries (a folder owner hiding spam, say): an
  UNBIND, a mask, at your own position at each name, after the name record if it is missing. Nothing shows there for a
  reader whose Lens puts you before the entry's author; a reader who ranks that author first still sees it, and the
  hide is public. The chain lets anyone mask their own position, so the SDK does not gate it by ownership: whom to
  offer it is the app's rule, as for Remove and block. Review kind `"efs.hideReview"`: per entry `shownNow` (the author whose
  entry it covers) and `shownAfter` (null when it is hidden in this Lens; an author ranked before you when your hide
  doesn't change this view), plus `notice`, one plain sentence saying what a hide does. Refused: `NAME_TAKEN_MINE`
  (your own entry: Remove and block, `planRemoveEntries` with `hide: true`), `ALREADY_HIDDEN`, `ENTRY_ABSENT` (this
  Lens shows nothing there). Effect `files.hide`; `planUnhideEntries` undoes it, and `listRemoved` shows it as
  `NEVER_BOUND` (or `KNOWN` where you once had an entry of your own there).
- Every planner writes only the writer's own positions (a hide masks yours; it never touches the other author's
  entry), each with a compare-and-swap on its revision. Refusal codes:
  `NAME_TAKEN_MINE` (your own entry holds the name), `NOT_YOURS` (with `author` and `admission`), `FOLDER_ABSENT`,
  `ENTRY_ABSENT`, `NOT_REMOVED`, `NEVER_BOUND`, `HISTORY_UNKNOWN`, `NOT_HIDDEN`, `ALREADY_HIDDEN`, `PATH_CHANGED`. A batch refuses as a whole and lists every refusal by `index`
  (a move's source and destination refusals both). A `salt` the writer already used is MISUSE. Another author's
  entry at the name is not a refusal: the review says what this Lens will show (`visibleInLens`, `shownInstead`,
  `hiddenBy`, and `shownAfter` for the place an entry leaves). Invalid names (checkName) and media types throw MISUSE
  before any read.
- `SequenceRecord.effect` names the save: `files.create`, `files.createFolder`, `files.move` (its moves),
  `files.remove` (`hide` and its entries), `files.restore`, `files.unhide` (its entries) or `files.hide` (its entries,
  each with the `author` whose entry it covers when planHideEntries knew it; planLoneHide's have none), each listing
  the names it touches, so a listing knows which folders a save changes. Tag saves: `tags.tag` / `tags.deny`
  (`topic`, `number`, `targets`), `tags.untag` (`topic`, `targets`), `tags.label` (`subject`, `lang`, `remove`),
  `tags.same` / `tags.broader` (`subject`, `other`, `remove`); a save's registration-only parts fold into its kind,
  and a save that only registers is `tags.register` (`topics`).

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

**Replays whose head follows its writes** (`@efs/sdk/testing`). `createRecorder(fetch, provider)` records both
halves and the harness's `mark(label)` in one sequence: each call, wallet call and mark gets a `seq`, in the order its
answer came back. `createReplay(t)` replays them with the chain's head moving only when the recorded event that moved
it is served:
- **What moves the head (a gate):** a wallet write (`eth_sendTransaction`, `wallet_sendCalls`), an
  `eth_sendRawTransaction`, or a `mark`.
- **Reads follow the epochs.** Every answer belongs to the epoch it was recorded in, which is the number of gates
  recorded before it. A read is served from the current epoch, in recorded order, and then repeats that epoch's last
  answer. So extra "latest" or `finalized` reads get the same head, and a pending receipt stays null until the mark
  that mined it. Answers left from an earlier epoch are skipped once the head moves. A key recorded only later is
  served its first answer, which counts as an early read. Both are forgiven and counted in `extraReads`, keyed by
  `method params-digest`: assert a budget or print them, since nothing fails on them by default.
- **Writes stay strict.** Each gate is served once, in recorded order. An unrecorded or repeated write, or a mark out
  of order, is a miss, and `finish()` turns every gate never served into a miss.
- **Old transcripts:** a transcript without `seq` is one epoch with no gates, and replays as `createRpcReplay` does.

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

## 10. Decisions from the client review (2026-11-24), as shipped

1. Every read takes the client and pins its own basis (`efs.at`, held to the read floor). The files convenience on
   the client was not built: the reads are the functions of `@efs/sdk/files`, which take `efs`.
2. Entries carry no `href`. The client's router calls `link()` (`@efs/sdk/links`).
3. Review effects are `{ code, args }` plus optional English `text`.
4. `streamFile()` (`@efs/sdk/web`) returns a pull-based `ReadableStream`; cancel or abort stops the fetches.

## 11. Earlier questions (answered)

<!-- history:start (the questions as they were asked; section 10 has what shipped) -->

1. `efs.files` re-pins a fresh `latest` basis on every call. Your list-then-open flows probably want `efs.at(...)` views. Is having both fine, or do you want only views?
2. Should a `DirectoryEntry` include an `href` (the wire link), or will you call `paths.link` yourself?
3. `review()` returns `EffectView` strings in English. Do you want message keys plus arguments instead, for your MF2 catalog? I'd lean towards keys plus arguments.
4. `stream()` returns a `ReadableStream`. Everything else is plain data. Is that acceptable for your worker plan? A stream is transferable but not clonable.

<!-- history:end -->

## Appendix: every export

<!-- export-index:start (generated by node tools/api-index.mjs write; do not edit) -->

Every name each entry point exports, with the first sentence of its JSDoc. Functions and constants always have one; a type without one is documented by the functions that take or return it, and field by field in its declaration (the published `.d.ts`). `pnpm check` fails when this list is out of date.

#### `@efs/sdk`

| Export | Kind | Summary |
| --- | --- | --- |
| `checkLocator` | function | Whether a files-external/1 locator could ever be read, by its shape alone: pure, for checking one as it is typed (as checkName is for names). |
| `checkName` | function | Check a name against files-name/3. |
| `checkStableWord` | function | Whether a word reads the same under both candidate fold rules, so writing it now can never leave text a ruling would fold differently. |
| `checksumAddress` | function | EIP-55 checksum form of an address (for display). |
| `createEfs` | function | Create a client for one EFS deployment. |
| `displaySegment` | function | Human-friendly display segment for name text. |
| `EfsFault` | class | The only thing the SDK throws: caller misuse, the caller's own abort, a bad caller-supplied limit, an attempt journal that cannot be read or written, a byte stream that cannot continue (STREAM_FAILED: a stream has no other way to report), or an internal invariant failure. |
| `FOLD_RULE` | const | The fold's name, for an app that says which fold it applied ("Saved as notes"). |
| `foldWord` | const | Fold one typed word (see the header). |
| `formatRealm` | function | The full realm form for a deployment: `eip155:<chainId>/0x<ledger, lowercase>`. |
| `fromJson` | function | Parse JSON text produced by `toJson`. |
| `link` | function | The link string for an object or revision. |
| `LINK_PREFIX` | const | The first segment of every system link (`~efs`); the name profile reserves it, so no path can look like a link. |
| `MAX_LINK_LENS` | const | The most principals a link's Lens may name (the deployment may allow fewer; reads enforce its limit). |
| `MAX_NAME_BYTES` | const | The longest name files-name/3 admits, in UTF-8 bytes. |
| `memoryByteStore` | function | In-memory byte store, least recently used first out (default 32 MiB). |
| `NAME_PROFILE` | const | The name profile folder and file names are checked against: files-name/3 (UTF-8, byte-exact, case-sensitive). |
| `normalizeName` | function | NFC, the form the SDK writes. |
| `parseLink` | function | Parse a link string from a route. |
| `parseSegment` | function | Decode one segment (wire, display or encodeURIComponent form) to exact bytes. |
| `principalDisplay` | function | How to show a principal: an account (`address`, for a key principal), one of the given contracts (`contract`), or an opaque principal id. |
| `PROTOCOL_INPUTS` | const | The contracts commit (and, once release pinning starts, the release digest) this SDK build was generated from. |
| `splitRealm` | function | Split the realm off the front of a route path (what follows `#/r/`). |
| `toJson` | function | Serialize SDK data (results, plans, journal records) to JSON text. |
| `validateDeploymentManifest` | function | Check an efs-deployment/1 document field by field: `{ ok: true, deployment }` (the SDK's DeploymentInfo) or `{ ok: false, problems }`. createEfs runs it; call it yourself to report a bad document before creating a client. |
| `VIEW_KINDS` | const | Every kind a listing row can be (file, folder, other, subject, revision, topic, address, invalid): pass a subset as `kinds` to filter a listing; a kind outside this list is MISUSE. |
| `wireSegment` | function | Canonical wire segment for exact name bytes. |
| `WORD_DETAILS` | const | Every WordDetail, for a client that wants to check its message map at runtime too. |
| `AbortSignalLike` | interface | Minimal structural AbortSignal: the DOM and Node signals both satisfy it. |
| `Address` | type |  |
| `Attempt` | interface |  |
| `Basis` | interface |  |
| `BasisPolicy` | type |  |
| `ByteStore` | interface | Exact verified bytes, keyed by content id (record id or sha256). |
| `CallOpts` | interface |  |
| `Capabilities` | interface |  |
| `ChainFacts` | interface | Chain facts the deployment document records (efs-deployment.chain): a snapshot from when the instance was deployed. |
| `DeploymentInfo` | interface |  |
| `Efs` | interface |  |
| `EfsConfig` | interface |  |
| `Eip1193Like` | interface |  |
| `Evidence` | interface |  |
| `FaultCode` | type |  |
| `FetchLike` | type | Structural fetch, so the portable core needs no DOM or Node types. |
| `FloorBlock` | interface | A block a floor holds: its number and hash. |
| `FoldStep` | type | One fold step, supplied by the caller until the fold rule is chosen: a word, or the rule the segment breaks. |
| `GatewayConfig` | interface |  |
| `Hex` | type | A lowercase-or-mixed 0x-prefixed hex string. |
| `HomeLink` | interface | A home (an address, lowercase), then folder and file names below it, which keep their case. |
| `Lens` | interface |  |
| `LensTools` | interface |  |
| `LinkParse` | type |  |
| `LinkRule` | type |  |
| `LinkTarget` | type | What `link` accepts: an object, path, revision, topic or home link, or a FileRef / RevisionRef from ` |
| `LiveDeployment` | interface | What the pin learned about the live deployment at its basis. |
| `LocatorCheck` | type | Whether a location could ever be read (checkLocator). |
| `ManifestCheck` | type |  |
| `NameCheck` | type |  |
| `NameInput` | type |  |
| `NameRule` | type | Why a name is refused, the chain's checks in its own order (FilesName.valid): the length (`empty`, `too-long`), `reserved-prefix` (`~efs`), then scanning from the first byte the first of `reserved-character` (one of `/ \ # ? % < > " \| : *` and `;`: links and EFS URL syntax keep them), `excluded-character` (a control or another excluded scalar) or `malformed-utf8`, then `trailing-dot` (a name ending in '.', so '.' and '..' too), then `leading-whitespace` and `trailing-whitespace`. |
| `ObjectLink` | interface | An object by subject id. |
| `ParseLinkOpts` | interface |  |
| `PathLink` | interface | A path from a folder named by its id (`~efs/o/<folder>/<name>/…`): that folder's object link, then at least one folder or file name, which keep their case (files-name/3). |
| `PinMismatch` | interface |  |
| `PinResult` | type |  |
| `PrincipalDisplay` | type | What a person should see for a principal (an author in a Lens, a row's `author`): - address: a key principal is its account's address, EIP-55 checksummed (the padded `0x0000…` id is never shown); - contract: a contract principal of this Realm, matched to an address you name (`contracts`, such as the Safe whose home you are showing) by recomputing it here: a contract principal is a hash, so it is never read back or guessed; - principal: anything else, as its id (lowercase): a contract principal you didn't name, another kind, the zero word. |
| `PrincipalId` | type | Compile-time brands only: plain strings at runtime, so results stay structured-clone-safe. |
| `ProtocolLimits` | interface |  |
| `ReadFloors` | interface | The floors of one instance, per policy (efs.readFloor()). |
| `RealmRef` | interface |  |
| `RealmRule` | type |  |
| `RealmSplit` | type |  |
| `Reason` | interface | Why something is unknown, unsupported or failed. |
| `ReasonCode` | type |  |
| `RecordId` | type |  |
| `RequestEvent` | interface |  |
| `RevertInfo` | interface | A contract revert, decoded only as far as the vendored contracts tables allow. |
| `RevisionLink` | interface | One exact revision. |
| `RpcEndpoint` | type |  |
| `SegmentParse` | type |  |
| `SequenceFault` | interface | Where a save stood when runSequence or resume threw, set as plain properties on the EfsFault. |
| `StableWordCheck` | type |  |
| `SubjectId` | type |  |
| `TopicLink` | interface | A topic: a path of words. |
| `TypeId` | type |  |
| `UnstableCheck` | type | Why a word is not stable until the fold rule is ruled (checkStableWord). |
| `ViewKind` | type |  |
| `WalletMismatch` | interface | The wallet moved off the plan's chain or account. |
| `WordDetail` | type | Why a topic segment is refused (LinkParse `detail` for `bad-word`): the chain's word rules (each with its `code`) and the link grammar's own fold-independent ones, or "fold-refused" when the caller's fold refused the segment. |

#### `@efs/sdk/links`

| Export | Kind | Summary |
| --- | --- | --- |
| `checkStableWord` | function | Whether a word reads the same under both candidate fold rules, so writing it now can never leave text a ruling would fold differently. |
| `FOLD_RULE` | const | The fold's name, for an app that says which fold it applied ("Saved as notes"). |
| `foldWord` | const | Fold one typed word (see the header). |
| `formatRealm` | function | The full realm form for a deployment: `eip155:<chainId>/0x<ledger, lowercase>`. |
| `link` | function | The link string for an object or revision. |
| `LINK_PREFIX` | const | The first segment of every system link (`~efs`); the name profile reserves it, so no path can look like a link. |
| `MAX_LINK_LENS` | const | The most principals a link's Lens may name (the deployment may allow fewer; reads enforce its limit). |
| `parseLink` | function | Parse a link string from a route. |
| `splitRealm` | function | Split the realm off the front of a route path (what follows `#/r/`). |
| `WORD_DETAILS` | const | Every WordDetail, for a client that wants to check its message map at runtime too. |
| `FoldStep` | type | One fold step, supplied by the caller until the fold rule is chosen: a word, or the rule the segment breaks. |
| `HomeLink` | interface | A home (an address, lowercase), then folder and file names below it, which keep their case. |
| `LinkParse` | type |  |
| `LinkRule` | type |  |
| `LinkTarget` | type | What `link` accepts: an object, path, revision, topic or home link, or a FileRef / RevisionRef from ` |
| `ObjectLink` | interface | An object by subject id. |
| `ParseLinkOpts` | interface |  |
| `PathLink` | interface | A path from a folder named by its id (`~efs/o/<folder>/<name>/…`): that folder's object link, then at least one folder or file name, which keep their case (files-name/3). |
| `RealmRef` | interface |  |
| `RealmRule` | type |  |
| `RealmSplit` | type |  |
| `RevisionLink` | interface | One exact revision. |
| `StableWordCheck` | type |  |
| `TopicLink` | interface | A topic: a path of words. |
| `UnstableCheck` | type | Why a word is not stable until the fold rule is ruled (checkStableWord). |
| `WordDetail` | type | Why a topic segment is refused (LinkParse `detail` for `bad-word`): the chain's word rules (each with its `code`) and the link grammar's own fold-independent ones, or "fold-refused" when the caller's fold refused the segment. |

#### `@efs/sdk/files`

| Export | Kind | Summary |
| --- | --- | --- |
| `fileChunks` | function | Verified chunks of an opened file, pulled on demand. |
| `fileVersions` | function | Everyone's versions of a file under a Lens: the Lens decision, the Lens tier, the creator's row and a page of the public tier, read at one block. "N versions" is `public.live`, never `count`. |
| `listFolder` | function | One page of a folder's entries under a Lens, read at one block. |
| `listRemoved` | function | List `author`'s removed entries in `folder` (released, or hidden), each with its last target, a page of their scope list at a time, at one block. |
| `lookupEntry` | function | Look up one name in a folder under a Lens: the Lens's choice (`selected`), and every author in the Lens with an entry at that name, in Lens order with when each was first placed (`candidates`), so an app can show same-named entries as a list. |
| `MAX_MEDIA_TYPE_BYTES` | const | The longest media type the chain accepts, in bytes (release constants.files.mediaType.maxLength). |
| `MAX_VERSIONS_PAGE` | const | The most public-tier entries scanned in one call, and the default `limit` (the topic readers' row bound). |
| `normalizeMediaType` | function | Normalize a caller's media type for planning: lowercase A–Z in the type and subtype (before the first ";"), keep the parameters exactly as given, then check the chain's grammar. |
| `openFile` | function | Resolve a file's HEAD revision under the Lens, then its content layout. |
| `openHome` | function | Open a home (`/0x<address>`, a HomeLink with no names): the address's author identity at one block (the gateway's Keys.principalFor: a key account's key principal, a contract's Realm contract principal), and the Lens to list it under, the reader first, then that owner, then `base`. |
| `openObject` | function | What an object link's id is, from one batched read: a files-directory/1 record is a FOLDER; else a created subject is a FILE (then opened under the Lens); else ABSENT_PROVEN. |
| `openPath` | function | Open a path link: names below a folder named by its id (`~efs/o/<folder>/<name>/…`, a PathLink) or below a home (`/0x<address>/<name>/…`, a HomeLink with names). |
| `planCreateFile` | function | Plan a new file `name` in `folder`: one review, one prompt in the common case (large content splits into parts, the finish kept in one publication so the file appears whole). |
| `planCreateFolder` | function | Plan a new, empty folder `name` in `folder`. |
| `planEditFile` | function | Plan an edit of `file` from `base` to `content`, for writer.runSequence. |
| `planHideEntries` | function | Plan hiding other authors' entries (an UNBIND, a mask, at your own position at each name): nothing shows there for a reader whose Lens puts you before the entry's author; readers who rank that author first still see it. |
| `planMoveEntries` | function | Plan moves and renames of your own entries: each one RELEASEs the old place (the Lens falls through to the next author there) and BINDs the new one, atomically in one publication. |
| `planRemoveEntries` | function | Plan removing your own entries from their folders. |
| `planRestoreEntries` | function | Plan putting your removed entries back (released or hidden), each to the target it had before. |
| `planUnhideEntries` | function | Plan removing your hides (RELEASE of your own MASKED entries): the Lens falls through to the next author's entry at each name again. |
| `readBytes` | function | Read the whole file, verified, bounded by maxBytes. |
| `readRange` | function | Read [offset, offset + length) of an opened file, verified. |
| `resolvePath` | function | Resolve a path of names from a folder the caller names, under a Lens, at one block. |
| `unverifiedChunks` | function | Stream a whole file, emitting external bytes before they can be verified. |
| `ByteGrade` | type |  |
| `ByteRangeResult` | interface |  |
| `BytesOpts` | interface |  |
| `CreateFileInput` | interface |  |
| `CreateFileReview` | interface |  |
| `CreateFolderInput` | interface |  |
| `CreateFolderReview` | interface |  |
| `EditFileInput` | interface |  |
| `EditFileOpts` | interface |  |
| `EditLayout` | type |  |
| `EditPlanResult` | type |  |
| `EditReview` | interface | What the review dialog shows. |
| `EntryCandidate` | interface | One author's live entry at a name. |
| `EntryKind` | type | What a row is. |
| `EntryLookup` | type |  |
| `EntryRef` | interface | One name in one folder or home. |
| `EntryRefusal` | interface | Why one entry of a plan was refused. |
| `EntryTarget` | type | What a folder entry points at: a file (subject) or a folder (directory record). |
| `ExternalContent` | interface | Content stored elsewhere: the revision names a files-external/1 locator and its sha256. |
| `FileChunks` | interface | Verified chunks of a file. |
| `FileRef` | interface |  |
| `FileVersion` | type | One author's version. |
| `FileVersionsCursor` | interface | Where the public tier carries on: an absolute list position and what the earlier pages saw. |
| `FileVersionsOpts` | interface |  |
| `FileVersionsResult` | type |  |
| `FolderCoverage` | type |  |
| `FolderCursor` | interface | Continues a listing. |
| `FolderPage` | type |  |
| `FolderPlanOpts` | interface |  |
| `FolderPlanResult` | type |  |
| `FolderRef` | interface | A folder: its files-directory/1 record id, which is also its permanent link (`~efs/o/<directory>`) and the subject of its entries' FOLDER bindings. |
| `FolderReviewBase` | interface | What every folder review carries (prompts, gas and records as in EditReview). |
| `FolderRow` | interface |  |
| `HideEntriesInput` | interface |  |
| `HideReview` | interface |  |
| `HideReviewItem` | interface |  |
| `HomeOpen` | type |  |
| `HomeRef` | interface | A home: an address as a folder parent (design §12.5). |
| `LastBound` | type | What an entry pointed at before it was removed, read from its history: - KNOWN: the target of its last BIND, which Restore binds again; - NEVER_BOUND: a hide with no earlier bind by this author (a lone hide of someone else's entry at that name): there is nothing to restore, and Unhide (planUnhideEntries) removes the hide; - UNKNOWN: the history is deeper than the walk's bound, or the endpoint can't walk it (`reason`); never a guess. |
| `LensVersion` | type | A Lens author's version, with their place in the Lens. |
| `LensView` | interface | What a reader with this Lens sees at a name. |
| `ListFolderOpts` | interface |  |
| `ListRemovedOpts` | interface |  |
| `Location` | interface |  |
| `LocationAttempt` | interface |  |
| `MediaTypeCheck` | type |  |
| `MoveEntriesInput` | interface |  |
| `MoveInput` | interface |  |
| `MoveReview` | interface |  |
| `MoveReviewItem` | interface |  |
| `ObjectOpen` | type |  |
| `OpenedFile` | interface |  |
| `OpenPathOpts` | interface |  |
| `OpenResult` | type |  |
| `ParentRef` | type | Where entries live: a folder (a files-directory/1 record) or a home (an address). |
| `PathOpen` | type |  |
| `PathResolution` | type |  |
| `PathStep` | interface |  |
| `PublicVersions` | type | The public tier: everyone else, newest first author first (by first HEAD statement, never by latest edit). |
| `ReadOpts` | interface |  |
| `RemovedCursor` | interface | Continues a removed-entries listing: an index into the author's scope list, for the same folder and author. |
| `RemovedPage` | type |  |
| `RemovedRow` | type |  |
| `RemoveEntriesInput` | interface |  |
| `RemoveReview` | interface |  |
| `RemoveReviewItem` | interface |  |
| `ResolvePathOpts` | interface |  |
| `RestoreEntriesInput` | interface |  |
| `RestoreReview` | interface |  |
| `RestoreReviewItem` | interface |  |
| `RevisionRef` | interface |  |
| `StreamFailure` | interface |  |
| `StreamOpts` | interface |  |
| `UnhideEntriesInput` | interface |  |
| `UnhideReview` | interface |  |
| `UnhideReviewItem` | interface |  |
| `UnverifiedChunks` | interface | Chunks emitted before they are verified. |
| `UnverifiedOpts` | interface |  |
| `UnverifiedResult` | interface |  |
| `VersionsDecision` | type | What the file shows under the Lens (LensReader.resolve, as openFile reads it): the first Lens author with a BOUND or MASKED head decides; UNSET and RELEASED heads fall through. |

#### `@efs/sdk/actions`

| Export | Kind | Summary |
| --- | --- | --- |
| `ACTION` | const | The action kinds a plan may use. |
| `actionGas` | function | The model's gas for one action (without the per-publication terms). |
| `actionsHash` | function | The hash of a publication's actions as the ledger checks them (keccak256 of their ABI encoding), part of its digest. |
| `atomicBatchSupport` | function | Whether the wallet can run calls atomically on this chain (EIP-5792 wallet_getCapabilities). |
| `createWriter` | function | A writer for one account: plan, review, send and reconcile publications, and run split saves (runSequence, resume), each sent exactly once through the durable journal. |
| `decodeJournalRecord` | function | Parse a stored record. |
| `decodeRevert` | function | Decode revert data as far as the vendored contracts tables allow: the selector always, the error's name only when the vendored errors table has it, its arguments only when they decode cleanly as that error. |
| `decodeSequenceRecord` | function | Parse a stored sequence. |
| `encodeJournalRecord` | function | The storage form of a record (see docs/design/journal-storage.md): JSON, bigints as tagged decimal strings. |
| `encodeSequenceRecord` | function | The storage form of a sequence record (the same tagged JSON as encodeJournalRecord). |
| `gasLimitOf` | function | The gas limit to sign or ask the wallet for, or a refusal. |
| `gasPlanFor` | function | The gas model and cap to split with on this deployment's chain: the schedule `chain.feeSchedule` names, else the one whose hardforks include `chain.hardfork`. |
| `isResolved` | const | True for a stage that ends an attempt (COMMITTED, NOT_COMMITTED_PROVEN, NOT_SENT); see isSettled for finality. |
| `isSettled` | const | Nothing left to check for this attempt: NOT_SENT, NOT_COMMITTED_PROVEN, or COMMITTED at a finalized block. |
| `kernelQuote` | function | The kernel's quote (LedgerIngress._foldAndQuote, formula 3), exactly as gas-plan.mjs `quote()` computes it: fresh slots for each new record (with its references and digest specs) and each publish's rewrites; for each BIND, UNBIND or RELEASE the work model's row of its class (classesOf), with the surcharge's row when its purpose is the work model's `surchargePurpose` (the kernel's own test: the words are equal, zero included); every WITHDRAW after the first adds the later row; and the prefix floor and final reserve they price. |
| `localLocks` | function | Locks for this JavaScript context only: callers queue in order, and `wait` is false (BUSY at once if held), true (queue until free) or a number of milliseconds (BUSY if not acquired in time). |
| `lockKey` | function | The lock key: one submission at a time per (chain, realm, deployment, account). |
| `MAX_SPLIT_DEPTH` | const | How many times a planned part may be re-split, at most (each level at least doubles its pieces). |
| `memoryJournal` | function | In-memory journal with an in-process lock. |
| `openJournal` | function | Open a journal without a writer: what an app shows after a reload, before the person reconnects ("Partially saved (2 of 5) — Continue"). |
| `planPublication` | function | Plan one publication from its actions and bodies, without a wallet (what `writer.planActions` runs): limits checked, the nonce and acceptance profile read at a pinned basis, the calldata encoded. |
| `publicationGas` | function | The planning estimate shown to people: the model plus intrinsic gas and the calldata of the encoded call (every byte priced as non-zero), plus the first-write surcharge when `firstWrite`. |
| `reconcileAttempt` | function | Settle one journaled attempt from the ledger, by plan id, without a wallet (what `writer.reconcile` runs): COMMITTED, NOT_COMMITTED_PROVEN or UNKNOWN, with `final`. |
| `reservoirProfile` | function | True when the deployment's fee schedule splits execution gas from state gas (the vendored schedule has `executionGas`, as amsterdam does: EIP-8037's reservoir). |
| `splitPublications` | function | Greedy, order-keeping split: each publication takes as many whole units as fit. |
| `TX_GAS_CAP` | const | EIP-7825's per-transaction gas cap (2^24): the default when the deployment document states none. |
| `TX_GAS_HARD_MAX` | const | EIP-8037's ceiling on tx.gas (2^32 − 1): the reservoir profile's limit never goes above it. |
| `txGasCapOf` | const | The cap of this deployment's chain (efs-deployment.chain.txGasCap). |
| `WALLET_ANSWER_CODES` | const | The reasons a "wallet-answer" event carries: exactly these, the ones meaning the wallet or its node answered. |
| `ActionData` | interface | One ledger action (contracts src/interfaces/Actions.sol), as plain data. |
| `AttemptRecord` | interface |  |
| `AttemptStage` | type |  |
| `Authorizer` | type |  |
| `BatchLimits` | interface |  |
| `BatchSendResult` | type |  |
| `BindRow` | type | The gas-model row a BIND, UNBIND or RELEASE is priced at. |
| `EffectView` | interface | Stable codes for the client's message catalog. |
| `EfsWriter` | interface |  |
| `FloorModel` | interface | The kernel's floor, per schedule (gas/model.json profiles.<schedule>.floor). |
| `GasConstants` | interface | One fee schedule's fitted constants (release.json gasModel.schedules[name]; generated as GAS_SCHEDULES). |
| `GasLimit` | type |  |
| `GasLimitInput` | interface |  |
| `GasModel` | interface | The model the planner splits with: what the per-transaction cap counts, for one fee schedule. |
| `GasPlan` | type |  |
| `Journal` | interface |  |
| `JournalView` | interface | Sequences without a wallet: settle and list them before anyone connects (resume still needs the writer). |
| `KernelQuote` | interface | The kernel's own quote of a publication's floor (LedgerIngress.indexFloor's four numbers). |
| `LocalAccountLike` | interface | A viem LocalAccount satisfies this structurally; the SDK holds no private-key code. |
| `PartUnit` | interface | A run of a part's actions that must stay in one publication (a folder entry's actions, a topic's registration, one tag statement), with the effect that describes it. |
| `Plan` | interface | Plain, journal-safe data. |
| `PlanInput` | interface |  |
| `PlannedAction` | interface |  |
| `PlanResult` | type |  |
| `PlanSequenceResult` | type |  |
| `ReconcileOpts` | type |  |
| `ReconcileResult` | interface |  |
| `Review` | interface |  |
| `RunResult` | interface |  |
| `SendOpts` | interface |  |
| `SendResult` | type |  |
| `SequenceEffect` | type | What a save is for, so a UI can name it and hold new saves per file. |
| `SequenceEvent` | type |  |
| `SequenceOpts` | interface |  |
| `SequencePart` | interface |  |
| `SequencePartInput` | type | A part as a planner made it: PlanInput.gas and .total carry its batching estimate and its whole gas, and `units` where it may be re-split (SequencePart.units). |
| `SequenceProgress` | interface | What the client shows: N, how many committed, and where the save is now. |
| `SequenceRecord` | interface |  |
| `SequenceState` | type | A save split into several publications (writer.runSequence). |
| `SplitOptions` | interface |  |
| `SplitPart` | interface |  |
| `SplitResult` | type |  |
| `WalletAnswerCode` | type |  |
| `WalletAnswerReason` | type |  |
| `WithLock` | type |  |
| `WriterConfig` | interface |  |

#### `@efs/sdk/tags`

| Export | Kind | Summary |
| --- | --- | --- |
| `authorCount` | function | A (place, thing) pair's two counts: the authors who ever stated anything there, and how many say yes now. |
| `broaderAction` | const | "subject is narrower than broader": (BROADER, subject, broader) → broader. |
| `checkText` | function | The chain's text grammar (text/1, for labels; TopicProfile.textRefusal): 1–255 bytes of strict UTF-8; no C0, DEL or C1 control; no bidi control, invisible scalar or noncharacter. '/', spaces, uppercase and joiners are admitted. |
| `checkWord` | function | The chain's word grammar (topic-word/1, TopicProfile.wordRefusal; contracts 04526b1 item 53): 1–255 bytes of strict UTF-8; of ASCII only a–z, 0–9, '-', '_' and '.'; no refused scalar; not ending with '.'; not starting with '-'; not '0x' and 40 lowercase hex digits. |
| `childId` | function | The topic one word below `parent`: the topic/1 record (parent, word page). |
| `denyAction` | function | "not this", n < 0 (−1 by default): a TAG UNBIND, which may be a first statement (a lone negative). |
| `fileNames` | function | Names for files shown in a topic, by the spec §3.7 order, at one block: for each file, its tagger's own entry in their home or a folder they created, else its creator's entry, else the first Lens author's, else null. |
| `homeId` | function | A home: the address as a left-padded word (no record, no hash). |
| `labelActions` | function | A label of `subject` in `lang`: the text record, then the PROPERTY bind to it. |
| `labelKey` | const | A label's key in one language: the property key of "label:" ‖ the BCP 47 tag with ASCII A–Z lowercased, exactly as EfsTopics.labelKey folds it (`pt-BR` and `pt-br` are one key). |
| `labelOf` | function | What a topic or home is called under a Lens: its label in the reader's first language that has one. |
| `langTag` | function | A BCP 47 language tag, lowercased (the tag is case-insensitive; EfsTopics' own example is `pt-br`). |
| `lensTagsOf` | function | A page of the places `thing` is filed at, under a Lens (see the file's header). |
| `numberOf` | function | BindingNumber.numberOf: BOUND (1) → strength, MASKED (2) → −1 − strength, any other state → no number. |
| `pathId` | function | A path's topic id, from its words alone: never an author, a Realm or a chain. |
| `pathIds` | function | Every prefix's topic id, from the root word down: ids[k] is the topic of the first k + 1 words. |
| `placeCount` | function | A place's two counts, for one of two lists, never both: exactly at the place, or with `below: true` strictly below it (statements at its proper descendants; the place itself is left out). |
| `placeId` | function | A place's id (and whether it is a topic). |
| `planBroader` | function | Plan "this topic is narrower than that one" (or, with `remove`, take yours back). |
| `planDeny` | const | Plan "not this" for each target at this topic (or home), with number n < 0 (default −1). |
| `planLabel` | function | Plan a label of a topic or home in one language (or, with `remove`, take yours back). |
| `planSame` | function | Plan "this topic is the same as that one" (or, with `remove`, take yours back). |
| `planTag` | const | Plan "each target is in this topic (or home), with number n ≥ 0" (default 0). |
| `planUntag` | const | Plan taking your statements back (RELEASE): you say nothing about these targets there any more. |
| `propertyAction` | function | A property of `subject`: (PROPERTY, subject, key) → value. |
| `propertyKey` | function | A property's key: keccak256(abi.encode(keccak256("efs/property-key/1"), keccak256(key))). |
| `registerPathActions` | function | Registering a path, in the order the chain needs (registerPath / registerChild): the word pages first, then the path records from two words on, parent first. |
| `releaseAction` | function | Back to "said nothing" for any statement of yours: a RELEASE at (purpose, subject, role). |
| `sameAction` | const | "subject is the same topic as other": (SAME, subject, other) → other. |
| `strengthOf` | function | The action a number takes: a BIND with strength n (n ≥ 0) or an UNBIND with strength −1 − n. |
| `tagAction` | function | "thing is in topic, with number n ≥ 0": a TAG BIND whose target is the thing. |
| `tagsOf` | function | Every place a thing is filed at (TAG), either sign, newest first, each with its exact yes-count; no Lens. |
| `textRecordAction` | function | The PUBLISH of a text/1 record (a label's display string). |
| `textRecordId` | function | A text/1 record (a label's display string). |
| `topicBroader` | function | "Under…" and "Over…" for a topic, one hop each way, under a Lens: the topics it is narrower than, and the topics narrower than it. |
| `topicChildren` | function | A topic's child topics, newest first, each with its own word (read from its path record and word page and checked against the parent) and its counts. |
| `topicItems` | function | A page of things at a place. |
| `topicItemsMerged` | function | A topic's items with its Lens's synonyms, merged newest first: see the header. |
| `topicName` | function | Every segment's display name for a topic under a Lens (spec §3.5): a path-level label of that place, else the word-level label (the word's page) in the reader's languages, else the word itself. |
| `topicPath` | function | A topic's words, root first, read from its path records (at most 64 levels). |
| `topicSynonyms` | function | The topics a Lens says are the same as `topic`, at both levels (see the file's header), at one block: the places joined to it, and each of its words' word-level synonyms. |
| `topicTypesOf` | function | The deployment's Topics Type ids (topic-word/1, topic/1, text/1); MISUSE when it registers none. |
| `untagAction` | function | Back to "said nothing": a TAG RELEASE of your own statement. |
| `wordPage` | function | Every place whose own word is `word`: its root topic /<word> first, then each registered path ending in it. |
| `wordPageId` | function | A word's page (and the root-level topic /<word>): the topic-word/1 record of its bytes. |
| `BroaderInput` | interface |  |
| `BroaderResult` | type |  |
| `CountResult` | type |  |
| `Decider` | type | Who decided a row: a Lens author (with their index and number), or the public tier (someone says yes). |
| `FiledRow` | interface | One place a thing is filed at (tagsOf): the row of `everyone` with no Lens, rows nobody says yes to included. |
| `FileName` | interface |  |
| `FileNameInput` | interface |  |
| `FileNameRow` | interface |  |
| `FileNamesOpts` | interface |  |
| `FileNamesResult` | type |  |
| `GrammarCheck` | type |  |
| `Joined` | interface | One topic joined to the asked one: how many hops away, and which Lens author's statement joined it. |
| `Label` | interface | A label the Lens chose: its text, its language, who said it, and the text record. |
| `LabelInput` | interface |  |
| `LabelResult` | type |  |
| `LensTagsOpts` | interface |  |
| `LookupPage` | type |  |
| `MergedCursor` | interface | Continues a merged listing: the frozen list set, each list's resume point, and the things already decided. |
| `MergedHow` | type | How a list joined the merge: the topic itself, a "same" the Lens states, or a word swap of the topic's path. |
| `MergedItemsOpts` | interface |  |
| `MergedList` | interface | A list of the merge: its place, how it joined, and how many hops from the topic. |
| `MergedPage` | type |  |
| `MergedRow` | interface |  |
| `MissingList` | interface | A list the chain refused: named, so the client can say "N synonyms couldn't be read". |
| `NameOpts` | interface |  |
| `PlaceCountRow` | interface | A place of a directory (children, word page): its counts are "about" figures, never row counts. |
| `PlacesOpts` | interface |  |
| `Related` | interface | One topic a Lens says the asked one is under (broader), or that is under it (narrower). |
| `SameInput` | interface |  |
| `ScanStatus` | type | Why a page stopped: the list ended (the only end), or a bound was reached (entries, gas, rows). |
| `SegmentName` | interface |  |
| `SynonymOpts` | interface |  |
| `SynonymsResult` | type |  |
| `TagInput` | interface |  |
| `TagPlace` | type | Where a statement is made: a topic by its words (registered as needed), or a home (an address; no record). |
| `TagPlanOpts` | interface |  |
| `TagPlanResult` | type |  |
| `TagRefusal` | interface |  |
| `TagReview` | interface |  |
| `TagStatementReview` | interface |  |
| `TagTarget` | type | What a statement is about: any existing record or subject, or an address. |
| `ThingKind` | type | What a row's thing is, at the page's block. |
| `ThingTagRow` | interface | One place the thing is in, as the Lens decided it. |
| `ThingTagsPage` | type |  |
| `TopicCursor` | interface | Continues a listing: the chain's resume point, and the things already returned (for de-duplication). |
| `TopicId` | type | A topic's id: the record id of its word page (one word) or of its path record (two or more). |
| `TopicItemsOpts` | interface |  |
| `TopicNameResult` | type |  |
| `TopicPage` | type |  |
| `TopicPathResult` | type |  |
| `TopicPlace` | type | A place: a topic by its words or its id, or a home (an address). |
| `TopicRow` | interface |  |
| `TopicStatementPlanResult` | type |  |
| `TopicStatementReview` | interface |  |
| `TopicTypes` | interface | The Topics Type ids of a deployment (provisional until the Unicode generator gate; see the release notes). |
| `TopicView` | type |  |
| `WordSynonyms` | interface |  |

#### `@efs/sdk/web`

| Export | Kind | Summary |
| --- | --- | --- |
| `streamFile` | function | Stream an opened file's verified bytes. |
| `streamUnverified` | function | The explicit opt-in for playing a single-digest (external) file while it downloads. |

#### `@efs/sdk/web/journal`

| Export | Kind | Summary |
| --- | --- | --- |
| `indexedDbJournal` | function | The journal for browser and worker clients. |
| `IndexedDbJournalOptions` | interface |  |
| `WebJournal` | interface |  |

#### `@efs/sdk/web/cache`

| Export | Kind | Summary |
| --- | --- | --- |
| `indexedDbByteStore` | function | A persistent cache of verified bytes in IndexedDB, for pages and workers (opt-in: `createEfs({ cache: { bytes } })`). |
| `IndexedDbByteStoreOptions` | interface |  |
| `WebByteStore` | interface |  |

#### `@efs/sdk/node`

| Export | Kind | Summary |
| --- | --- | --- |
| `fileJournal` | function | The journal for Node clients. |
| `FileJournalOptions` | interface |  |

#### `@efs/sdk/testing`

| Export | Kind | Summary |
| --- | --- | --- |
| `createRecorder` | function | Record the RPC half (a fetch) and, optionally, the wallet half of a flow, numbering every answer and every mark in one sequence. |
| `createReplay` | function | Replay transcripts with the head gated by their writes and marks (see the header). |
| `createRpcReplay` | function | Replay recorded RPC transcripts as a fetch and an EIP-1193 provider, for chain-free tests: each request gets its recorded answer in order, and unmatched calls are misses (createReplay adds epochs, for heads that move). |
| `planHeadNo` | function | Test-only (exported from ` |
| `planHeadRelease` | function | Test-only (exported from ` |
| `planLoneHide` | function | Test-only (exported from ` |
| `planOtherEntry` | function | Test-only (exported from ` |
| `recordingFetch` | function | Wrap a fetch so every JSON-RPC POST is recorded as an RpcCall (request and response bodies, verbatim). |
| `recordingProvider` | function | Wrap an EIP-1193 provider so every request is recorded as a WalletCall, in the order the requests were made, with the result or error filled in when it settles. |
| `replayFetch` | function | A fetch that answers JSON-RPC POSTs from transcripts (any URL) and 404s everything else. |
| `replayProvider` | function | A fake wallet answering from the transcripts' wallet halves: each request is matched on `[method, params]`, answers are served in recorded order and the last repeats (`strict`: never repeats), and a recorded error is thrown (with its `code`). |
| `HeadStatementInput` | interface |  |
| `HeadStatementReview` | interface |  |
| `LoneHideInput` | interface |  |
| `LoneHideReview` | interface |  |
| `OtherEntryInput` | interface |  |
| `OtherEntryReview` | interface |  |
| `RecordedMark` | interface | A harness's mark: where the chain's head moved without a page write (an actor's write, a mine). |
| `Replay` | interface |  |
| `RpcCall` | interface |  |
| `RpcReplay` | interface |  |
| `RpcTranscript` | interface |  |
| `WalletCall` | interface | One EIP-1193 request to the wallet and what the wallet answered (a result, or an error it threw). |

<!-- export-index:end -->
