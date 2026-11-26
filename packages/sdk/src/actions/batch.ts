// SPDX-License-Identifier: MIT
// Several publications under one wallet approval (EIP-5792 wallet_sendCalls), used for the parts of one split save.
// The same exactly-once rules as sendPlan: under the account's submission lock, every part's journal record is
// re-read (a part already attempted is never sent again) and written SUBMISSION_POSSIBLE before the one request
// that might broadcast. The ledger, not the wallet's status report, decides each part (reconcileAttempt).
import type { Eip1193Like } from "../chain/rpc.js";
import type { Efs } from "../client.js";
import { EfsFault, type Reason, type RevertInfo, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";
import { setTimer } from "../core/platform.js";
import { planGasLimit } from "./gaslimit.js";
import { type AttemptRecord, type AttemptStage, type Journal, lockKey } from "./journal.js";
import { scheduleCheck } from "./schedule.js";
import {
  classifyWalletError,
  estimate,
  inFlightTwin,
  notify,
  type SendOpts,
  twinReason,
  txGasCapOf,
  walletMismatch,
} from "./send.js";
import type { Plan } from "./types.js";

export type BatchSendResult =
  | { kind: "efs.sendBatch"; status: "SUBMITTED"; batchId: string; atomic: boolean }
  /** `walletCode`: the wallet's EIP-1193 / EIP-5792 error code, when the wallet itself answered with an error. */
  | { kind: "efs.sendBatch"; status: "NOT_SENT" | "AMBIGUOUS"; reason: Reason; walletCode?: number }
  | { kind: "efs.sendBatch"; status: "STALE"; reasons: readonly string[]; revert?: RevertInfo }
  | { kind: "efs.sendBatch"; status: "BUSY" };

const stamp = (r: AttemptRecord, stage: AttemptStage, detail?: string): AttemptRecord => ({
  ...r,
  stage,
  history: [...r.history, { stage, at: Date.now(), ...(detail ? { detail } : {}) }],
});
const bestEffort = async (w: Promise<void>): Promise<void> => {
  try {
    await w;
  } catch {
    // the SUBMISSION_POSSIBLE record already covers this: a re-send answers AMBIGUOUS, reconcile settles it
  }
};

/** Whether the wallet can run calls atomically on this chain (EIP-5792 wallet_getCapabilities). Never prompts. */
export async function atomicBatchSupport(
  provider: Eip1193Like,
  account: Hex,
  chainId: number,
): Promise<boolean> {
  const id = `0x${chainId.toString(16)}`;
  try {
    const caps = (await provider.request({
      method: "wallet_getCapabilities",
      params: [account, [id]],
    })) as Record<string, { atomic?: { status?: string } } | undefined>;
    const status = caps?.[id]?.atomic?.status;
    return status === "supported" || status === "ready";
  } catch {
    return false; // no EIP-5792: the caller sends part by part
  }
}

export async function sendPlansAsBatch(
  efs: Efs,
  journal: Journal,
  provider: Eip1193Like,
  plans: readonly Plan[],
  o: SendOpts = {},
): Promise<BatchSendResult> {
  const first = plans[0];
  if (!first) throw new EfsFault("MISUSE", "sendPlansAsBatch needs at least one plan");
  if (plans.some((p) => lockKey(p) !== lockKey(first)))
    throw new EfsFault("MISUSE", "a batch holds plans of one account on one deployment");
  let mayHaveBroadcast = false;
  try {
    const got = await journal.withLock(
      lockKey(first),
      o.waitForLock ?? false,
      async (): Promise<BatchSendResult> => {
        for (const p of plans) {
          const prior = await journal.get(p.id);
          if (prior && prior.stage !== "PLANNED" && prior.stage !== "NOT_SENT")
            return {
              kind: "efs.sendBatch",
              status: "AMBIGUOUS",
              reason: reason(
                "ALREADY_ATTEMPTED",
                "after-reconcile",
                `a part was already attempted (${prior.stage})`,
              ),
            };
        }
        // A part whose publication is already in flight under another plan: nothing is sent.
        for (const p of plans) {
          const twin = await inFlightTwin(journal, lockKey(first), p);
          if (twin) return { kind: "efs.sendBatch", status: "NOT_SENT", reason: twinReason(twin) };
        }
        // The document's fee schedule must be the chain's: the planning and the gas limits are set by it.
        const fee = await scheduleCheck(efs, o);
        if (!fee.ok) return { kind: "efs.sendBatch", status: "NOT_SENT", reason: fee.reason };
        // Only the first part can be simulated now: later parts need the earlier nonces used first. The split
        // planned every part under the gas budget.
        const est = await estimate(efs, first, o);
        if ("revert" in est)
          return {
            kind: "efs.sendBatch",
            status: "STALE",
            reasons: [
              `simulation reverts with ${est.revert.error ?? `unknown error ${est.revert.selector}`}`,
            ],
            revert: est.revert,
          };
        // The wallet sets each call's gas limit (wallet_sendCalls carries none): only the refusal is the SDK's, by the
        // same per-profile rule as a single send (gasLimitOf: on amsterdam the cap bounds execution only).
        const cap = txGasCapOf(efs.deployment);
        const limit = "gas" in est ? planGasLimit(efs.deployment, first, est.gas) : undefined;
        if (limit && !limit.ok)
          return {
            kind: "efs.sendBatch",
            status: "NOT_SENT",
            reason: reason(
              "OVER_TX_GAS_CAP",
              "after-replan",
              `the first part needs ~${limit.execution} gas, over ${cap}`,
            ),
          };
        let chainId: number;
        let accounts: string[];
        try {
          chainId = Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
          accounts = ((await provider.request({ method: "eth_accounts" })) as string[]).map((a) =>
            a.toLowerCase(),
          );
        } catch (e) {
          return {
            kind: "efs.sendBatch",
            status: "NOT_SENT",
            reason: reason(
              "RPC_UNAVAILABLE",
              "transient",
              e instanceof Error ? e.message : "wallet unavailable",
            ),
          };
        }
        // Checked before any write-ahead record: a wallet that moved sends nothing and leaves the journal as it was.
        const moved = walletMismatch(first, chainId, accounts);
        if (moved) return { kind: "efs.sendBatch", status: "NOT_SENT", reason: moved };
        const atomic = await atomicBatchSupport(provider, first.account, first.chainId);

        // Write-ahead, every part: from here on a crash or a lost response is AMBIGUOUS, never "safe to resend".
        const records = plans.map(
          (p): AttemptRecord =>
            stamp(
              { schema: "efs-sdk-attempt/1", planId: p.id, plan: p, stage: "PLANNED", history: [] },
              "SUBMISSION_POSSIBLE",
              "wallet_sendCalls",
            ),
        );
        for (const r of records) await journal.put(r);
        mayHaveBroadcast = true;
        notify(o.onWalletRequest);
        let batchId: string;
        try {
          const res = (await provider.request({
            method: "wallet_sendCalls",
            params: [
              {
                version: "2.0.0",
                chainId: `0x${first.chainId.toString(16)}`,
                from: first.account,
                atomicRequired: atomic,
                calls: plans.map((p) => ({ to: p.ledger, data: p.calldata, value: "0x0" })),
              },
            ],
          })) as { id?: string } | string;
          batchId = typeof res === "string" ? res : String(res?.id ?? "");
          if (!batchId) throw new Error("wallet_sendCalls returned no id");
        } catch (e) {
          const how = classifyWalletError(e, "wallet_sendCalls");
          const code = (e as { code?: unknown } | null)?.code;
          const walletCode = typeof code === "number" ? { walletCode: code } : {};
          if ("notSent" in how) {
            for (const r of records)
              await bestEffort(
                journal.put(stamp(r, "NOT_SENT", `the wallet refused it before signing (${code})`)),
              );
            return {
              kind: "efs.sendBatch",
              status: "NOT_SENT",
              reason: how.notSent,
              ...walletCode,
            };
          }
          return {
            kind: "efs.sendBatch",
            status: "AMBIGUOUS",
            reason: how.ambiguous,
            ...walletCode,
          };
        }
        for (const r of records)
          await bestEffort(
            journal.put({
              ...stamp(r, "SUBMITTED", "wallet_sendCalls"),
              extensions: { ...r.extensions, batchId },
            }),
          );
        return { kind: "efs.sendBatch", status: "SUBMITTED", batchId, atomic };
      },
    );
    return got === "BUSY" ? { kind: "efs.sendBatch", status: "BUSY" } : got;
  } catch (e) {
    if (!(e instanceof EfsFault) || e.code !== "JOURNAL_UNAVAILABLE") throw e;
    return {
      kind: "efs.sendBatch",
      status: mayHaveBroadcast ? "AMBIGUOUS" : "NOT_SENT",
      reason: reason(
        "JOURNAL_UNAVAILABLE",
        mayHaveBroadcast ? "after-reconcile" : "transient",
        e.message,
      ),
    };
  }
}

/**
 * Wait (bounded) for the wallet to report the batch final, and return its final EIP-5792 status code (200
 * confirmed; 400 not included, 500 reverted, 600 partly reverted), or undefined when it never said. Informational:
 * the ledger decides every part; the status only tells a later batch to be smaller.
 */
export async function waitForBatch(
  provider: Eip1193Like,
  batchId: string,
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<number | undefined> {
  const until = Date.now() + (o.timeoutMs ?? 120_000);
  while (Date.now() < until) {
    try {
      const s = (await provider.request({
        method: "wallet_getCallsStatus",
        params: [batchId],
      })) as {
        status?: number | string;
      };
      const code = typeof s?.status === "number" ? s.status : Number.NaN;
      if (s?.status === "CONFIRMED") return 200;
      if (code >= 200) return code;
    } catch {
      return undefined; // no status method: reconcile will tell
    }
    await new Promise<void>((r) => {
      setTimer(r, o.pollMs ?? 1000);
    });
  }
  return undefined;
}
