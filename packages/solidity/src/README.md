# @efs/solidity

EFS Solidity interfaces and `internal` libraries that you compile into your own contract, so your contract is the
author EFS sees. Nothing is deployed or linked.

**Status: EFS SDK 0.1 in development.** The package is `private` and has never been published.

## Contents

The contracts' consumer closure is copied byte for byte from `efs-project/contracts-v2` at the commit named in
[`PROVENANCE.json`](PROVENANCE.json), which also lists every file's sha256:

| Path | What |
| --- | --- |
| `interfaces/` | the ledger, reader, registry and gateway interfaces, actions, errors, results and views (outside the contracts' `internal/`) |
| `lib/Keys.sol` | every id derivation: principals, Realm origin and id, Types, records, subjects, positions, bindings, scopes, posting lists |
| `lib/EfsNative.sol` | writing as your contract on the native lane: principal, nonce, bind (execution set + acceptance profile), action builders, one-shot writes, retry classes |
| `lib/EfsFiles.sol` | Files bodies and recipes: root/child revisions, directories, names, chunks, spans, content and external descriptors |

The closure compiles at `pragma ^0.8.27` (the floor the contracts test) up to solc 0.8.37. Files import each other
by relative path, so the package works under any mount point. The package's own tests check `Keys` against the
contracts' golden vectors, the same ones the TypeScript SDK checks its derivations against.

```solidity
import {ILedger} from "@efs/solidity/interfaces/ILedger.sol";
import {EfsNative} from "@efs/solidity/lib/EfsNative.sol";

bytes32 me = EfsNative.myPrincipal(ledger); // the principal your contract writes as
```

Install paths (none published yet):

| Tool | Remapping |
| --- | --- |
| npm + Hardhat | none (`import "@efs/solidity/...";` resolves through node_modules) |
| npm + Foundry | `@efs/solidity/=node_modules/@efs/solidity/` |
| Release archive | `@efs/solidity/=lib/efs-solidity-<version>/src/` |
| `forge install` | `@efs/solidity/=lib/sdk-v2/packages/solidity/src/` |

Publishing this source verifies nothing about any deployed contract. Pin a deployment with the TypeScript SDK
(`efs.pin()`), which checks the live code hashes.

License: MIT.
