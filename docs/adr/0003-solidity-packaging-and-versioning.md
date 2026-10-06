# ADR-0003: Solidity packaging and versioning

**Status:** accepted (S0) · **Date:** 2026-09-26

## Context

Solidity consumers use Foundry (remappings, git or Soldeer), Hardhat (npm resolution) or a plain
source archive. Forge-only contributors must not need Node, but package versions should come from
one mechanism shared with the TypeScript packages.

## Decision

- `packages/solidity` is a **pure Foundry project**. It builds and tests with `forge` alone.
- **`packages/solidity/src/` is the npm package root.** A metadata-only, checked-in
  `src/package.json` (no scripts, no dependencies) makes `@efs/solidity` a pnpm workspace member
  that Changesets can version. OpenZeppelin uses the same pattern. Forge ignores the file.
- **Files inside the package import each other by relative path**, so the sources compile under
  any mount point. Only tests and examples use the `@efs/solidity/` prefix.
- **Libraries are `internal`-only.** Consumers compile them in, remain the caller, and never
  link or depend on a deployed helper. `tools/checks.mjs solidity` enforces this.
- The **same files** ship as:
  1. the npm tarball;
  2. a deterministic source archive (`efs-solidity-<version>.tar`: sorted entries, fixed time, uid/gid 0) with `remappings.example.txt`;
  3. a git tag.

  `tools/pack.mjs` proves the tarball and archive carry byte-identical sources.
- **Supported compilers** are an explicit list of solc × EVM combinations (`compat.json`), not a
  Cartesian product. Osaka is claimed only from solc 0.8.37.

## Consequences

`forge install` has trouble with the `@` in Changesets' tags (`@efs/solidity@x.y.z`). When
publishing is authorized, the release tooling adds an alias tag `solidity-v<version>` on the same
commit.
