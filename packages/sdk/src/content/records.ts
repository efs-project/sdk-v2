// SPDX-License-Identifier: MIT
// Read ledger records at one basis and check each body against its content-addressed id. An endpoint that returns
// a body whose recordId(type, body) differs from the id asked for is lying or broken: the read fails over.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { callsAt } from "../chain/basis.js";
import type { Session, Step } from "../chain/pool.js";
import { reason } from "../core/errors.js";
import { type Hex, hexToBytes, lower } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import { recordId } from "../protocol/keys.js";
import { type ChainStatus, chainStatus } from "../protocol/status.js";

export interface LedgerRecord {
  id: Hex;
  status: ChainStatus | "TRANSPORT_FAULT" | "UNRECOGNIZED";
  typeId: Hex;
  length: number;
  firstAdmission: bigint;
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

export async function readRecords(
  s: Session,
  d: DeploymentInfo,
  blockHash: Hex,
  ids: readonly Hex[],
): Promise<Step<LedgerRecord[]>> {
  const out: LedgerRecord[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
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
      }
      out.push(rec);
    }
  }
  return { ok: true, value: out };
}
