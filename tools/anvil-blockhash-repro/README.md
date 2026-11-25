# Anvil answers one block hash from two states

**What:** while one client toggles automine and mines bursts of blocks, two separate `eth_getBalance` requests for the
same account at the same block hash (EIP-1898, `{ blockHash, requireCanonical: true }`) sometimes return different
balances. At one block hash they must be equal. Within one JSON-RPC request every call agrees; the split is across
requests.

**Version:** `anvil/v1.8.3`. Observed on 2026-11-25: 43 of 1,893 pairs disagreed, in both directions (for example
37 then 38, and 180 then 179).

**Run it** (Foundry's `anvil` on PATH; it starts and stops its own fixture chain):

```bash
node tools/anvil-blockhash-repro/repro.mjs
```

It exits 1 when it sees a mismatch.

**Steps** (all in `repro.mjs`):

1. A writer loops 400 times: `evm_setAutomine(false)`, `eth_sendTransaction` (1 wei to a fixed account),
   `evm_increaseTime(60)`, `anvil_mine(0x50)`, `evm_setAutomine(true)`. This is what the SDK's finality tests do.
2. Three readers loop: take `latest`, then read the account's balance at that block hash twice, in two requests
   2 ms apart, and compare the two answers.

**Why it matters here:**
- The SDK pins every logical read to one block hash and cross-checks its readers.
- Under this bug, a listing's page reader and Lens reader can see two states of "one" block. The SDK then answers
  UNKNOWN (BASIS_STALE), never a wrong value, and `listFolder` reads the page again a bounded number of times, saying
  so in `rereads`.
- The SDK's integration tests run one file at a time, so the finality tests' bursts don't race the other files' reads.

Not yet reported upstream.
