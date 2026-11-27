# Limitations

**Status: early development of EFS SDK 0.1.** Both packages are `private` and have never been published. Do not
depend on anything in this repository yet.

**Implemented:**
- deployment pinning, and the read floor (a read is never served from a block older than one the client has read);
- verified byte reads (inline, span trees, external locations) and streaming;
- names, path segments, links and protocol ids;
- the write lifecycle (plan, review, send, reconcile, split saves), exactly once through durable journals (IndexedDB
  and Web Locks in browsers and workers, files in Node);
- folders and homes (an address as a parent): list, look up, resolve paths and links; create, edit, move, rename,
  remove, restore, hide and unhide entries;
- tags: topics and homes as places, `planTag` / `planDeny` / `planUntag`; the Mine, Everyone and Raw reads; labels
  and topic names; file names in a topic; "same as", "broader", synonym gathering and the merged read.

**Not yet, and known limits:**
- **The tag text rule (Q53, James).** Until it is ruled, the interim `foldWord` trims, joins and lowercases all-ASCII
  words and leaves any other word as typed. The word guard refuses, on writes that add a tag, any non-ASCII word a
  candidate rule would change. The ruled rule extends the interim one and never contradicts it. Topic ids can still
  move when the refused-character table is regenerated from the pinned Unicode version.
