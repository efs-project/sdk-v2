# EFS v2 SDK

Software development kits for **EFS v2**, the Ethereum File System, for browser and server
JavaScript/TypeScript, for Solidity contracts, and later for native applications and agents.

> **Status: EFS SDK 0.1 in development.** `@efs/sdk` pins deployments, reads and streams verified files,
> writes exactly once through a durable journal, and parses links. See [`packages/sdk/README.md`](packages/sdk/README.md)
> for a quick start, [`examples/getting-started`](examples/getting-started/README.md) for the guide (pin, read, edit,
> recover, and what to say for each outcome), and [`LIMITATIONS.md`](LIMITATIONS.md) for what is missing. Both
> packages are private and unpublished.

## Install paths (none published yet)

| You are building… | You will install | Status |
| --- | --- | --- |
| A browser app, Worker, server or script | `@efs/sdk` (portable ESM; one package, subpath entry points) | in development (0.1) |
| Live-chain tests of an EFS app (Node) | `@efs/fixture`: a local chain with the deployment and seed, from the same contracts snapshot as `@efs/sdk` | in development (0.1) |
| A Solidity contract that reads or writes EFS | `@efs/solidity` source (npm), a release archive, or a git tag; compiled into your contract | planned |
| A CLI or an MCP-speaking agent | `@efs/cli`, `@efs/mcp` | planned |
| A native application | the Node service, CLI or MCP server first; other options only for a measured need | planned |

## Repository layout

```text
packages/sdk/        @efs/sdk: portable TypeScript (src/web and src/node are platform-specific)
packages/fixture/    @efs/fixture: startFixtureChain for live-chain tests (Node only; needs anvil)
packages/solidity/   Foundry project; src/ is the @efs/solidity package root
examples/            packed-consumer tests (outside the pnpm workspace)
tools/               dependency-free Node scripts: pack, consumers, checks, release dry run
docs/adr/            decision records for this repository
```

## Quick start for contributors

TypeScript side (Node 24.21.0, pnpm 12.6.0):

```sh
pnpm install --frozen-lockfile
pnpm --filter @efs/sdk exec playwright install chromium   # once, for browser tests
pnpm check                              # lint, typecheck, tests, checks, build, pack, consumers
```

Solidity side (Foundry 1.8.3 only; no Node needed):

```sh
cd packages/solidity
forge soldeer install
forge fmt --check && forge build --sizes && forge test
cd ../..                               # return to the repository root
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for every command, and [`AGENTS.md`](AGENTS.md) for rules
that apply to human and AI contributors alike.

## License

[MIT](LICENSE). The software license covers this repository's code only. It does not license
content that anyone reads or writes through EFS.
