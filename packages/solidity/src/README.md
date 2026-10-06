# @efs/solidity

**Pre-alpha. This package contains no EFS functionality yet.**

It holds EFS v2 Solidity interfaces and `internal` libraries that you compile into
your own contract, so your contract remains the caller that EFS sees. Nothing is
deployed or linked. At this stage (S0) the only file is a placeholder library,
`smoke/Smoke.sol`, which proves packaging and remappings work. It will be removed.

Files inside this package import each other by relative path, so it works under
any mount point. Planned install paths, none of them published yet:

| Tool | Remapping |
| --- | --- |
| npm + Hardhat | none (`import "@efs/solidity/...";` resolves through node_modules) |
| npm + Foundry | `@efs/solidity/=node_modules/@efs/solidity/` |
| Release archive | `@efs/solidity/=lib/efs-solidity-<version>/src/` |
| `forge install` | `@efs/solidity/=lib/sdk-v2/packages/solidity/src/` |

Publishing this source verifies nothing about any deployed contract.

License: MIT.
