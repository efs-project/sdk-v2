// SPDX-License-Identifier: MIT
// Pin a read to one block (by hash) and make calls at that block (EIP-1898), so every call in a logical read sees
// the same state. After the read, the block can be re-checked: if its hash is no longer canonical, the read is
// reported as REORGED instead of being presented as fresh.
import { reason } from "../core/errors.js";
import type { Address, Hex } from "../core/hex.js";
import type { BasisPolicy, Session, Step } from "./pool.js";
import type { RpcOutcome } from "./rpc.js";

export interface Block {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

const asStep = <T>(out: RpcOutcome, map: (result: unknown) => T | null, what: string): Step<T> => {
  if (!out.ok) return { ok: false, retryElsewhere: true, reason: out.reason };
  const v = map(out.result);
  return v === null
    ? { ok: false, retryElsewhere: true, reason: reason("RPC_ERROR", "transient", `bad ${what}`) }
    : { ok: true, value: v };
};
const block = (r: unknown): Block | null => {
  const b = r as { number?: string; hash?: string; timestamp?: string } | null;
  if (!b || typeof b.hash !== "string" || typeof b.number !== "string") return null;
  return {
    number: BigInt(b.number),
    hash: b.hash.toLowerCase() as Hex,
    timestamp: BigInt(b.timestamp ?? "0x0"),
  };
};

export async function getBlock(s: Session, at: BasisPolicy | bigint): Promise<Step<Block>> {
  const tag = typeof at === "bigint" ? `0x${at.toString(16)}` : at;
  return asStep(await s.request("eth_getBlockByNumber", [tag, false]), block, "block");
}

export interface CallRequest {
  to: Address;
  data: Hex;
  from?: Address;
}

/** eth_call several requests at one block hash, as one batch where the transport allows it. */
export async function callsAt(
  s: Session,
  blockHash: Hex,
  calls: readonly CallRequest[],
): Promise<RpcOutcome[]> {
  return s.send(
    calls.map((c) => ({
      method: "eth_call",
      params: [
        { to: c.to, data: c.data, ...(c.from ? { from: c.from } : {}) },
        { blockHash, requireCanonical: true },
      ],
    })),
  );
}

/** Is `hash` still the canonical block at `number`? */
export async function stillCanonical(
  s: Session,
  number: bigint,
  hash: Hex,
): Promise<Step<boolean>> {
  const b = await getBlock(s, number);
  return b.ok ? { ok: true, value: b.value.hash === hash.toLowerCase() } : b;
}
