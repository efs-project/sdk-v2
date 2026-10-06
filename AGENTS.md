# AGENTS.md

Instructions for everyone working in this repository, human or AI. They stand alone: you do
not need access to any private planning repository.

## What this repository is

The EFS v2 SDKs: a portable TypeScript package (`@efs/sdk`) and a Solidity source package
(`@efs/solidity`), with Node/CLI/MCP packages to come. Protocol truth, contract interfaces and
release bundles belong to the **contracts** repository. User interfaces belong to the
**client**. This repository must not redefine either.

**Current stage: S0, repository initialization.** There is no SDK behavior yet. Every
placeholder is listed in `LIMITATIONS.md`. Do not add SDK behavior without an explicitly
authorized task.

## Package map and import rules

| Path | Rules |
| --- | --- |
| `packages/sdk/src/**` (except `web/`, `node/`) | Portable. No `node:*` imports, no DOM or Node globals, no top-level side effects. Enforced by Biome and by `tsconfig.json` (`types: []`, `lib: ["es2023"]`). |
| `packages/sdk/src/web/**` | Must typecheck as window code (`tsconfig.dom.json`) **and** as Worker code (`tsconfig.worker.json`). DOM and WebWorker libs never share a project. |
| `packages/sdk/src/node/**` | Node-only; exported only under the `node` condition. |
| `packages/solidity/src/**` | Import other package files by **relative path** only. Libraries are `internal`-only; nothing needs linking. `forge-std` is for tests only. |
| `examples/**` | Not workspace members. They consume packed tarballs via `tools/consumers.mjs`. |
| `tools/**` | Node built-ins only; no dependencies. |

Nothing in `packages/` may import from `tools/` or `examples/`.

## Commands

| Change touches | Run before a PR |
| --- | --- |
| anything | `pnpm lint` and `pnpm typecheck` |
| TypeScript source or exports | `pnpm test`, `pnpm build`, `pnpm pack:all`, `pnpm lint:package`, `pnpm test:package` |
| Solidity | in `packages/solidity`: `forge soldeer install && forge fmt --check && forge build --sizes && forge test`, then return to the root (`cd ../..`) for `node tools/checks.mjs solidity` |
| Solidity packaging | `node tools/pack.mjs --only solidity && node tools/consumers.mjs --only foundry` |
| everything | `pnpm check` (TypeScript lanes) plus the Solidity lane above |

## Rules

- **Placeholders:** any file carrying the `S0 placeholder` marker must be listed in `LIMITATIONS.md`; `pnpm checks` enforces this.
- **Licensing:** every source file starts with `// SPDX-License-Identifier: MIT` (or `#` for TOML/YAML). Keep third-party notices intact. The package `LICENSE` copies must equal the root file.
- **Versions** are pinned: Node `.node-version`, pnpm in `package.json#devEngines`, TypeScript and Vitest in the pnpm catalog, Foundry in CI, solc in `foundry.toml`. Never write "latest" in configuration or docs.
- **Dependencies:** no dependency lifecycle scripts (`strictDepBuilds`). New runtime dependencies need an ADR and a permissive license.
- **Authority:** agents never publish packages, create registry tokens, change repository settings or deploy contracts. The release workflow is a dry run with no publish path.
- **Local processes:** do not start long-lived chains or servers from this repo at S0. Never kill processes by port or by name; other work may share the machine.
- **Decisions:** record consequential choices as a short ADR in `docs/adr/`.
