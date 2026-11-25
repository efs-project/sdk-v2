// SPDX-License-Identifier: MIT
// Waiting for a receipt: bounded, and only to avoid racing reconcile. The ledger decides the outcome.
import type { Efs } from "../client.js";
import type { CallOpts } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import { setTimer } from "../core/platform.js";

/** Wait (bounded) until a transaction has a receipt. Reconcile decides the outcome; this only avoids racing it. */
export async function waitForReceipt(
  efs: Efs,
  txHash: Hex,
  o: CallOpts = {},
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  const port = efs._internal.pool.ports[0];
  if (!port) return;
  while (Date.now() - started < timeoutMs) {
    const [out] = await port.send([{ method: "eth_getTransactionReceipt", params: [txHash] }], {
      timeoutMs: 5000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (out?.ok && out.result) return;
    await new Promise<void>((r) => {
      setTimer(r, 250);
    });
  }
}
