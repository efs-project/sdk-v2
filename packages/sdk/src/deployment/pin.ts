// SPDX-License-Identifier: MIT
// The cold pin (contracts tools/RELEASE.md "Cold pin"): one block, describe() at that block, the ledger proxy's
// ERC-1967 implementation slot and five code hashes, compared with the deployment document. Until this passes,
// nothing describe() says about code is trusted.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { cacheGet, cachePut, type ResultStore } from "../cache/stores.js";
import { getBlock } from "../chain/basis.js";
import {
  type Attempt,
  type Basis,
  type BasisPolicy,
  onEndpoint,
  type Pool,
} from "../chain/pool.js";
import { type CallOpts, type Reason, reason } from "../core/errors.js";
import { type Hex, lower } from "../core/hex.js";
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
 * Initcode for a deployless eth_call (no `to`) that returns EXTCODEHASH of each address as consecutive words:
 * per address `PUSH20 addr; EXTCODEHASH; PUSH1 32*i; MSTORE`, then `PUSH1 32*n; PUSH1 0; RETURN`. It checks every
 * code hash on every pin for 32 bytes of response per contract, instead of downloading each contract's bytecode.
 */
export function codehashProbe(addresses: readonly Hex[]): Hex {
  if (addresses.length > 7) throw new RangeError("at most 7 addresses per probe");
  let code = "";
  addresses.forEach((a, i) => {
    code += `73${a.slice(2).toLowerCase()}3f60${(i * 32).toString(16).padStart(2, "0")}52`;
  });
  code += `60${(addresses.length * 32).toString(16).padStart(2, "0")}6000f3`;
  return `0x${code}`;
}

const isCachedPin = (v: unknown, blockHash: Hex): v is { basis: Basis; live: LiveDeployment } => {
  const c = v as { basis?: Basis; live?: LiveDeployment } | undefined;
  return (
    !!c?.basis &&
    !!c.live &&
    c.basis.blockHash === blockHash &&
    typeof c.basis.blockNumber === "bigint"
  );
};

export async function pinDeployment(
  pool: Pool,
  d: DeploymentInfo,
  policy: BasisPolicy,
  o: CallOpts = {},
  results?: ResultStore,
): Promise<PinResult> {
  let requests = 0;
  // A mismatch on one endpoint may mean that endpoint lies: try the others, and report MISMATCH only if none verifies.
  let lastMismatch: { basis: Basis; mismatches: PinMismatch[] } | undefined;
  const r = await onEndpoint<{ basis: Basis; mismatches: PinMismatch[]; live: LiveDeployment }>(
    pool,
    async (s) => {
      requests += 1;
      const block = await getBlock(s, policy);
      if (!block.ok) return block;
      // A VERIFIED pin for this exact deployment, endpoint and block hash: state at a block hash never changes, so
      // it stays true. Anything else (another block, another endpoint) is verified again in full.
      const key =
        `efs-pin/1:${d.chainId}:${d.ledger}:${d.realmId}:${s.port.label}:${block.value.hash}`.toLowerCase();
      const seen = results ? await cacheGet(() => results.get(key)) : undefined;
      if (isCachedPin(seen, block.value.hash))
        return { ok: true, value: { ...seen, mismatches: [] } };
      const at = { blockHash: block.value.hash };
      const describeCall = encodeFunctionData({
        abi: ledgerReadsAbi,
        functionName: "describe",
        args: [d.ledger],
      });
      const codeAddresses = [
        d.ledgerImplementation,
        d.readers.ledgerReads,
        d.readers.ledgerViews,
        d.readers.lens,
        d.readers.filesPage,
      ];
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
        return {
          ok: false,
          retryElsewhere: false,
          reason: reason("NOT_VERIFIED_DEPLOYMENT", "never", "describe() did not decode"),
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
      if (words.length !== codeAddresses.length * 64)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", "code hash probe returned the wrong length"),
        };
      const hashes = codeAddresses.map((_, i) => {
        const h = `0x${words.slice(i * 64, i * 64 + 64).toLowerCase()}`;
        return /^0x0{64}$/.test(h) || h === EMPTY_CODEHASH ? "absent" : h;
      });
      eq("code: ledger implementation", d.codehashes.ledgerImplementation, hashes[0] ?? "absent");
      eq("code: LedgerReads", d.codehashes.ledgerReads, hashes[1] ?? "absent");
      eq("code: LedgerViews", d.codehashes.ledgerViews, hashes[2] ?? "absent");
      eq("code: LensReader", d.codehashes.lens, hashes[3] ?? "absent");
      eq("code: FilesPageReader", d.codehashes.filesPage, hashes[4] ?? "absent");
      const basis: Basis = {
        chainId: d.chainId,
        blockNumber: block.value.number,
        blockHash: block.value.hash,
        executionSet: lower(described.executionSet),
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
      if (results) await cachePut(() => results.put(key, { basis, live }));
      return { ok: true, value: { basis, mismatches, live } };
    },
    o,
  );
  const evidence: Evidence = { attempts: r.attempts, requests };
  if (!r.ok) {
    return lastMismatch
      ? {
          kind: "efs.pin",
          status: "MISMATCH",
          basis: lastMismatch.basis,
          mismatches: lastMismatch.mismatches,
          evidence,
        }
      : { kind: "efs.pin", status: "UNKNOWN", reason: r.reason, evidence };
  }
  return {
    kind: "efs.pin",
    status: "VERIFIED",
    basis: r.value.basis,
    live: r.value.live,
    evidence,
  };
}
