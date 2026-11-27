// SPDX-License-Identifier: MIT
// The cold pin (contracts tools/RELEASE.md "Cold pin"): one block, describe() at that block, the ledger proxy's
// ERC-1967 implementation slot and five code hashes, compared with the deployment document. Until this passes,
// nothing describe() says about code is trusted.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { getBlock } from "../chain/basis.js";
import type { FloorBlock } from "../chain/floor.js";
import {
  type Attempt,
  type Basis,
  type BasisPolicy,
  onEndpoint,
  type Pool,
  type PoolResult,
  type Session,
  type Step,
} from "../chain/pool.js";
import { type CallOpts, EfsFault, type Reason, reason, throwIfAborted } from "../core/errors.js";
import { type Hex, lower } from "../core/hex.js";
import { setTimer } from "../core/platform.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import { STATUS_VOCABULARY_ID } from "../generated/constants.js";
import type { DeploymentInfo } from "./manifest.js";

/** keccak256("eip1967.proxy.implementation") - 1 */
const IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export interface Evidence {
  attempts: readonly Attempt[];
  requests: number;
}
export interface PinMismatch {
  what: string;
  expected: string;
  actual: string;
}
/** What the pin learned about the live deployment at its basis. */
export interface LiveDeployment {
  executionSet: Hex;
  revision: number;
  layoutId: Hex;
  capabilities: number;
  frozen: boolean;
  admissions: bigint;
}
export type PinResult =
  | { kind: "efs.pin"; status: "VERIFIED"; basis: Basis; live: LiveDeployment; evidence: Evidence }
  | {
      kind: "efs.pin";
      status: "MISMATCH";
      basis: Basis;
      mismatches: readonly PinMismatch[];
      evidence: Evidence;
    }
  | { kind: "efs.pin"; status: "UNKNOWN"; reason: Reason; evidence: Evidence };

type Describe = {
  realmId: Hex;
  acceptedChainId: bigint;
  executionSet: Hex;
  revision: number;
  layoutId: Hex;
  capabilities: number;
  ledgerImpl: Hex;
  ledgerImplCodehash: Hex;
  frozen: boolean;
  admissions: bigint;
  statusVocabularyId: Hex;
};

/** keccak256 of empty code: EXTCODEHASH of an account that exists but has no code. */
const EMPTY_CODEHASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

/**
 * Initcode for a deployless eth_call (no `to`) that returns EXTCODEHASH of each address as consecutive words after
 * one zero word: per address `PUSH20 addr; EXTCODEHASH; PUSH2 32*(i+1); MSTORE`, then `PUSH2 32*(n+1); PUSH1 0;
 * RETURN`. It checks every code hash on every pin for 32 bytes of response per contract, instead of downloading each
 * contract's bytecode. The returned bytes are the "code" the creation would deploy, and EIP-3541 refuses code that
 * starts with 0xEF: the zero word in front keeps a code hash that starts with 0xEF from failing the whole call.
 */
export function codehashProbe(addresses: readonly Hex[]): Hex {
  if (addresses.length > 64) throw new RangeError("at most 64 addresses per probe");
  const push2 = (n: number) => `61${n.toString(16).padStart(4, "0")}`;
  let code = "";
  addresses.forEach((a, i) => {
    code += `73${a.slice(2).toLowerCase()}3f${push2((i + 1) * 32)}52`;
  });
  code += `${push2((addresses.length + 1) * 32)}6000f3`;
  return `0x${code}`;
}

/**
 * Pins this client verified, by deployment, endpoint and block hash. Private and in memory only: a pin is a
 * security decision, so it is never read back from a store anything else could write (a caller's persistent
 * cache, another tab). Bounded; a new block or another endpoint is verified again in full.
 */
export class PinMemory {
  private readonly entries = new Map<string, { basis: Basis; live: LiveDeployment }>();
  private readonly max: number;
  constructor(max = 256) {
    this.max = max;
  }
  get(key: string): { basis: Basis; live: LiveDeployment } | undefined {
    return this.entries.get(key);
  }
  set(key: string, v: { basis: Basis; live: LiveDeployment }): void {
    this.entries.delete(key);
    this.entries.set(key, v);
    while (this.entries.size > this.max)
      this.entries.delete(this.entries.keys().next().value as string);
  }
}