- **Plan-time reuse.** A part whose records all exist, or are being published by an attempt in flight, is still sent.
  An identical publish-only part (the same bytes saved again) is held back while its first attempt is not final
  (ALREADY_ATTEMPTED), and sent again after. Reuse is parked until after the MVP: it waits on a design note settling
  occurrences (what reads an author's own occurrence).
- **Chunk reuse.** For the same reason, an edit re-publishes every chunk of its content, including chunks already on
  chain.
- **Two failures that end a read without trying the next endpoint** (the read-validation audit, 2026-11-26; neither
  gives a value): `reconcileAttempt` treats a reader's UNSUPPORTED from `publicationAt` as final for that call, and a
  `web3://` location whose `resolveMode` or `request` reply doesn't decode, or isn't a 200, ends that location FAILED
  (the bytes are still verified by the caller, and the next location is tried).
- **Glamsterdam: measured on Sepolia, not yet run by the SDK there.**
  - Sepolia runs Glamsterdam. The contracts dev measured its rules on Geth and reth, and they match the SDK's gas limit
    (EIP-8037's reservoir: never clamped at 2^24, state gas held above it, at most the block gas limit). That includes
    `eth_estimateGas` returning execution plus state gas.
  - The SDK's own send path has not run there: no v2 deployment exists on Sepolia yet.
  - A Sepolia deployment document must name the `amsterdam` fee schedule (the fixture runs prague). A document that
    disagrees with its chain is refused before any plan or send: the fee-schedule check measures how the chain prices a
    fresh storage slot.
  - Wallets that estimate their own gas (EIP-5792 batches) must not clamp at 2^24 either.
- **Big files beyond linking elsewhere.** The file planners stop at `maxParts` (default 64) publications of up to
  16 KiB of body each, about 1 MiB, with TOO_LARGE. Raising it costs one wallet prompt and about 13M gas per part: a
  5 MB file is about 324 parts today, and far more gas on Glamsterdam. A larger file is linked instead:
  `files-external/1` is one publication for any size, with https, IPFS or Arweave locations verified against the
  author's sha256. There is no upload pipeline, and no host for the external bytes (pending James).
- **Authoring as a contract principal:** the writer is key-principal only.
- **Edits of another author's revision:** only the planning-time base check guards them (the ledger's
  compare-and-swap covers the editor's own HEAD).
- **web3://:** reads cover addresses on the client's own chain in ERC-5219 mode. ENS names, other chains and
  manual-mode contracts are reported as unsupported.
- **Streaming:**
  - Streaming an external file buffers and verifies it before emitting any byte. The opt-in `streamUnverified`
    plays one as it downloads and settles the grade at the end, but only for whole files.
  - Verified seeking into IPFS content is planned as per-block verification against the CID (trustless-gateway raw
    blocks or a CAR), not as unverified range reads, which can never be checked against a whole-file sha256.
- **The read floor guards against lag, not lies.** Endpoints are trusted for chain state. A chain shorter than the
  floor (a reset or rewound dev chain) stays BEHIND until `resetReadFloor()` or a reload.
- **Release pinning:** `protocol-inputs/lock.json` records the contracts commit and every file's sha256; the release
  digest slot is filled once release pinning starts (James, after the MVP).

## Placeholders

Every file below is an S0 smoke placeholder. Each exists only to prove that the build,
test, packaging or consumer machinery works, and none of them is EFS API. The first
feature PR touching an area deletes its placeholder. `node tools/checks.mjs placeholders`
fails if a file carrying the `S0 placeholder` marker is missing from this list.

| File | Proves |
| --- | --- |
| `examples/smoke-ts-strict/index.ts` | strict TypeScript consumer of the published declarations |
| `examples/smoke-browser/build.mjs` | browser bundle excludes Node code; `./node` unresolvable in browsers |

## Known gaps in the scaffold itself

- The release workflow is a **dry run** only. There is no publish job, no npm organization,
  no token and no trusted-publisher configuration.
- The draft release manifest records the source, toolchain and artifact digests only. Two clean
  builds matching shows **repeatability** within our CI and toolchain. It is not independent
  reproduction.
- Windows and macOS runners are not in CI yet. They arrive with the CLI/MCP packages that
  claim them.

## Residual trust

A read takes nothing as fact from one endpoint that it can check: bodies are hash-checked against their
content-addressed ids, list slices must strictly increase and be the length asked for, every Lens decision names the
Lens's own principal at its own index, positions are recomputed from what they claim, and a reply a sound reader
can't give fails over to the next endpoint (or ends UNKNOWN), never a value, an absence or a "never".

What stays on one endpoint's word, by design, because checking it at listing time would need every record's body:

- **Record headers shown in listings** (a record's `typeId`, `length` and first word, from `LedgerViews.records`):
  file sizes, media and record kinds in folder listings, topic rows' kinds, the kinds at a synonym's ends. Each is
  **as reported by the serving endpoint until the record is opened**: opening reads and hash-checks the body.
- **`fileVersions`' authors** (from `LedgerViews.authorHeads`): each row's author and head, as the endpoint reports
  them; each is checked to be a HEAD statement at this file's position, and a version opened is checked like any open.
- **A list's omissions**: an endpoint can leave an entry out of a list together with its count; the SDK sees one
  consistent answer. Reading from more than one endpoint is the remedy (the SDK fails over, it doesn't vote).

What never rests on an unverified field (checked 2026-11-26): opening bytes (sha256 and the content-addressed ids), a
principal that builds a Lens (a folder's owner comes from its hash-checked record), a write planner's parent folder
(checked from its record), and the media gate (it reads the opened revision's verified descriptor).

### Writes: what the endpoint you plan on still decides

The write-path audit (2026-11-26) checked what the person reviews against what they sign
(test/integration/signed-equals-reviewed.test.ts). On an honest endpoint they are always the same. One endpoint that
lies can still steer some writes, because the ledger's compare-and-swap binds a head's **revision only**, never its
state or target. Until the native ReadSet guard lands (a contracts release; the SDK will guard every written head),
**a head's state and target are that endpoint's word** in these planners:

- `planCreateFile`, `planCreateFolder`: your own entry at the name reported RELEASED (or MASKED) while it is bound, at
  its true revision: the create rebinds over your entry instead of refusing NAME_TAKEN_MINE.
- `planMoveEntries` (and renames): the destination is bound to your entry's target as the endpoint reports it, and
  its kind decides whether the move needs a `via` path.
- `planHideEntries`, `planUnhideEntries`: your own head reported not bound (or MASKED) while it is bound: the hide
  masks, or the unhide releases, your own entry.
- `planRestoreEntries`: the restored target is the endpoint's history (`historyAt`), checked for shape only.
- the testing planners (`planHeadNo`, `planHeadRelease`, `planLoneHide`, `planOtherEntry`) in the same way.

Also the endpoint's word, by design: the review's description of other people's entries (`visibleInLens`,
`shownInstead`, `hiddenBy`, `shownAfter`, a hide's `shownNow` author), and the `via` path a folder move or restore
checks for INTO_ITSELF (a lying endpoint can bypass that refusal; the chain refuses only a folder holding itself).
Record presence (whether a name, registration or text record is published) and tag counts are fail-safe either way.

**The trusted case is a single node you run yourself** (the MVP's local chain): it isn't adversarial. On a remote RPC,
read through more than one endpoint, and treat a write planned on one you don't trust as that endpoint's word.

What a write does check, whatever the endpoint says:
- a head is UNSET exactly at revision 0 (a head that says otherwise fails over): this closes the "UNSET" lies;
- the execution set signed is the deployment document's, and only while the chain's is the same; an acceptance
  profile of 0 is never signed (a zero would waive the ledger's check);
- a basis block more than `CLOCK_SKEW_SECONDS` (900 s) ahead of this device's clock fails over, so a signed deadline is
  at most the device's clock + 900 s + its window;
- before any wallet is asked, a plan's calldata and digest are re-derived from its own fields (a plan from the
  journal included), and a save resumes only the parts it recorded (`partsHash`; a record from before the field
  resumes as before). These detect a corrupted or version-skewed journal, not a party who can write it.
