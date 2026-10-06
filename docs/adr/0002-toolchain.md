# ADR-0002: Toolchain

**Status:** accepted (S0) · **Date:** 2026-09-26 (versions verified against registries and release pages that day)

## Decision

| Tool | Pin | Notes |
| --- | --- | --- |
| Node | 24.21.0 for development and CI; packages support `>=22.12` | Move development to Node 26 after it becomes LTS (2026-10-28). CI compatibility covers 22, 24 and 26. |
| pnpm | 12.6.0 (`devEngines.packageManager`) | Corepack is no longer bundled from Node 25, so pnpm is pinned explicitly. `strictDepBuilds` means no dependency lifecycle scripts run. |
| TypeScript | 7.0.2 (native `tsc`) | Consumers are tested on TS 5.9, 6.0 and 7.0. TypeDoc does not support TS 7 yet, so API docs wait. |
| Biome | 2.5.14 | One formatter and linter. |
| Vitest | 5.0.2, browser mode via Playwright 1.63.0 | Browser tests run in real Chromium. |
| publint / attw | 0.3.24 / 0.18.5 | Run on the packed tarball. |
| Changesets | 3.0.3 | Configured; not required on PRs until publishing is authorized. |
| Foundry | 1.8.3 | Soldeer (built in) locks forge-std 1.16.2 for tests. |
| solc | 0.8.37 for release builds, `evm_version = "prague"` | Consumer range and supported combinations are in `packages/solidity/compat.json`. |

## Consequences

Pins live in configuration files, never in prose alone. Upgrading a pin is an ordinary PR
that runs the full gate.
