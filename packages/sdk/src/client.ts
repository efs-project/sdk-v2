// SPDX-License-Identifier: MIT
// createEfs: an immutable client for one deployment. No network or storage I/O happens at creation; the first
// read pins the deployment (pin.ts) and later reads reuse that result.
import { type Basis, type BasisPolicy, createPool, type Pool } from "./chain/pool.js";
import { type FetchLike, type RequestEvent, type RpcEndpoint, toPort } from "./chain/rpc.js";
import { type CallOpts, EfsFault } from "./core/errors.js";
import { type Address, isAddress, isWord, lower, type PrincipalId } from "./core/hex.js";
import {
  type DeploymentInfo,
  type ProtocolLimits,
  validateDeploymentManifest,
} from "./deployment/manifest.js";
import { type PinResult, pinDeployment } from "./deployment/pin.js";
import { keyPrincipal } from "./protocol/keys.js";

export interface GatewayConfig {
  ipfs?: readonly string[];
  arweave?: readonly string[];
  allowSchemes?: readonly string[];
  maxBytes?: bigint;
  timeoutMs?: number;
}

export interface EfsConfig {
  /** Ordered. A logical read runs on one endpoint at one basis; on failure it restarts on the next one. */
  rpcs: readonly RpcEndpoint[];
  /** The efs-deployment/1 document (fetched by the app; the SDK does no I/O at creation). */
  deployment: unknown;
  gateways?: GatewayConfig;
  onRequest?: (event: RequestEvent) => void;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface Capabilities {
  tags: boolean;
  properties: boolean;
  lists: boolean;
  homes: boolean;
  web3Gateway: boolean;
}

export interface Lens {
  principals: readonly PrincipalId[];
}

export interface LensTools {
  readonly default: Lens;
  from(input: readonly (PrincipalId | Address)[]): Lens;
  mineFirst(me: Address | PrincipalId, base?: Lens): Lens;
  principalOf(account: Address): PrincipalId;
}

export interface Efs {
  readonly deployment: DeploymentInfo;
  readonly limits: ProtocolLimits;
  readonly capabilities: Capabilities;
  readonly lens: LensTools;
  readonly gateways: GatewayConfig;
  /** Verify the deployment against the chain. Runs once; a VERIFIED result is reused. */
  pin(o?: CallOpts): Promise<PinResult>;
  /** A fresh basis for one logical read (pins first if needed). */
  at(policy?: BasisPolicy, o?: CallOpts): Promise<PinResult>;
  /** @internal for SDK modules (files, actions): the endpoint pool and fetch implementation. */
  readonly _internal: {
    pool: Pool;
    fetch: FetchLike | undefined;
    onRequest: ((e: RequestEvent) => void) | undefined;
  };
}

const toPrincipal = (x: PrincipalId | Address): PrincipalId => {
  if (isAddress(x)) return keyPrincipal(x);
  if (isWord(x)) return lower(x);
  throw new EfsFault("MISUSE", `not an address or principal id: ${String(x).slice(0, 20)}`);
};

function lensTools(defaultLens: readonly PrincipalId[], max: number): LensTools {
  const make = (ps: readonly PrincipalId[]): Lens => {
    const seen = new Set<string>();
    const out: PrincipalId[] = [];
    for (const p of ps) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    if (out.length > max)
      throw new EfsFault("LIMIT", `a Lens holds at most ${max} principals (got ${out.length})`);
    return { principals: out };
  };
  const base = make(defaultLens);
  return {
    default: base,
    from: (input) => make(input.map(toPrincipal)),
    mineFirst: (me, b = base) => make([toPrincipal(me), ...b.principals]),
    principalOf: keyPrincipal,
  };
}

export function createEfs(config: EfsConfig): Efs {
  const checked = validateDeploymentManifest(config.deployment);
  if (!checked.ok)
    throw new EfsFault("MISUSE", `invalid deployment document: ${checked.problems.join("; ")}`, {
      details: { problems: checked.problems },
    });
  const deployment = checked.deployment;
  if (!Array.isArray(config.rpcs) || config.rpcs.length === 0)
    throw new EfsFault("MISUSE", "at least one RPC endpoint is required");
  const portOpts = {
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.onRequest ? { onRequest: config.onRequest } : {}),
  };
  const pool = createPool(
    deployment.chainId,
    config.rpcs.map((e) => toPort(e, portOpts)),
    config.timeoutMs ?? 10_000,
  );
  let pinned: Promise<PinResult> | undefined;
  const pin = (o?: CallOpts): Promise<PinResult> => {
    if (!pinned) {
      pinned = pinDeployment(pool, deployment, "latest", o).then((r) => {
        if (r.status !== "VERIFIED") pinned = undefined; // not cached: a later call tries again
        return r;
      });
    }
    return pinned;
  };
  const efs: Efs = {
    deployment,
    limits: deployment.limits,
    capabilities: {
      tags: false,
      properties: false,
      lists: false,
      homes: false,
      web3Gateway: false,
    },
    lens: lensTools(deployment.defaultLens, deployment.limits.maxLensPrincipals),
    gateways: config.gateways ?? {},
    pin,
    // Correct first: every logical read takes a full pin at its own basis. A cheaper re-pin (block + describe,
    // code re-checked only when the revision changes) is a later optimization.
    at: (policy = "latest", o) => pinDeployment(pool, deployment, policy, o),
    _internal: { pool, fetch: config.fetch, onRequest: config.onRequest },
  };
  return Object.freeze(efs);
}

export type { Basis, BasisPolicy };
