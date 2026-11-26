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
- **Smaller Glamsterdam batches for later statements (Q52).** On the amsterdam schedule the reservation formula
  charges a later statement (a mask, release, restore or number change) twelve rewrites, 2.0 to 4.3 times what it
  spends. That shrinks those batches: tag masks and releases 44 per publication, restores and number changes 41,
  folder re-binds 40, edits 23. prague is unchanged. The remedy is one change to the formula: a compute term,
  decided with Q52's per-purpose term (James).
- **Glamsterdam is unconfirmed on a real client.**
  - The amsterdam gas limit (EIP-8037's reservoir: never clamped at 2^24, state gas held above it, at most the block
    gas limit) follows the EIP text, Last Call, and has run on no chain: none runs amsterdam yet.
  - Whether a Glamsterdam node's `eth_estimateGas` counts state gas is unconfirmed (the limit covers both readings).
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
