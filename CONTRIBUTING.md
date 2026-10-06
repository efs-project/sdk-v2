# Contributing

The repository is at **S0 (initialization)**. See `LIMITATIONS.md` before starting anything.

## Toolchain

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| Node | 24.21.0 (runtime support `>=22.12`) | `.node-version`, `package.json#devEngines` |
| pnpm | 12.6.0 | `package.json#devEngines`, CI |
| TypeScript | 7.0.2 | pnpm catalog |
| Foundry | 1.8.3 | CI (`foundry-rs/foundry-toolchain`) |
| solc | 0.8.37 (release builds) | `packages/solidity/foundry.toml` |

Supported consumer compiler × EVM combinations are listed in `packages/solidity/compat.json`.

## TypeScript lane

```sh
pnpm install --frozen-lockfile
pnpm --filter @efs/sdk exec playwright install chromium    # once
pnpm lint          # Biome format + lint (restricted imports in portable code)
pnpm typecheck     # portable, dom, worker, node and test projects
pnpm test          # Vitest: Node + real Chromium
pnpm checks        # SPDX, licenses, placeholder registry, negative fixtures, compat policy
pnpm build
pnpm pack:all      # .packs/: tarballs, Solidity archive, SHA256SUMS, pack.json
pnpm test:package  # install the tarballs into fresh copies of examples/ and run them
pnpm lint:package  # publint + are-the-types-wrong on the packed tarball
```

`pnpm check` runs all of the above in order.

## Solidity lane (no Node required)

```sh
cd packages/solidity
forge soldeer install
forge fmt --check
forge build --sizes
forge test
cd ../..             # return to the repository root for the commands below
```

Then, from the repository root with Node available: `node tools/checks.mjs solidity` (internal-only libraries, no link
references). For packaging: `node tools/pack.mjs --only solidity && node tools/consumers.mjs --only foundry`.

## Release dry run

`node tools/release-dry-run.mjs` writes a draft release manifest from `.packs/`. To compare two
builds: `node tools/release-dry-run.mjs --compare <other-.packs-dir>`. The CI workflow
`release-dry-run.yml` does both on separate runners. Nothing is published.

## Changesets

Changesets is configured, but changesets are **not required** on pull requests until
publishing is authorized. Both packages are private.

## Pull requests

Keep changes small and in one lane where possible. CI must pass: jobs `typescript`, `solidity`
and `solidity-package`. Record consequential decisions as an ADR in `docs/adr/`.
