# @efs/fixture

A local EFS chain for live-chain tests. `startFixtureChain()` runs the contracts' own fixture tool from the snapshot
this package was built with:
- anvil on a free loopback port;
- the genesis deployment and the ten Files Types;
- the seed: the root, `docs/`, and three files (`readme.txt` inline, `big.bin` as a span tree, `remote.txt` at an
  external locator), all owned by the fixture principal (anvil account #0).

anvil's ten default accounts stay unlocked, so a test wallet can forward `eth_sendTransaction` to anvil. That is the
same path a real wallet takes through `createWriter({ authorizer: { kind: "eip1193", profile: "direct", … } })`.

Node only. Needs `anvil` (Foundry; CI pins 1.8.3) and `perl` (the watchdog that stops anvil after `ttlSeconds`).
The contracts commit is in `contracts/PROVENANCE.json` and `chain.contracts.commit`: vendor this tarball together
with the `@efs/sdk` tarball packed from the same commit.

```js
import { startFixtureChain } from "@efs/fixture";
import { createEfs } from "@efs/sdk";

const chain = await startFixtureChain();          // { rpcUrl, chainId, deployment, accounts, seed, contracts, stop }
const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
// … edit chain.seed.files[0] as chain.accounts.fixture.address through your EIP-1193 provider …
await chain.stop();
```

Options: `anvilPath` (an `anvil` binary; default `anvil` on PATH), `port` (default: a free port), `ttlSeconds`
(default 900; 0 = never), `home` (lease and state directory; default a temporary one, removed by `stop()`).

The keys are anvil's public development keys: never use them with value. License: MIT.
