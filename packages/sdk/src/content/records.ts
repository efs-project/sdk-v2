// SPDX-License-Identifier: MIT
// Read ledger records at one basis and check each body against its content-addressed id. An endpoint that returns
// a body whose recordId(type, body) differs from the id asked for is lying or broken: the read fails over.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { type ByteStore, cacheGet, cachePut } from "../cache/stores.js";
import { callsAt } from "../chain/basis.js";
import type { Session, Step } from "../chain/pool.js";
import { reason } from "../core/errors.js";
import { bytesToHex, type Hex, hexToBytes, lower } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import { recordId } from "../protocol/keys.js";
import { type ChainStatus, chainStatus } from "../protocol/status.js";

export interface LedgerRecord {
  id: Hex;
  status: ChainStatus | "TRANSPORT_FAULT" | "UNRECOGNIZED";
  typeId: Hex;
  length: number;
  /** Absent when the record came from the verified record cache (only its type and body are content-addressed). */
  firstAdmission?: bigint;
  /** Present when status is PRESENT; already checked against the id. */
  body?: Uint8Array;
}

type RecordOut = readonly [
  number,
  { typeId: Hex; firstAdmission: bigint; length: number },
  Hex,
  unknown,
];

const BATCH = 16;

/**
 * The cache key of a record on one ledger. Scoped to the chain and ledger, so an entry is only ever a record this
 * ledger itself returned as PRESENT (and records are never removed): a body cached from another deployment can
 * never make a file read here when this ledger lacks its records (an incomplete upload must stay visible).
 */
const recordKey = (d: DeploymentInfo, id: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(d.chainId), d.ledger, id],
    ),
  );

/**
 * A present record's cache entry: typeId (32 bytes) ‖ body. The record id commits to both, so an entry is checked
 * with one hash when it is read and a tampered entry is a miss.
 */
async function fromCache(
  cache: ByteStore | undefined,
  d: DeploymentInfo,
  id: Hex,
): Promise<LedgerRecord | undefined> {
  if (!cache) return undefined;
  const raw = await cacheGet(() => cache.get(recordKey(d, id)));
  if (!raw || raw.length < 32) return undefined;
  const typeId = bytesToHex(raw.subarray(0, 32));
  const body = raw.slice(32);
  if (recordId(typeId, body) !== lower(id)) return undefined;
  return { id: lower(id), status: "PRESENT", typeId, length: body.length, body };
}

export async function readRecords(
  s: Session,
  d: DeploymentInfo,
  blockHash: Hex,
  ids: readonly Hex[],
  cache?: ByteStore,
): Promise<Step<LedgerRecord[]>> {
  const found = new Map<string, LedgerRecord>();
  for (const id of ids) {
    const hit = await fromCache(cache, d, id);
    if (hit) found.set(hit.id, hit);
  }
  const misses = ids.filter((id) => !found.has(lower(id)));
  const out: LedgerRecord[] = [];
  for (let i = 0; i < misses.length; i += BATCH) {
    const slice = misses.slice(i, i + BATCH);
    const results = await callsAt(
      s,
      blockHash,
      slice.map((id) => ({
        to: d.readers.ledgerReads,
        data: encodeFunctionData({
          abi: ledgerReadsAbi,
          functionName: "record",
          args: [d.ledger, id],
        }),
      })),
    );
    for (let j = 0; j < slice.length; j++) {
      const res = results[j];
      const id = lower(slice[j] as Hex);
      if (!res?.ok)
        return {
          ok: false,
          retryElsewhere: true,
          reason: res ? res.reason : reason("RPC_UNAVAILABLE", "transient"),
        };
      let decoded: RecordOut;
      try {
        decoded = decodeFunctionResult({
          abi: ledgerReadsAbi,
          functionName: "record",
          data: res.result as Hex,
        }) as unknown as RecordOut;
      } catch {
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason("RPC_ERROR", "transient", "record() did not decode"),
        };
      }
      const [st, h, body] = decoded;
      const status = chainStatus(st);
      const rec: LedgerRecord = {
        id,
        status,
        typeId: lower(h.typeId),
        length: Number(h.length),
        firstAdmission: BigInt(h.firstAdmission),
      };
      if (status === "PRESENT") {
        const bytes = hexToBytes(body);
        if (recordId(h.typeId, bytes) !== id) {
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason(
              "DIGEST_MISMATCH",
              "transient",
              `endpoint returned a body that does not hash to record ${id}`,
            ),
          };
        }
        rec.body = bytes;
        if (cache) {
          const entry = new Uint8Array(32 + bytes.length);
          entry.set(hexToBytes(lower(h.typeId)), 0);
          entry.set(bytes, 32);
          await cachePut(() => cache.put(recordKey(d, id), entry));
        }
      }
      found.set(id, rec);
    }
  }
  // Answer in the order asked for, cache hits and fresh reads alike.
  for (const id of ids) out.push(found.get(lower(id)) as LedgerRecord);
  return { ok: true, value: out };
}
