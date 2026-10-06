# ADR-0005: Licensing and notices

**Status:** accepted (S0) · **Date:** 2026-09-26

## Decision

- EFS original software in this repository is **MIT**-licensed, per the project owner's decision.
  The root `LICENSE` is canonical, and each package carries an identical copy (checked in CI).
- Every source file starts with an SPDX identifier (checked in CI).
- Third-party code keeps its own license and notices unchanged. A `THIRD_PARTY_NOTICES.md` is
  added when third-party code is first vendored or bundled. None is at S0.
- Runtime dependencies of publishable packages must use a permissive license from the allowlist in
  `tools/checks.mjs`.
- The software license does not license content read or written through EFS. Release
  transparency (manifests, digests, provenance) is engineering practice, not a license condition.
