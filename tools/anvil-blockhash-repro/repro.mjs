// SPDX-License-Identifier: MIT
// Anvil serves an EIP-1898 block-hash read from another state while it mines bursts. One client toggles automine and
// mines 80-block bursts with a time jump (as test/integration/finality.test.ts does). Three readers each read one
// account's balance at ONE block hash ({ blockHash, requireCanonical: true }) in two separate requests, 2 ms apart.
// At one block hash the two answers must be equal; this counts how often they are not.
//
//   node tools/anvil-blockhash-repro/repro.mjs        (needs Foundry's anvil on PATH; starts and stops its own chain)
import { down, up } from "../fixture.mjs";

const NAME = `anvil-blockhash-repro-${process.pid}`;
const ready = up(NAME, { ttlSeconds: 300 });
let id = 0;
const rpc = async (method, params) => {
  const r = await fetch(ready.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
};
try {
  const [from] = await rpc("eth_accounts", []);
  const to = "0x000000000000000000000000000000000000beef";
  let stop = false;
  const writer = (async () => {
    for (let n = 0; n < 400; n++) {
      await rpc("evm_setAutomine", [false]);
      await rpc("eth_sendTransaction", [{ from, to, value: "0x1" }]);
      await rpc("evm_increaseTime", [60]);
      await rpc("anvil_mine", ["0x50"]);
      await rpc("evm_setAutomine", [true]);
    }
    stop = true;
  })();
  let checks = 0;
  const mismatches = [];
  const reader = async () => {
    while (!stop) {
      const b = await rpc("eth_getBlockByNumber", ["latest", false]);
      const at = { blockHash: b.hash, requireCanonical: true };
      let first;
      let second;
      try {
        first = await rpc("eth_getBalance", [to, at]);
        await new Promise((r) => setTimeout(r, 2));
        second = await rpc("eth_getBalance", [to, at]);
      } catch {
        continue; // a hash that stopped being canonical is refused, which is correct
      }
      checks++;
      if (first !== second)
        mismatches.push({
          block: Number(b.number),
          first: `${BigInt(first)}`,
          second: `${BigInt(second)}`,
        });
    }
  };
  await Promise.all([reader(), reader(), reader()]);
  await writer;
  const client = await rpc("web3_clientVersion", []);
  console.log(
    JSON.stringify(
      { client, checks, mismatches: mismatches.length, sample: mismatches.slice(0, 5) },
      null,
      1,
    ),
  );
  process.exitCode = mismatches.length > 0 ? 1 : 0;
} finally {
  down(NAME);
}
