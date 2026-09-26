# ADR-0004: CI lanes and the release dry run

**Status:** accepted (S0) · **Date:** 2026-09-26

## Decision

- **`ci.yml`** runs on every PR and on `main`, with three independent jobs:
  - `typescript`: lint, typecheck, Node and Chromium tests, checks, build, pack, packed consumers, publint/attw;
  - `solidity`: Foundry only (fmt, build with sizes, tests), then the internal-library check;
  - `solidity-package`: pack the Solidity package and compile a fresh Foundry consumer from the archive.
- **`compat.yml`** runs nightly and on demand: Node 22/24/26, TypeScript consumers 5.9/6.0/7.0,
  and every supported solc × EVM combination with `via_ir` both off and on.
- **`release-dry-run.yml`** runs on demand. It packs once, repeats the build on a fresh runner,
  compares unpacked file digests (**repeatability**, not independent reproduction), installs the
  exact artifacts into the examples, runs `changeset status`, and uploads the artifacts plus a
  draft manifest. It has no publish step, no `id-token` permission and no secrets.
- Every workflow uses `permissions: contents: read` and actions pinned to commit SHAs.
  Dependabot proposes action updates.

## Consequences

Publishing (npm organization, first publish, trusted publisher, idempotent publish and verify
jobs) is separate, later work that needs explicit authorization.