/** `o.atLeast`, checked: MISUSE for anything but a non-negative block number and an optional 32-byte hash. */
function atLeastOf(
  o: CallOpts,
): FloorBlock | { blockNumber: bigint; blockHash?: undefined } | undefined {
  const a = o.atLeast;
  if (a === undefined) return undefined;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof a.blockNumber !== "bigint" ||
    a.blockNumber < 0n
  )
    throw new EfsFault("MISUSE", "atLeast.blockNumber must be a bigint block number, 0 or more");
  if (a.blockHash === undefined) return { blockNumber: a.blockNumber };
  if (typeof a.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.blockHash))
    throw new EfsFault("MISUSE", "atLeast.blockHash must be a 32-byte hex block hash");
  return { blockNumber: a.blockNumber, blockHash: lower(a.blockHash) };
}

/** Wait `ms`, or reject with the caller's abort as soon as it fires. */
function pause(ms: number, o: CallOpts): Promise<void> {
  throwIfAborted(o.signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      try {
        throwIfAborted(o.signal);
      } catch (e) {
        reject(e);
      }
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    setTimer(() => {
      o.signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

/** Poll times when every endpoint is behind, as fractions of the floor's wait (4 s: 0.5, 1, 2 and 3.5 s). */
const POLLS = [0.125, 0.25, 0.5, 0.875];

export async function pinDeployment(
  pool: Pool,
  d: DeploymentInfo,
  policy: BasisPolicy,
  o: CallOpts = {},
  memory?: PinMemory,
): Promise<PinResult> {
  const floor = pool.floor;
  const atLeast = atLeastOf(o);
  let requests = 0;
  // A mismatch on one endpoint may mean that endpoint lies: try the others, and report MISMATCH only if none verifies.
  let lastMismatch: { basis: Basis; mismatches: PinMismatch[] } | undefined;
  // The endpoints that offered a block below the floor in the latest round, and the floor they were held to.
  let behind: { endpoint: string; blockNumber: bigint }[] = [];
  let heldTo: { blockNumber: bigint; blockHash?: Hex } | undefined;
  const step = async (
    s: Session,
  ): Promise<Step<{ basis: Basis; mismatches: PinMismatch[]; live: LiveDeployment }>> => {
    requests += 1;
    const block = await getBlock(s, policy);
    if (!block.ok) return block;
    const b = block.value;
    // A floor from the journal binds only on the chain it was recorded on: decided by the genesis block hash, read
    // once per instance, and only when the seed would hold this read back (never on the happy path).
    if (policy === "latest")
      for (let seed = floor.bindingSeed(b.number); seed; seed = floor.bindingSeed(b.number)) {
        if (floor.genesis === undefined) {
          requests += 1;
          const g = await getBlock(s, 0n);
          if (!g.ok) return g;
          floor.genesis = g.value.hash;
        }
        floor.settleSeed(seed, floor.genesis);
      }
    // Never older than a block this client has already read, nor than the caller's atLeast: the higher of the two.
    const own = floor.need(policy);
    const need = !atLeast || (own && own.blockNumber >= atLeast.blockNumber) ? own : atLeast;
    if (need && b.number < need.blockNumber) {
      behind.push({ endpoint: s.port.label, blockNumber: b.number });
      heldTo = {
        blockNumber: need.blockNumber,
        ...(need.blockHash ? { blockHash: need.blockHash } : {}),
      };
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason(
          "BEHIND",
          "transient",
          `this endpoint's head is block ${b.number}, below block ${need.blockNumber} this client must read at or after`,
        ),
      };
    }
    // atLeast with a hash: is that block still canonical as this head sees it? Once per (endpoint, head, height).
    let reorgedSince: Basis["reorgedSince"];
    if (atLeast?.blockHash) {
      let at: Hex | undefined;
      if (b.number === atLeast.blockNumber) at = b.hash;
      else {
        const k = `${s.port.label}:${b.hash}:${atLeast.blockNumber}`;
        at = floor.hashAt(k);
        if (!at) {
          requests += 1;
          const h = await getBlock(s, atLeast.blockNumber);
          if (!h.ok) return h;
          at = h.value.hash;
          floor.rememberHash(k, at);
        }
      }
      if (at.toLowerCase() !== atLeast.blockHash)
        reorgedSince = { blockNumber: atLeast.blockNumber, blockHash: atLeast.blockHash };
    }
    const withReorg = (basis: Basis): Basis => (reorgedSince ? { ...basis, reorgedSince } : basis);
    // A VERIFIED pin for this exact deployment, endpoint and block hash: state at a block hash never changes, so
    // it stays true. Anything else (another block, another endpoint) is verified again in full.
    const key =
      `efs-pin/1:${d.chainId}:${d.ledger}:${d.realmId}:${s.port.label}:${b.hash}`.toLowerCase();
    const seen = memory?.get(key);
    if (seen) return { ok: true, value: { ...seen, basis: withReorg(seen.basis), mismatches: [] } };
    const at = { blockHash: block.value.hash };
    const describeCall = encodeFunctionData({
      abi: ledgerReadsAbi,
      functionName: "describe",
      args: [d.ledger],
    });
    // Every contract the SDK reads through, with the code hash the document recorded for it. The newer ones are
    // checked whenever the document names them. The web3:// gateway (EfsWeb3Gateway) and its content contract
    // (EfsWeb3Content) are deliberately not pinned: a web3:// read is verified by the file's digest (length and
    // sha256), so a gateway that lies can only make a read UNAVAILABLE, never wrong.
    const pinned: { what: string; address: Hex; codehash: Hex }[] = [
      {
        what: "ledger implementation",
        address: d.ledgerImplementation,
        codehash: d.codehashes.ledgerImplementation,
      },
      { what: "LedgerReads", address: d.readers.ledgerReads, codehash: d.codehashes.ledgerReads },
      { what: "LedgerViews", address: d.readers.ledgerViews, codehash: d.codehashes.ledgerViews },
      { what: "LensReader", address: d.readers.lens, codehash: d.codehashes.lens },
      { what: "FilesPageReader", address: d.readers.filesPage, codehash: d.codehashes.filesPage },
    ];
    const optional: [string, Hex | null, Hex | null][] = [
      ["index", d.index.address, d.codehashes.index],
      ["IndexReads", d.index.reads, d.codehashes.indexReads],
      ["TopicMineReader", d.readers.topicMine, d.codehashes.topicMine],
      ["TopicEveryoneReader", d.readers.topicEveryone, d.codehashes.topicEveryone],
      ["TopicLookupReader", d.readers.topicLookup, d.codehashes.topicLookup],
    ];
    for (const [what, address, codehash] of optional)
      if (address && codehash) pinned.push({ what, address, codehash });
    const codeAddresses = pinned.map((x) => x.address);
    requests += 1; // one batch envelope (3 calls)
    const outs = await s.send([
      { method: "eth_call", params: [{ to: d.readers.ledgerReads, data: describeCall }, at] },
      { method: "eth_getStorageAt", params: [d.ledger, IMPLEMENTATION_SLOT, at] },
      { method: "eth_call", params: [{ data: codehashProbe(codeAddresses) }, at] },
    ]);
    const failed = outs.find((x) => !x.ok);
    if (failed && !failed.ok) return { ok: false, retryElsewhere: true, reason: failed.reason };
    const [desc, slot, probe] = outs.map((x) => (x.ok ? (x.result as Hex) : "0x")) as Hex[];
    let described: Describe;
    try {
      described = decodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "describe",
        data: desc as Hex,
      }) as unknown as Describe;
    } catch {
      // One endpoint's garbled reply: another may answer (only a decoded describe() can be a mismatch).
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", "describe() did not decode"),
      };
    }
    const mismatches: PinMismatch[] = [];
    const eq = (what: string, expected: string, actual: string): void => {
      if (expected.toLowerCase() !== actual.toLowerCase())
        mismatches.push({ what, expected, actual });
    };
    const implFromSlot = `0x${String(slot).slice(-40)}`;
    eq("realmId", d.realmId, described.realmId);
    eq("acceptedChainId", String(d.chainId), String(described.acceptedChainId));
    eq("layoutId", d.layoutId, described.layoutId);
    // The status mapping this SDK applies (protocol/status.ts) must be the deployment's own vocabulary.
    eq("status vocabulary", STATUS_VOCABULARY_ID, described.statusVocabularyId);
    eq("implementation (ERC-1967 slot)", d.ledgerImplementation, implFromSlot);
    eq("implementation (describe)", d.ledgerImplementation, described.ledgerImpl);
    eq(
      "code: describe().ledgerImplCodehash",
      d.codehashes.ledgerImplementation,
      described.ledgerImplCodehash,
    );
    const words = /^0x[0-9a-f]*$/i.test(String(probe)) ? String(probe).slice(2) : "";
    if (words.length !== (codeAddresses.length + 1) * 64 || !/^0{64}/.test(words))
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("RPC_ERROR", "transient", "code hash probe returned the wrong length"),
      };
    pinned.forEach((x, i) => {
      const h = `0x${words.slice((i + 1) * 64, (i + 2) * 64).toLowerCase()}`;
      eq(`code: ${x.what}`, x.codehash, /^0x0{64}$/.test(h) || h === EMPTY_CODEHASH ? "absent" : h);
    });
    const basis: Basis = {
      chainId: d.chainId,
      blockNumber: block.value.number,
      blockHash: block.value.hash,
      timestamp: block.value.timestamp,
      executionSet: lower(described.executionSet),
      admissions: BigInt(described.admissions),
      endpoint: s.port.label,
    };
    const live: LiveDeployment = {
      executionSet: lower(described.executionSet),
      revision: Number(described.revision),
      layoutId: lower(described.layoutId),
      capabilities: Number(described.capabilities),
      frozen: described.frozen,
      admissions: BigInt(described.admissions),
    };
    if (mismatches.length) {
      lastMismatch = { basis, mismatches };
      return {
        ok: false,
        retryElsewhere: true,
        reason: reason("NOT_VERIFIED_DEPLOYMENT", "never", `${mismatches.length} mismatch(es)`),
      };
    }
    memory?.set(key, { basis, live });
    return { ok: true, value: { basis: withReorg(basis), mismatches, live } };
  };
  // Every endpoint behind: poll a few times within the floor's wait, then UNKNOWN BEHIND. Never an older read.
  const started = Date.now();
  const attempts: Attempt[] = [];
  let r: PoolResult<{ basis: Basis; mismatches: PinMismatch[]; live: LiveDeployment }>;
  for (let round = 0; ; round++) {
    behind = [];
    r = await onEndpoint(pool, step, o);
    attempts.push(...r.attempts);
    const at = POLLS[round];
    if (r.ok || lastMismatch || behind.length === 0 || at === undefined || floor.behindWaitMs <= 0)
      break;
    await pause(started + Math.round(at * floor.behindWaitMs) - Date.now(), o);
  }
  const evidence: Evidence = { attempts, requests };
  if (!r.ok) {
    if (lastMismatch)
      return {
        kind: "efs.pin",
        status: "MISMATCH",
        basis: lastMismatch.basis,
        mismatches: lastMismatch.mismatches,
        evidence,
      };
    if (behind.length > 0 && heldTo) {
      const why: Reason = {
        ...reason(
          "BEHIND",
          "transient",
          `every endpoint is behind block ${heldTo.blockNumber} (served ${behind.map((x) => `${x.endpoint} at ${x.blockNumber}`).join(", ")}); retry`,
        ),
        floor: heldTo,
        served: behind,
      };
      // A BEHIND episode for this policy: onCaughtUp's listeners wait for the next pin under it that serves.
      floor.markBehind(policy);
      return { kind: "efs.pin", status: "UNKNOWN", reason: why, evidence };
    }
    return { kind: "efs.pin", status: "UNKNOWN", reason: r.reason, evidence };
  }
  // Only a VERIFIED pin raises the floor: a call pinned to a block hash (a page, a body) never does.
  floor.raise(policy, r.value.basis);
  floor.served(policy, r.value.basis);
  return {
    kind: "efs.pin",
    status: "VERIFIED",
    basis: r.value.basis,
    live: r.value.live,
    evidence,
  };
}
