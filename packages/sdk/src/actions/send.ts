// SPDX-License-Identifier: MIT
// The direct profile: one wallet interaction authorizes AND broadcasts (eth_sendTransaction), or a local account
// signs and the SDK broadcasts. Either way the journal records SUBMISSION_POSSIBLE before the call that might
// broadcast; a lost response is AMBIGUOUS and is settled by reconcile, never by sending again.
import { decodeErrorResult, keccak256 } from "viem";
import { onEndpoint } from "../chain/pool.js";
import type { Eip1193Like } from "../chain/rpc.js";
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault, type Reason, reason } from "../core/errors.js";
import { type Address, type Hex, lower } from "../core/hex.js";
import { errorAbi } from "../generated/abis.js";
import { ERROR_CATALOG } from "../generated/errors.js";
import { type AttemptRecord, type AttemptStage, type Journal, lockKey } from "./journal.js";
import type { Plan, SendResult } from "./types.js";

/** A viem LocalAccount satisfies this structurally; the SDK holds no private-key code. */
export interface LocalAccountLike {
  readonly address: Address;
  signTransaction(tx: {
    type: "eip1559";
    chainId: number;
    nonce: number;
    to: Address;
    data: Hex;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    value: bigint;
  }): Promise<Hex>;
}

export type Authorizer =
  | { kind: "eip1193"; profile: "direct"; provider: Eip1193Like; account?: Address }
  | { kind: "local"; profile: "direct"; account: LocalAccountLike };

export interface SendOpts extends CallOpts {
  waitForLock?: boolean | number;
}

const stamp = (r: AttemptRecord, stage: AttemptStage, detail?: string): AttemptRecord => ({
  ...r,
  stage,
  history: [...r.history, { stage, at: Date.now(), ...(detail ? { detail } : {}) }],
});

/** Decode a revert into the contracts' error name, if it is one of theirs. */
export function decodeRevert(data: unknown): { error: string; selector: Hex } | null {
  if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  try {
    const d = decodeErrorResult({ abi: errorAbi, data: data as Hex });
    return { error: d.errorName, selector };
  } catch {
    return { error: ERROR_CATALOG[selector]?.name ?? "unknown", selector };
  }
}

/** Find revert data inside a JSON-RPC error (nodes nest it differently). */
function revertData(e: { data?: unknown }): unknown {
  const d = e.data as { data?: unknown } | string | undefined;
  return typeof d === "string" ? d : d?.data;
}

type Estimate = { gas: bigint } | { revert: { error: string; selector: Hex } };

export async function estimate(
  efs: Efs,
  plan: Plan,
  o: CallOpts = {},
): Promise<Estimate | { unknown: string }> {
  const r = await onEndpoint<Estimate>(
    efs._internal.pool,
    async (s) => {
      const out = await s.request("eth_estimateGas", [
        { from: plan.account, to: plan.ledger, data: plan.calldata },
      ]);
      if (out.ok) return { ok: true, value: { gas: BigInt(out.result as Hex) } };
      if (out.kind === "rpc") {
        const rev = decodeRevert(revertData(out));
        if (rev) return { ok: true, value: { revert: rev } };
      }
      return { ok: false, retryElsewhere: out.kind === "transport", reason: out.reason };
    },
    o,
  );
  return r.ok ? r.value : { unknown: r.reason.detail ?? r.reason.code };
}

/**
 * The per-transaction gas cap (EIP-7825, 2^24). A chain fact: the deployment document will carry it
 * (efs-deployment.chain.txGasCap); until then this default applies.
 */
