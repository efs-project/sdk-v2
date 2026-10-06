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

During repository bootstrap, compatibility and release dry-run evidence must exist before
PR #1 merges, while `workflow_dispatch` requires the workflow on the default branch.
Both workflows therefore also accept `pull_request` events targeting `main`, guarded to
PR #1 from this repository's `chore/s0-scaffold` branch. Each independent compatibility
job and the release build is guarded; dependent jobs require successful prerequisites.
The guard becomes inert after PR #1 closes. Nightly and manual paths stay available.
Both release runners explicitly check out the same PR head SHA (or event SHA for manual
runs), and the draft manifest describes that actual checkout. CI and compatibility use
the ordinary PR merge candidate; review evidence records head, base and tested SHAs.
These dry-run artifacts are never inputs to a privileged publishing workflow.

Publishing (npm organization, first publish, trusted publisher, idempotent publish and verify
jobs) is separate, later work that needs explicit authorization.
