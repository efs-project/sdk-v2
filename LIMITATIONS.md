# Limitations

**Status: repository initialization (S0). This repository contains no EFS SDK functionality.**

Nothing here reads, writes, verifies or encodes EFS data yet. Both packages are `private`
and have never been published. Do not depend on anything in this repository.

## Placeholders

Every file below is an S0 smoke placeholder. Each exists only to prove that the build,
test, packaging or consumer machinery works, and none of them is EFS API. The first
feature PR touching an area deletes its placeholder. `node tools/checks.mjs placeholders`
fails if a file carrying the `S0 placeholder` marker is missing from this list.

| File | Proves |
| --- | --- |
| `packages/sdk/src/index.ts` | portable build (no Node/DOM types), root export |
| `packages/sdk/src/web/index.ts` | DOM and Worker projects, `./web` export |
| `packages/sdk/src/node/index.ts` | Node project, `node`-condition-only `./node` export |
| `packages/sdk/test/smoke.test.ts` | Vitest in Node |
| `packages/sdk/test/smoke.browser.test.ts` | Vitest browser mode in real Chromium |
| `packages/solidity/src/smoke/Smoke.sol` | Foundry build, internal-library rule, npm/archive packaging |
| `packages/solidity/test/Smoke.t.sol` | forge-std, remappings, Forge test runner |
| `examples/smoke-node/index.mjs` | Node ESM consumer of the packed tarball |
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
