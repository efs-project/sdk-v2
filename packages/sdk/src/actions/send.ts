// SPDX-License-Identifier: MIT
// The direct profile: one wallet interaction authorizes AND broadcasts (eth_sendTransaction), or a local account
// signs and the SDK broadcasts. Either way the journal records SUBMISSION_POSSIBLE before the call that might
// broadcast; a lost response is AMBIGUOUS and is settled by reconcile, never by sending again.
import { decodeErrorResult, keccak256 } from "viem";
import { onEndpoint } from "../chain/pool.js";
import type { Eip1193Like } from "../chain/rpc.js";
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault, type Reason, type RevertInfo, reason } from "../core/errors.js";
import { type Address, type Hex, lower } from "../core/hex.js";
import { errorAbi } from "../generated/abis.js";
import { ERROR_CATALOG } from "../generated/errors.js";
import { type AttemptRecord, type AttemptStage, type Journal, lockKey } from "./journal.js";
import { txGasCapOf } from "./split.js";
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
  /**
   * Called just before the wallet is asked to approve (eth_sendTransaction or wallet_sendCalls), after the
   * write-ahead record: the moment to show "Approve in your wallet". Never for a local account, nor when nothing
   * is sent. Not awaited; anything it throws is ignored.
   */
  onWalletRequest?: () => void;
}

/**
 * Run a caller's UI callback: never awaited, and never allowed to break a save. A synchronous throw is caught, and
 * an async callback's rejection is handled here (an unhandled rejection can end a Node process mid-save).
 */
export function notify(fn: (() => unknown) | undefined): void {
  if (!fn) return;
  try {
    const r = fn();
    if (r !== null && typeof r === "object" && typeof (r as { then?: unknown }).then === "function")
      (r as PromiseLike<unknown>).then(undefined, () => {});
  } catch {
    // a UI callback's failure is the UI's; the save goes on
  }
}

const stamp = (r: AttemptRecord, stage: AttemptStage, detail?: string): AttemptRecord => ({
  ...r,
  stage,
  history: [...r.history, { stage, at: Date.now(), ...(detail ? { detail } : {}) }],
});

/** Decode a revert into the contracts' error name, if it is one of theirs. */
/**
 * Decode revert data as far as the vendored contracts tables allow: the selector always, the error's name only when
 * the vendored errors table has it, its arguments only when they decode cleanly as that error. Never guesses.
 */
export function decodeRevert(data: unknown): RevertInfo | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const error = ERROR_CATALOG[selector]?.name;
  if (error === undefined) return { selector };
  try {
    const d = decodeErrorResult({ abi: errorAbi, data: data as Hex });
    if (d.errorName === error) return { selector, error, args: [...(d.args ?? [])] };
  } catch {
    // the name is known but the arguments do not decode: report the name alone
  }
  return { selector, error };
}

const revertName = (r: RevertInfo): string => r.error ?? `unknown error ${r.selector}`;

/**
 * A wallet error that EIP-1193 or JSON-RPC defines as "the request was not processed", as the NOT_SENT reason; null
 * for anything else, which stays AMBIGUOUS (the request may have gone out, and reconcile decides).
 */
export function walletNotProcessed(e: unknown, method: string): Reason | null {
  switch ((e as { code?: unknown } | null)?.code) {
    case 4001:
      return reason("USER_REJECTED", "transient", "the wallet refused the request");
    case 4100:
      return reason(
        "WALLET_UNAUTHORIZED",
        "transient",
        `the wallet has not authorized this account or ${method} (4100): connect it, then try again`,
      );
    case 4200:
      return reason(
        "WALLET_UNSUPPORTED",
        "never",
        method === "wallet_sendCalls"
          ? 'the wallet does not support wallet_sendCalls (4200): send part by part (batch: "never")'
          : `the wallet does not support ${method} (4200)`,
      );
    case 4900:
      return reason("WALLET_DISCONNECTED", "transient", "the wallet is disconnected (4900)");
    case 4901:
      return reason(
        "WALLET_CHAIN_DISCONNECTED",
        "transient",
        "the wallet is not connected to this chain (4901)",
      );
    case -32602:
      return reason(
        "WALLET_INVALID_PARAMS",
        "never",
        `the wallet rejected the ${method} parameters (-32602)`,
      );
    default:
      return null;
  }
}

/** The wallet is not on the plan's chain or account: nothing is sent, and switching back lets the same save go on. */
export function walletMismatch(
  plan: { chainId: number; account: Address },
  chainId: number,
  accounts: readonly string[],
): Reason | null {
  if (chainId === plan.chainId && accounts.includes(plan.account)) return null;
  const why: string[] = [];
  if (chainId !== plan.chainId)
    why.push(`wallet is on chain ${chainId}, plan is for ${plan.chainId}`);
  if (!accounts.includes(plan.account)) why.push(`wallet account is not ${plan.account}`);
  return {
    ...reason("WALLET_MISMATCH", "transient", why.join("; ")),
    wallet: {
      expected: { chainId: plan.chainId, account: plan.account },
      actual: {
        chainId,
        account: accounts.includes(plan.account)
          ? plan.account
          : ((accounts[0] as Address | undefined) ?? null),
      },
    },
  };
}

/** Find revert data inside a JSON-RPC error (nodes nest it differently). */
function revertData(e: { data?: unknown }): unknown {
  const d = e.data as { data?: unknown } | string | undefined;
  return typeof d === "string" ? d : d?.data;
}

type Estimate = { gas: bigint } | { revert: RevertInfo };

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

export { TX_GAS_CAP, txGasCapOf } from "./split.js";

/** Gas to aim for per publication when splitting (contracts' guidance: about 14M, headroom under the cap). */
const SPLIT_TARGET = 14_000_000n;
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
          reasons: [`simulation reverts with ${revertName(est.revert)}`],
          revert: est.revert,
        };
      // 25% headroom over the estimate, but never a limit above the per-transaction cap (EIP-7825): a node refuses
      // a transaction by its gas LIMIT, not by the gas it would use.
      const cap = txGasCapOf(efs.deployment);
      if ("gas" in est && est.gas > cap) {
        // Too big for one atomic transaction: not a stale plan. Nothing is sent; split, then send each part.
        const suggestedParts = Number((est.gas + SPLIT_TARGET - 1n) / SPLIT_TARGET);
        return {
          kind: "efs.send",
          status: "NOT_SENT",
          planId: plan.id,
          reason: reason(
            "OVER_TX_GAS_CAP",
            "after-replan",
            `the publication needs ~${est.gas} gas, over the per-transaction cap of ${cap}: split it into about ${suggestedParts} publications`,
          ),
          gas: { estimate: est.gas, cap, suggestedParts },
        };
      }
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
        // Checked before the write-ahead record: a wallet that moved sends nothing and leaves the journal as it was.
        const moved = walletMismatch(plan, chainId, accounts);
        if (moved) return { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: moved };
        record = stamp(record, "SUBMISSION_POSSIBLE");
        await journal.put(record); // write-ahead: from here on, a crash or lost response is AMBIGUOUS
        mayHaveBroadcast = true;
        notify(o.onWalletRequest);
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
          const refused = walletNotProcessed(e, "eth_sendTransaction");
          if (refused) {
            const code = (e as { code?: unknown }).code;
            await bestEffort(
              journal.put(stamp(record, "NOT_SENT", `the wallet did not process it (${code})`)),
            );
            return { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: refused };
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
