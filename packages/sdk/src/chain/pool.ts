// SPDX-License-Identifier: MIT
// An ordered list of RPC endpoints for ONE chain. A logical read runs on one endpoint at one basis (block hash);
// if that endpoint fails, the whole read restarts on the next endpoint at a fresh basis. Results are never
// stitched across endpoints or bases. Every endpoint is checked against the expected chain id before first use.
import { type CallOpts, type Reason, reason, throwIfAborted } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import type { RpcOutcome, RpcPort, RpcRequest } from "./rpc.js";

export interface Attempt {
  endpoint: string;
  outcome: "OK" | "FAILED";
  reason?: Reason;
  ms: number;
}

export interface Basis {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  /** The basis block's timestamp (unix seconds). Absent in results recorded before 0.1 carried it. */
  timestamp?: bigint;
  /** Execution set from describe() at this basis; "0x" until the deployment pin reads it. */
  executionSet: Hex;
  /**
   * How many admissions the ledger had at this basis (describe().admissions). Compare it with a head's `admission`
   * to tell whether the head was set before this basis or after it. Absent before the pin reads it.
   */
  admissions?: bigint;
  /** Label or origin of the endpoint that served this basis. Never a URL. */
  endpoint: string;
}
export type BasisPolicy = "latest" | "safe" | "finalized";

/** What a read step can say about one attempt. `retryElsewhere` restarts the read on the next endpoint. */
export type Step<T> =
  | { ok: true; value: T }
  | { ok: false; retryElsewhere: boolean; reason: Reason };

export interface Pool {
  readonly chainId: number;
  readonly ports: readonly RpcPort[];
  readonly timeoutMs: number;
  /** Per-endpoint chain check results, cached for this pool's lifetime. */
  readonly checked: Map<string, Promise<Reason | null>>;
}

export function createPool(chainId: number, ports: readonly RpcPort[], timeoutMs = 10_000): Pool {
  if (ports.length === 0) throw new TypeError("at least one RPC endpoint is required");
  return { chainId, ports, timeoutMs, checked: new Map() };
}

/** One endpoint, used for one logical read. */
export interface Session {
  readonly port: RpcPort;
  readonly chainId: number;
  send(requests: readonly RpcRequest[]): Promise<RpcOutcome[]>;
  request(method: string, params: readonly unknown[]): Promise<RpcOutcome>;
}

function checkChain(pool: Pool, port: RpcPort, o: CallOpts): Promise<Reason | null> {
  let pending = pool.checked.get(port.label);
  if (!pending) {
    pending = port
      .send([{ method: "eth_chainId", params: [] }], {
        timeoutMs: pool.timeoutMs,
        ...(o.signal ? { signal: o.signal } : {}),
      })
      .then(([out]) => {
        if (!out?.ok) {
          pool.checked.delete(port.label); // transient: check again next time
          return out ? out.reason : reason("RPC_UNAVAILABLE", "transient");
        }
        const got = Number.parseInt(String(out.result), 16);
        return got === pool.chainId
          ? null
          : reason(
              "CHAIN_MISMATCH",
              "never",
              `endpoint serves chain ${got}, deployment is on ${pool.chainId}`,
            );
      });
    pool.checked.set(port.label, pending);
  }
  return pending;
}

export type PoolResult<T> =
  | { ok: true; value: T; endpoint: string; attempts: Attempt[] }
  | { ok: false; reason: Reason; attempts: Attempt[] };

/** Run `read` on the first healthy endpoint; on a retryable failure, restart it on the next one. */
export async function onEndpoint<T>(
  pool: Pool,
  read: (s: Session) => Promise<Step<T>>,
  o: CallOpts = {},
): Promise<PoolResult<T>> {
  const attempts: Attempt[] = [];
  let last: Reason = reason("RPC_UNAVAILABLE", "transient", "no endpoint answered");
  for (const port of pool.ports) {
    throwIfAborted(o.signal);
    const started = Date.now();
    const chain = await checkChain(pool, port, o);
    if (chain) {
      attempts.push({
        endpoint: port.label,
        outcome: "FAILED",
        reason: chain,
        ms: Date.now() - started,
      });
      last = chain;
      continue;
    }
    const call = { timeoutMs: pool.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) };
    const session: Session = {
      port,
      chainId: pool.chainId,
      send: (requests) => port.send(requests, call),
      request: async (method, params) =>
        (await port.send([{ method, params }], call))[0] as RpcOutcome,
    };
    const step = await read(session);
    if (step.ok) {
      attempts.push({ endpoint: port.label, outcome: "OK", ms: Date.now() - started });
      return { ok: true, value: step.value, endpoint: port.label, attempts };
    }
    attempts.push({
      endpoint: port.label,
      outcome: "FAILED",
      reason: step.reason,
      ms: Date.now() - started,
    });
    last = step.reason;
    if (!step.retryElsewhere) break;
  }
  return { ok: false, reason: last, attempts };
}
