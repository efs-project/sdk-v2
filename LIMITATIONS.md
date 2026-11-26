# Limitations

**Status: early development of EFS SDK 0.1.** Implemented: deployment pinning, verified byte reads (inline, span
trees, external locations), names and path segments, protocol ids, the write lifecycle (plan, review, send,
reconcile) with durable attempt journals (IndexedDB + Web Locks in browsers and workers, files in Node), folders and
homes (an address as a parent: list, look up, resolve paths and links, and create, edit, move, rename, remove,
restore, hide and unhide entries), and tags (topics and homes as places, `planTag` / `planDeny` / `planUntag`, and
the Mine / Everyone / Raw reads, labels and topic names, file names in a topic, "same as" and "broader", and synonym
gathering, and the merged read across a Lens's synonyms). **Not yet:** the tag word fold (words are checked as given until it is ruled), authoring as a contract principal (the writer is
key-principal only), and storage for files above the chain's per-file ceiling (about 1 MiB). Plan-time reuse is not
built either: a part whose records all exist, or are being published by an in-flight attempt, is still sent. So an
edit re-publishes every chunk of its content, including chunks already on chain. An identical publish-only part
(the same bytes saved again) is held back while its first attempt is not final (ALREADY_ATTEMPTED), and sent again
after. Reuse waits on a design note settling occurrences (what reads an author's own occurrence). When the edited revision belongs to another author, only the planning-time base check guards it
(the ledger's compare-and-swap covers the editor's own HEAD). web3:// reads cover addresses on the client's own chain in ERC-5219 mode. ENS names, other
chains and manual-mode contracts are reported as unsupported. Streaming an external file buffers and verifies it before emitting any byte. The explicit opt-in
`streamUnverified` plays one as it downloads and settles the grade at the end, but only for whole files. Verified
seeking into IPFS content is planned as per-block verification against the CID (trustless-gateway raw blocks or a
CAR), not as unverified range reads, which can never be checked against a whole-file sha256. Both packages are
`private` and have never been published. Do not depend on anything in this repository yet.

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
