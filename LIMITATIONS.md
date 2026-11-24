# Limitations

**Status: early development of EFS SDK 0.1.** Implemented: deployment pinning, verified byte reads (inline, span
trees, external locations), names and path segments, protocol ids, the write lifecycle (plan, review, send,
reconcile) with durable attempt journals (IndexedDB + Web Locks in browsers and workers, files in Node). **Not
yet:** folder listings and paths (waiting on the tags-vs-directories decision), the files write planner, web3://
reads, the Solidity package contents. Streaming external files is buffered (verified before any byte is emitted). Both packages are
`private` and have never been published. Do not depend on anything in this repository yet.

## Placeholders

Every file below is an S0 smoke placeholder. Each exists only to prove that the build,
test, packaging or consumer machinery works, and none of them is EFS API. The first
feature PR touching an area deletes its placeholder. `node tools/checks.mjs placeholders`
fails if a file carrying the `S0 placeholder` marker is missing from this list.

| File | Proves |
| --- | --- |
| `packages/solidity/src/smoke/Smoke.sol` | Foundry build, internal-library rule, npm/archive packaging |
| `packages/solidity/test/Smoke.t.sol` | forge-std, remappings, Forge test runner |
| `examples/smoke-ts-strict/index.ts` | strict TypeScript consumer of the published declarations |
| `examples/smoke-browser/build.mjs` | browser bundle excludes Node code; `./node` unresolvable in browsers |
| `examples/smoke-foundry/src/UsesSmoke.sol` | Foundry consumer of the release archive via the documented remapping |

## Known gaps in the scaffold itself

- The release workflow is a **dry run** only. There is no publish job, no npm organization,
  no token and no trusted-publisher configuration.
- The draft release manifest records the source, toolchain and artifact digests only. Two clean
  builds matching shows **repeatability** within our CI and toolchain. It is not independent
  reproduction.
- Windows and macOS runners are not in CI yet. They arrive with the CLI/MCP packages that
  claim them.
