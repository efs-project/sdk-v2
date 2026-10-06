# Architecture decision records

Short records of consequential choices for this repository. Each one gives the context, the
decision and its consequences. Add a new numbered file for a new decision, and mark
superseded records instead of deleting them.

| ADR | Decision |
| --- | --- |
| [0001](0001-repository-layout-and-packages.md) | One repository, one portable TS package with subpaths, a separate Solidity package, examples as packed-consumer tests |
| [0002](0002-toolchain.md) | Node 24 / pnpm 12 / TypeScript 7 / Biome / Vitest; Foundry 1.8.3 and solc 0.8.37 |
| [0003](0003-solidity-packaging-and-versioning.md) | Pure Foundry project; `src/` is the package root with a metadata-only `package.json`; relative imports |
| [0004](0004-ci-and-release-dry-run.md) | Independent CI lanes, pack once, repeatability check, dry run with no publish path |
| [0005](0005-licensing-and-notices.md) | MIT, SPDX headers, license copies, dependency allowlist |