export const TX_GAS_CAP = 16_777_216n;
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export async function sendPlan(
  efs: Efs,
  journal: Journal,
  authorizer: Authorizer,
  plan: Plan,
  o: SendOpts = {},
): Promise<SendResult> {
  const lock = lockKey(plan);
  // Set just before the first call that might broadcast. A journal fault before it means nothing was sent; after it
  // the outcome is AMBIGUOUS (the durable SUBMISSION_POSSIBLE record makes a re-send safe and reconcile decides).
  let mayHaveBroadcast = false;
  let got: SendResult | "BUSY";
  try {
    got = await journal.withLock(lock, o.waitForLock ?? false, async (): Promise<SendResult> => {
      // Re-read the journal under the lock: an attempt for this exact plan is never sent twice.
      const prior = await journal.get(plan.id);
      if (prior && prior.stage !== "PLANNED" && prior.stage !== "NOT_SENT") {
        return prior.txHash && prior.stage === "SUBMITTED"
          ? { kind: "efs.send", status: "SUBMITTED", planId: plan.id, txHash: prior.txHash }
          : {
              kind: "efs.send",
              status: "AMBIGUOUS",
              planId: plan.id,
              reason: reason(
                "ALREADY_ATTEMPTED",
                "after-reconcile",
                `journal stage ${prior.stage}`,
              ),
            };
      }
      const est = await estimate(efs, plan, o);
      if ("revert" in est)
        return {
          kind: "efs.send",
          status: "STALE",
          planId: plan.id,
          reasons: [`simulation reverts with ${est.revert.error}`],
        };
      // 25% headroom over the estimate, but never a limit above the per-transaction cap (EIP-7825): a node refuses
      // a transaction by its gas LIMIT, not by the gas it would use.
      const cap = TX_GAS_CAP;
      if ("gas" in est && est.gas > cap)
        return {
          kind: "efs.send",
          status: "STALE",
          planId: plan.id,
          reasons: [
            `the publication needs ${est.gas} gas, over the per-transaction cap of ${cap}: split it`,
          ],
        };
      const gas = "gas" in est ? min((est.gas * 5n) / 4n, cap) : undefined;
      let record: AttemptRecord = {
        schema: "efs-sdk-attempt/1",
        planId: plan.id,
        plan,
        stage: "PLANNED",
        history: [],
      };

      if (authorizer.kind === "eip1193") {
        const p = authorizer.provider;
        // Events are hints; this re-read is the check. A changed chain or account makes the plan stale.
        let chainId: number;
        let accounts: string[];
        try {
          chainId = Number.parseInt(String(await p.request({ method: "eth_chainId" })), 16);
          accounts = ((await p.request({ method: "eth_accounts" })) as string[]).map((a) =>
            a.toLowerCase(),
          );
        } catch (e) {
          return {
            kind: "efs.send",
            status: "NOT_SENT",
            planId: plan.id,
            reason: reason(
              "RPC_UNAVAILABLE",
              "transient",
              e instanceof Error ? e.message : "wallet unavailable",
            ),
          };
        }
        const stale: string[] = [];
        if (chainId !== plan.chainId)
          stale.push(`wallet is on chain ${chainId}, plan is for ${plan.chainId}`);
        if (!accounts.includes(plan.account)) stale.push(`wallet account is not ${plan.account}`);
        if (stale.length)
          return { kind: "efs.send", status: "STALE", planId: plan.id, reasons: stale };
        record = stamp(record, "SUBMISSION_POSSIBLE");
        await journal.put(record); // write-ahead: from here on, a crash or lost response is AMBIGUOUS
        mayHaveBroadcast = true;
        try {
          const tx = {
            from: plan.account,
            to: plan.ledger,
            data: plan.calldata,
            ...(gas ? { gas: `0x${gas.toString(16)}` } : {}),
          };
          const hash = lower(
            String(await p.request({ method: "eth_sendTransaction", params: [tx] })) as Hex,
          );
          await bestEffort(journal.put({ ...stamp(record, "SUBMITTED"), txHash: hash }));
          return { kind: "efs.send", status: "SUBMITTED", planId: plan.id, txHash: hash };
        } catch (e) {
          const code = (e as { code?: unknown })?.code;
          if (code === 4001) {
            await bestEffort(journal.put(stamp(record, "NOT_SENT", "wallet refused (4001)")));
            return {
              kind: "efs.send",
              status: "NOT_SENT",
              planId: plan.id,
              reason: reason("USER_REJECTED", "never", "the wallet refused the request"),
            };
          }
          return {
            kind: "efs.send",
            status: "AMBIGUOUS",
            planId: plan.id,
            reason: reason(
              "RESPONSE_LOST",
              "after-reconcile",
              e instanceof Error ? e.message : "no response",
            ),
          };
        }
      }

      // Local account: sign here, broadcast through the endpoint pool. The tx hash is known before broadcast.
      const account = authorizer.account;
      if (lower(account.address) !== plan.account)
        return {
          kind: "efs.send",
          status: "STALE",
          planId: plan.id,
          reasons: [`account is ${account.address}, plan is for ${plan.account}`],
        };
      const fees = await onEndpoint(
        efs._internal.pool,
        async (s) => {
          const [n, block, tip] = await s.send([
            { method: "eth_getTransactionCount", params: [plan.account, "pending"] },
            { method: "eth_getBlockByNumber", params: ["latest", false] },
            { method: "eth_maxPriorityFeePerGas", params: [] },
          ]);
          if (!n?.ok || !block?.ok)
            return {
              ok: false,
              retryElsewhere: true,
              reason: reason("RPC_UNAVAILABLE", "transient"),
            };
          const base = BigInt((block.result as { baseFeePerGas?: Hex }).baseFeePerGas ?? "0x0");
          const priority = tip?.ok ? BigInt(tip.result as Hex) : 1_000_000_000n;
          return {
            ok: true,
            value: {
              nonce: Number(BigInt(n.result as Hex)),
              maxFeePerGas: base * 2n + priority,
              maxPriorityFeePerGas: priority,
            },
          };
        },
        o,
      );
      if (!fees.ok || !gas)
        return {
          kind: "efs.send",
          status: "NOT_SENT",
          planId: plan.id,
          reason: fees.ok ? reason("RPC_ERROR", "transient", "no gas estimate") : fees.reason,
        };
      const signed = await account.signTransaction({
        type: "eip1559",
        chainId: plan.chainId,
        nonce: fees.value.nonce,
        to: plan.ledger,
        data: plan.calldata,
        gas,
        maxFeePerGas: fees.value.maxFeePerGas,
        maxPriorityFeePerGas: fees.value.maxPriorityFeePerGas,
        value: 0n,
      });
      const txHash = keccak256(signed);
      record = { ...stamp(record, "SUBMISSION_POSSIBLE"), txHash };
      await journal.put(record);
      mayHaveBroadcast = true;
      const sent = await onEndpoint(
        efs._internal.pool,
        async (s) => {
          const out = await s.request("eth_sendRawTransaction", [signed]);
          return out.ok
            ? { ok: true, value: out.result }
            : { ok: false, retryElsewhere: out.kind === "transport", reason: out.reason };
        },
        o,
      );
      if (!sent.ok)
        return {
          kind: "efs.send",
          status: "AMBIGUOUS",
          planId: plan.id,
          reason: reason(
            "RESPONSE_LOST",
            "after-reconcile",
            sent.reason.detail ?? sent.reason.code,
          ),
        };
      await bestEffort(journal.put(stamp(record, "SUBMITTED")));
      return { kind: "efs.send", status: "SUBMITTED", planId: plan.id, txHash };
    });
  } catch (e) {
    if (!(e instanceof EfsFault) || e.code !== "JOURNAL_UNAVAILABLE") throw e;
    return mayHaveBroadcast
      ? {
          kind: "efs.send",
          status: "AMBIGUOUS",
          planId: plan.id,
          reason: reason("JOURNAL_UNAVAILABLE", "after-reconcile", e.message),
        }
      : { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: journalDown(e) };
  }
  return got === "BUSY" ? { kind: "efs.send", status: "BUSY", planId: plan.id } : got;
}

const journalDown = (e: EfsFault): Reason => reason("JOURNAL_UNAVAILABLE", "transient", e.message);

/** A journal write after broadcast: the durable SUBMISSION_POSSIBLE record already covers a failure here. */
async function bestEffort(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch {
    // The record stays SUBMISSION_POSSIBLE: a re-send answers AMBIGUOUS and reconcile settles it from the ledger.
  }
}
