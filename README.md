# EFS v2 SDK

Software development kits for **EFS v2**, the Ethereum File System, for browser and server
JavaScript/TypeScript, for Solidity contracts, and later for native applications and agents.

> **Status: pre-alpha: repository initialization only.** There is no usable SDK yet. Both packages
> are private and unpublished, and their only contents are placeholders listed in
> [`LIMITATIONS.md`](LIMITATIONS.md). This README describes the intended shape so contributors
> can find their way around.

## Planned install paths (none available yet)

| You are building… | You will install | Status |
| --- | --- | --- |
| A browser app, Worker, server or script | `@efs/sdk` (portable ESM; one package, subpath entry points) | planned |
| A Solidity contract that reads or writes EFS | `@efs/solidity` source (npm), a release archive, or a git tag; compiled into your contract | planned |
| A CLI or an MCP-speaking agent | `@efs/cli`, `@efs/mcp` | planned |
| A native application | the Node service, CLI or MCP server first; other options only for a measured need | planned |

## Repository layout

```text
packages/sdk/        @efs/sdk: portable TypeScript (src/web and src/node are platform-specific)
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
