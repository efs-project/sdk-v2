// SPDX-License-Identifier: MIT
// createEfs: an immutable client for one deployment. No network or storage I/O happens at creation; the first
// read pins the deployment (pin.ts) and later reads reuse that result.

import { type ByteStore, memoryByteStore } from "./cache/stores.js";
import { ReadFloor, type ReadFloors } from "./chain/floor.js";
import { type Basis, type BasisPolicy, createPool, type Pool } from "./chain/pool.js";
import { type FetchLike, type RequestEvent, type RpcEndpoint, toPort } from "./chain/rpc.js";
import { type CallOpts, EfsFault } from "./core/errors.js";
import { type Address, type Hex, isAddress, isWord, lower, type PrincipalId } from "./core/hex.js";
import {
  type DeploymentInfo,
  type ProtocolLimits,
  validateDeploymentManifest,
} from "./deployment/manifest.js";
import { PinMemory, type PinResult, pinDeployment } from "./deployment/pin.js";
import { keyPrincipal, type PrincipalDisplay, principalDisplay } from "./protocol/keys.js";

export interface GatewayConfig {
  /**
   * Ordered IPFS gateway origins, tried in order (the first whose bytes match the descriptor's length and sha256
   * wins). None by default: the SDK names no third party, so ipfs:// reads are POLICY_BLOCKED (rule "no-gateway")
   * until the app names its gateways.
   */
  ipfs?: readonly string[];
  /** Ordered Arweave gateway origins, as `ipfs` (none by default). */
  arweave?: readonly string[];
  /**
   * Location schemes that may be fetched (default ipfs, ar, data, web3; a publisher's https is off, since its server
   * sees the reader). Others return POLICY_BLOCKED.
   */
  allowSchemes?: readonly string[];
  /** Allow plain http:// locations (default false). */
  allowInsecureHttp?: boolean;
  /** Allow locations naming private, loopback, link-local or metadata hosts (default false). */
  allowPrivateHosts?: boolean;
  /** Largest file or range fetched (default 50 MiB). */
  maxBytes?: bigint;
  /** Per-attempt timeout in milliseconds (default 10 000). */
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
  /**
   * The byte cache (verified record bodies and external content). The default is in memory only, so nothing is
   * written to storage unless the app passes a persistent store (for example `indexedDbByteStore()` from
   * `@efs/sdk/web/cache`). Entries are re-verified on every read. Verified pins are kept privately in memory and are
   * never read from a store.
   */
  cache?: { bytes?: ByteStore };
  /**
   * The read floor (a read is never served from a block older than one this client has already read).
   * `behindWaitMs`: how long a read polls when every endpoint is behind, before it is UNKNOWN BEHIND. Default 4000.
   */
  reads?: { behindWaitMs?: number };
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
  /**
   * The Lens for viewing a place (a folder or a home; later a topic): the reader first, then the place's owner
   * (FolderRef.owner, or HomeRef.owner: the address's author identity as of a read, from openHome or a listing), then
   * `base` (default: the client's default Lens), each principal once.
   * Pass `owner: null` to leave the owner out (the reader switched it off). "Everyone" (public) arrives with the
   * contracts' all-authors lists and is not a Lens principal.
   */
  place(o: {
    reader?: Address | PrincipalId;
    owner?: Address | PrincipalId | null;
    base?: Lens;
  }): Lens;
  principalOf(account: Address): PrincipalId;
  /**
   * What a person should see for a principal: a key principal's checksummed address, a contract principal's address
   * when it is one of `contracts` (recomputed in this deployment's Realm), else the id. Pure; see principalDisplay.
   */
  displayOf(principal: PrincipalId, o?: { contracts?: readonly Address[] }): PrincipalDisplay;
}

export interface Efs {
  readonly deployment: DeploymentInfo;
  readonly limits: ProtocolLimits;
  readonly capabilities: Capabilities;
  readonly lens: LensTools;
  readonly gateways: GatewayConfig;
  /** Verify the deployment against the chain. Runs once; a VERIFIED result is reused. */
  pin(o?: CallOpts): Promise<PinResult>;
  /**
   * A fresh basis for one logical read (pins first if needed), never older than a block this client has already
   * read under the same or a stricter policy (`latest` ≥ `safe` ≥ `finalized`), nor than `o.atLeast`.
   */
  at(policy?: BasisPolicy, o?: CallOpts): Promise<PinResult>;
  /** The highest block this client has read, per policy: post it to a worker or another tab as `atLeast`. */
  readFloor(): ReadFloors;
  /**
   * Forget the read floor, and ignore the saves the journal has offered so far as floors on this instance: for a
   * dev chain that was reset or rewound (`anvil_reset`, `evm_revert`), where every endpoint is now below a block
   * this client read and reads stay BEHIND. Never needed on a live chain; a new client starts with no floor.
   */
  resetReadFloor(): void;
  /** @internal for SDK modules (files, actions): the endpoint pool and fetch implementation. */
  readonly _internal: {
    pool: Pool;
    fetch: FetchLike | undefined;
    onRequest: ((e: RequestEvent) => void) | undefined;
    cache: { bytes: ByteStore };
  };
}

const toPrincipal = (x: PrincipalId | Address): PrincipalId => {
  if (isAddress(x)) return keyPrincipal(x);
  if (isWord(x)) return lower(x);
  throw new EfsFault("MISUSE", `not an address or principal id: ${String(x).slice(0, 20)}`);
};

function lensTools(defaultLens: readonly PrincipalId[], max: number, realmOrigin: Hex): LensTools {
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
    place: ({ reader, owner, base: b = base }) =>
      make([
        ...(reader !== undefined ? [toPrincipal(reader)] : []),
        ...(owner !== undefined && owner !== null ? [toPrincipal(owner)] : []),
        ...b.principals,
      ]),
    principalOf: keyPrincipal,
    displayOf: (principal, o = {}) => principalDisplay(principal, realmOrigin, o.contracts ?? []),
  };
}

/**
 * Create a client for one EFS deployment. It checks the deployment document (MISUSE when it is invalid) and does no
 * I/O: every read pins its own basis (`efs.at`), and nothing is fetched until a read or write asks.
 */
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
  let floor: ReadFloor;
  try {
    floor = new ReadFloor(config.reads?.behindWaitMs ?? 4000);
  } catch (e) {
    throw new EfsFault("MISUSE", e instanceof Error ? e.message : String(e));
  }
  const pool = createPool(
    deployment.chainId,
    config.rpcs.map((e) => toPort(e, portOpts)),
    config.timeoutMs ?? 10_000,
    floor,
  );
  const cache = { bytes: config.cache?.bytes ?? memoryByteStore() };
  const pins = new PinMemory();
  let pinned: Promise<PinResult> | undefined;
  const pin = (o?: CallOpts): Promise<PinResult> => {
    if (!pinned) {
      pinned = pinDeployment(pool, deployment, "latest", o, pins).then((r) => {
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
    lens: lensTools(
      deployment.defaultLens,
      deployment.limits.maxLensPrincipals,
      deployment.realmOrigin,
    ),
    gateways: config.gateways ?? {},
    pin,
    // Every logical read takes a pin at its own basis. A VERIFIED pin is remembered for that endpoint and block
    // hash only, so a new block (or another endpoint) is verified again in full.
    at: (policy = "latest", o) => pinDeployment(pool, deployment, policy, o, pins),
    readFloor: () => floor.snapshot(),
    resetReadFloor: () => floor.reset(),
    _internal: { pool, fetch: config.fetch, onRequest: config.onRequest, cache },
  };
  return Object.freeze(efs);
}

export type { Basis, BasisPolicy };
