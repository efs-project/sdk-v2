// SPDX-License-Identifier: MIT
// The fee-schedule check: does this chain price storage the way the deployment document says? A document that names
// the wrong schedule is the silent-mismatch shape. On a chain that prices by EIP-8037 a document saying prague would
// plan every part with the wrong model and clamp every gas limit at 2^24. So before the first plan or send, a client
// measures how the chain prices a fresh storage slot and compares it with the document's schedule.
//
// The probe is one deployless eth_call (no `to`: its data runs as initcode) with an explicit gas limit of 2,000,000,
// under 2^24, so no client puts state gas in a reservoir and the GAS opcode sees all of it. The initcode is
//   GAS  PUSH1 1  PUSH1 0  SSTORE  GAS  SWAP1  SUB      (the gas before, less the gas after)
//   PUSH1 0  MSTORE  PUSH1 32  PUSH1 0  RETURN         (return it as one word)
// and the word it returns is a fresh SSTORE's whole price plus 8 (the two PUSH1s and the second GAS). Plain eth_call
// is not the transaction rule on Geth (it does not cap ordinary gas), but a measured opcode's price is the same either
// way. The price classifies into a known schedule within a band; anything outside every band is no schedule.
//
// Run on the write path only (planners, planPublication, sends), never on reads. A measurement is kept for 10
// minutes, so a chain that forks under a long-lived page is measured again. A failed probe is UNKNOWN for that call,
// tried again next time, and never kept.
import { onEndpoint, type Pool } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, type Reason, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { FRESH_SLOT_GAS } from "../generated/gas.js";
import { feeScheduleOf } from "./split.js";

/** The probe's initcode (see the header), opcode by opcode. */
export const SCHEDULE_PROBE: Hex = `0x${[
  "5a", // GAS            the gas before
  "6001", // PUSH1 1
  "6000", // PUSH1 0
  "55", // SSTORE          slot 0 of a contract being created: fresh and cold
  "5a", // GAS            the gas after
  "90", // SWAP1
  "03", // SUB            before − after
  "6000", // PUSH1 0
  "52", // MSTORE
  "6020", // PUSH1 32
  "6000", // PUSH1 0
  "f3", // RETURN          one word (its first byte is 0: never refused as code starting 0xEF)
].join("")}`;
/** The probe's gas limit: well under 2^24, so state gas is never held in a reservoir. */
const PROBE_GAS = 2_000_000;
/** The probe's own cost between the two GAS readings, beyond the SSTORE: PUSH1, PUSH1 and the second GAS. */
const PROBE_OVERHEAD = 8;
/** How long a measurement stands before it is taken again. */
export const SCHEDULE_TTL_MS: number = 10 * 60 * 1000;

/** The band each schedule's fresh-slot price is accepted in: ±5% of its expected reading, at least ±1,000 gas. */
export function scheduleBands(): { schedule: string; low: bigint; high: bigint }[] {
  return Object.entries(FRESH_SLOT_GAS as Readonly<Record<string, number>>).map(
    ([schedule, price]) => {
      const expected = price + PROBE_OVERHEAD;
      const width = Math.max(1000, Math.round(expected * 0.05));
      return { schedule, low: BigInt(expected - width), high: BigInt(expected + width) };
    },
  );
}

/** The schedule a measured fresh-slot reading belongs to, or null when it is in no band. */
export function classifySchedule(measured: bigint): string | null {
  const hit = scheduleBands().filter((b) => measured >= b.low && measured <= b.high);
  return hit.length === 1 ? (hit[0] as { schedule: string }).schedule : null;
}

/** A measurement as a client keeps it. */
interface Measured {
  at: number;
  measured: bigint;
  schedule: string | null;
}
/** Per client: the last measurement (a failed probe is never kept). */
export interface ScheduleCache {
  last?: Measured;
}

export type ScheduleCheck =
  | { ok: true }
  /** The chain disagrees with the document, or prices storage like no schedule this SDK knows. */
  | { ok: false; reason: Reason; failed?: false }
  /** The probe could not be made: UNKNOWN for this call, measured again next time. */
  | { ok: false; reason: Reason; failed: true };

/**
 * Check the deployment document's fee schedule against how the chain prices a fresh storage slot. Measured once per
 * client per SCHEDULE_TTL_MS; a failed probe is not kept.
 */
export async function checkFeeSchedule(
  pool: Pool,
  d: DeploymentInfo,
  cache: ScheduleCache,
  o: CallOpts = {},
  now: () => number = Date.now,
): Promise<ScheduleCheck> {
  // The schedule the planners resolve from the document (feeSchedule, else the one whose hardforks include its
  // hardfork). A document they can't resolve is refused by gasPlanFor already; only a priced schedule is checked.
  const named = feeScheduleOf(d)?.name;
  if (!named || !(named in FRESH_SLOT_GAS)) return { ok: true };
  let m = cache.last && now() - cache.last.at < SCHEDULE_TTL_MS ? cache.last : undefined;
  if (!m) {
    const r = await onEndpoint<bigint>(
      pool,
      async (s) => {
        const out = await s.request("eth_call", [
          { data: SCHEDULE_PROBE, gas: `0x${PROBE_GAS.toString(16)}` },
          "latest",
        ]);
        if (!out.ok) return { ok: false, retryElsewhere: true, reason: out.reason };
        const hex = String(out.result);
        if (!/^0x[0-9a-fA-F]{64}$/.test(hex))
          return {
            ok: false,
            retryElsewhere: true,
            reason: reason(
              "RPC_ERROR",
              "transient",
              "the fee-schedule probe returned the wrong length",
            ),
          };
        return { ok: true, value: BigInt(hex) };
      },
      o,
    );
    if (!r.ok)
      return {
        ok: false,
        failed: true,
        reason: {
          ...r.reason,
          detail: `could not check this chain's fee schedule: ${r.reason.detail ?? r.reason.code}`,
        },
      };
    m = { at: now(), measured: r.value, schedule: classifySchedule(r.value) };
    cache.last = m;
  }
  if (m.schedule === named) return { ok: true };
  const chain = m.schedule ?? "no known schedule";
  return {
    ok: false,
    reason: {
      ...reason(
        "UNSUPPORTED_PROFILE",
        "never",
        `the deployment document's fee schedule does not match this chain (document: ${named}, chain: ${chain}; a fresh storage slot costs ${m.measured - BigInt(PROBE_OVERHEAD)} gas here)`,
      ),
      feeSchedule: {
        document: named,
        chain: m.schedule,
        freshSlotGas: m.measured - BigInt(PROBE_OVERHEAD),
      },
    },
  };
}

/** checkFeeSchedule for a client: its pool, its document and its own measurement. */
export const scheduleCheck = (efs: Efs, o: CallOpts = {}): Promise<ScheduleCheck> =>
  checkFeeSchedule(efs._internal.pool, efs.deployment, efs._internal.schedule, o);
