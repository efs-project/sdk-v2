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
import { planGasLimit } from "./gaslimit.js";
import { type AttemptRecord, type AttemptStage, type Journal, lockKey } from "./journal.js";
import { actionsHash, checkPlan } from "./plan.js";
import { scheduleCheck } from "./schedule.js";
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

/**
 * @internal The attempt with a funds refusal recorded: still SUBMISSION_POSSIBLE (it may have gone out), its latest
 * history entry marked INSUFFICIENT_FUNDS, so the same plan may be sent again (fundsResendable).
 */
export function fundsRefusal(r: AttemptRecord, detail: string): AttemptRecord {
  return {
    ...r,
    stage: "SUBMISSION_POSSIBLE",
    history: [
      ...r.history,
      { stage: "SUBMISSION_POSSIBLE", at: Date.now(), detail, refusal: "INSUFFICIENT_FUNDS" },
    ],
  };
}

/**
 * @internal Whether the same plan may be sent again: its attempt is SUBMISSION_POSSIBLE, its latest entry is a funds
 * refusal, and it never reached SUBMITTED (no wallet ever returned a hash for it). The resend is the same plan, with
 * the same ledger nonce and digest, so if a wallet had queued the original and it lands, the resend's estimate fails on
 * the used nonce and nothing is sent; at most one of them is ever admitted. Every other attempt that may have gone
 * out (a lost response, a disconnect) keeps the rule that a plan id is never sent twice.
 */
export function fundsResendable(r: AttemptRecord): boolean {
  return (
    r.stage === "SUBMISSION_POSSIBLE" &&
    r.history.at(-1)?.refusal === "INSUFFICIENT_FUNDS" &&
    !r.history.some((h) => h.stage === "SUBMITTED")
  );
}

/** How far ahead of the chain's clock a plan's deadline must be for the same plan to be sent again, in seconds. */
export const RESEND_MARGIN_SECONDS = 60;

/**
 * Whether the plan's deadline is at least RESEND_MARGIN_SECONDS past the latest block's timestamp, so a resend can
 * still be admitted. Unreadable: false (the attempt waits for reconcile, as any other).
 */
async function resendWindow(efs: Efs, plan: Plan, o: CallOpts): Promise<boolean> {
  const r = await onEndpoint<bigint>(
    efs._internal.pool,
    async (s) => {
      const out = await s.request("eth_getBlockByNumber", ["latest", false]);
      const ts = out.ok ? (out.result as { timestamp?: unknown } | null)?.timestamp : undefined;
      return typeof ts === "string" && /^0x[0-9a-fA-F]+$/.test(ts)
        ? { ok: true, value: BigInt(ts) }
        : {
            ok: false,
            retryElsewhere: true,
            reason: reason("RPC_ERROR", "transient", "no latest block"),
          };
    },
    o,
  );
  return r.ok && plan.deadline - r.value >= BigInt(RESEND_MARGIN_SECONDS);
}

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

/** The wallet codes classifyWalletError names on their own; their words never change the reason. */
const NAMED_WALLET_CODES: ReadonlySet<unknown> = new Set([
  4001, 4100, 4200, -32602, 5700, 5710, 5740, 5750, 5760, 4900, 4901,
]);
const FUNDS_WORDS = /insufficient funds/i;
/** Where wallets and nodes put the reason (EIP-1193 data, MetaMask's data.originalError, viem's cause and details). */
const NESTED_KEYS = [
  "message",
  "details",
  "shortMessage",
  "data",
  "originalError",
  "cause",
  "error",
];
const FUNDS_SEARCH_DEPTH = 6;

/** Whether an error, or one nested in it within a few levels, says "insufficient funds". Cycles end. */
function saysInsufficientFunds(e: unknown): boolean {
  const seen = new Set<unknown>();
  const look = (x: unknown, depth: number): boolean => {
    if (typeof x === "string") return FUNDS_WORDS.test(x);
    if (x === null || typeof x !== "object" || depth > FUNDS_SEARCH_DEPTH || seen.has(x))
      return false;
    seen.add(x);
    const o = x as Record<string, unknown>;
    return NESTED_KEYS.some((k) => look(o[k], depth + 1));
  };
  return look(e, 0);
}

/**
 * INSUFFICIENT_FUNDS: the account can't cover the gas limit at the wallet's fees. AMBIGUOUS, after-reconcile: the
 * refusal comes after signing, and a wallet that queued the signed transaction could still send it, so the attempt
 * stays in flight until reconcile proves it never went out. `gasLimit` is the limit the send asked for, when it asked.
 */
export function insufficientFunds(gasLimit?: bigint): Reason {
  const detail =
    gasLimit === undefined
      ? "the wallet needs enough to cover this transaction's gas limit; a save is charged only the gas it uses"
      : `the wallet needs enough to cover the gas limit of ${gasLimit}; a save is charged only the gas it uses`;
  return {
    ...reason("INSUFFICIENT_FUNDS", "after-reconcile", detail),
    ...(gasLimit === undefined ? {} : { funds: { gasLimit } }),
  };
}

/**
 * How a wallet error leaves a request. NOT_SENT only for errors that mean the request was refused before signing
 * (EIP-1193 4001 / 4100 / 4200, JSON-RPC -32602): the attempt is stamped NOT_SENT. A disconnect (4900 / 4901) can be
 * raised after the wallet relayed, so it is AMBIGUOUS with a named reason, as is every other error: the request may
 * have gone out, and reconcile decides.
 */
export function classifyWalletError(
  e: unknown,
  method: string,
  gasLimit?: bigint,
): { notSent: Reason } | { ambiguous: Reason } {
  const code = (e as { code?: unknown } | null)?.code;
  // Refused for insufficient funds, whatever the code: still after signing (see insufficientFunds), so AMBIGUOUS.
  if (!NAMED_WALLET_CODES.has(code) && saysInsufficientFunds(e))
    return { ambiguous: insufficientFunds(gasLimit) };
  switch (code) {
    case 4001:
      return { notSent: reason("USER_REJECTED", "transient", "the wallet refused the request") };
    case 4100:
      return {
        notSent: reason(
          "WALLET_UNAUTHORIZED",
          "transient",
          `the wallet has not authorized this account or ${method} (4100): connect it, then try again`,
        ),
      };
    case 4200:
      return {
        notSent: reason(
          "WALLET_UNSUPPORTED",
          "never",
          method === "wallet_sendCalls"
            ? "the wallet does not support wallet_sendCalls (4200): the save goes on part by part"
            : `the wallet does not support ${method} (4200)`,
        ),
      };
    case -32602:
      return {
        notSent: reason(
          "WALLET_INVALID_PARAMS",
          "never",
          `the wallet rejected the ${method} parameters (-32602)`,
        ),
      };
    // EIP-5792's own refusals of a wallet_sendCalls request: nothing was sent. 5720 (duplicate bundle id) and 5730
    // (unknown bundle id) are deliberately absent. 5720 means a bundle with that id may already exist, so an earlier
    // attempt may have gone out: it must stay AMBIGUOUS (the default) and wait for reconcile. 5730 answers
    // wallet_getCallsStatus, never a send.
    case 5740:
      return {
        notSent: reason(
          "LIMIT_EXCEEDED",
          "after-replan",
          "the wallet refused a batch this large (5740): the save goes on in smaller batches",
        ),
      };
    case 5700:
    case 5710:
    case 5760:
      return {
        notSent: reason(
          "WALLET_UNSUPPORTED",
          "transient",
          `the wallet can't run this batch (${code}): the save goes on part by part`,
        ),
      };
    case 5750:
      return {
        notSent: reason(
          "USER_REJECTED",
          "transient",
          "the account upgrade for batching was declined (5750): the save goes on part by part",
        ),
      };
    case 4900:
      return {
        ambiguous: reason(
          "WALLET_DISCONNECTED",
          "after-reconcile",
          "the wallet lost its connection (4900): checking whether the save went out",
        ),
      };
    case 4901:
      return {
        ambiguous: reason(
          "WALLET_CHAIN_DISCONNECTED",
          "after-reconcile",
          "the wallet lost its connection to this chain (4901): checking whether the save went out",
        ),
      };
    default:
      return {
        ambiguous: reason(
          "RESPONSE_LOST",
          "after-reconcile",
          e instanceof Error ? e.message : "no response",
        ),
      };
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

/**
 * @internal The open attempt of another plan for the same publication (the same actions and bodies) from this
 * account, with its save when the journal knows it, or undefined. Open: on its way (SUBMISSION_POSSIBLE, SUBMITTED)
 * or COMMITTED and not yet final. A second plan of one publication (a double submit, or the same parts saved again)
 * has a new id, so the plan id alone can't stop it. While the first is unconfirmed the second's simulation passes,
 * and a PUBLISH repeats without any revert (the record only gains an occurrence), so a committed attempt is held too
 * until it is final. Read under the account's lock, so two sends can't both miss each other.
 */
export async function inFlightTwin(
  journal: Journal,
  lock: string,
  plan: Plan,
): Promise<{ record: AttemptRecord; sequenceId?: Hex } | undefined> {
  const mine = actionsHash(plan.actions);
  const bodies = plan.bodies.map((b) => b.toLowerCase()).join(",");
  const record = (await journal.unresolved(lock)).find(
    (r) =>
      r.planId !== plan.id &&
      (r.stage === "SUBMISSION_POSSIBLE" || r.stage === "SUBMITTED" || r.stage === "COMMITTED") &&
      actionsHash(r.plan.actions) === mine &&
      r.plan.bodies.map((b) => b.toLowerCase()).join(",") === bodies,
  );
  if (!record) return undefined;
  const seq = (await journal.openSequences(lock)).find((q) =>
    q.parts.some((p) => p.planId === record.planId),
  );
  return { record, ...(seq ? { sequenceId: seq.sequenceId } : {}) };
}

/** @internal NOT_SENT's reason when the same publication is already open: the earlier attempt, structured. */
export const twinReason = (twin: { record: AttemptRecord; sequenceId?: Hex }): Reason => ({
  ...reason(
    "ALREADY_ATTEMPTED",
    "after-reconcile",
    `the same publication is already ${twin.record.stage === "COMMITTED" ? "committed, not yet final" : "on its way"} (attempt ${twin.record.planId}): settle it from the ledger; this call sent nothing`,
  ),
  twin: {
    planId: twin.record.planId,
    stage: twin.record.stage as "SUBMISSION_POSSIBLE" | "SUBMITTED" | "COMMITTED",
    ...(twin.sequenceId ? { sequenceId: twin.sequenceId } : {}),
  },
});

export async function sendPlan(
  efs: Efs,
  journal: Journal,
  authorizer: Authorizer,
  plan: Plan,
  o: SendOpts = {},
): Promise<SendResult> {
  // The calldata a wallet is asked to sign is re-derived from the plan's own fields first (a stored plan included).
  checkPlan(efs, plan);
  const lock = lockKey(plan);
  // Set just before the first call that might broadcast. A journal fault before it means nothing was sent; after it
  // the outcome is AMBIGUOUS (the durable SUBMISSION_POSSIBLE record makes a re-send safe and reconcile decides).
  let mayHaveBroadcast = false;
  let got: SendResult | "BUSY";
  try {
    got = await journal.withLock(lock, o.waitForLock ?? false, async (): Promise<SendResult> => {
      // Re-read the journal under the lock: an attempt for this exact plan is never sent twice, except the same plan
      // after a funds refusal, while its deadline is far enough ahead (fundsResendable, resendWindow).
      const prior = await journal.get(plan.id);
      const resending =
        prior !== undefined && fundsResendable(prior) && (await resendWindow(efs, prior.plan, o));
      if (prior && prior.stage !== "PLANNED" && prior.stage !== "NOT_SENT" && !resending) {
        return prior.txHash && prior.stage === "SUBMITTED"
          ? { kind: "efs.send", status: "SUBMITTED", planId: plan.id, txHash: prior.txHash }
          : {
              kind: "efs.send",
              status: "AMBIGUOUS",
              planId: plan.id,
              reason: reason(
                "ALREADY_ATTEMPTED",
                "after-reconcile",
                fundsResendable(prior)
                  ? `refused for funds, with under ${RESEND_MARGIN_SECONDS} s left before its deadline: it is not sent again as the same plan; once reconcile proves it never went out (EXPIRED), Send again plans it anew`
                  : `journal stage ${prior.stage}`,
              ),
            };
      }
      // The same publication under another plan, still in flight: nothing is sent, and the wallet is never asked.
      const twin = await inFlightTwin(journal, lock, plan);
      if (twin)
        return { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: twinReason(twin) };
      // The document's fee schedule must be the chain's: the gas limit is set by it.
      const fee = await scheduleCheck(efs, o);
      if (!fee.ok)
        return { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: fee.reason };
      const est = await estimate(efs, plan, o);
      if ("revert" in est) {
        guardBuiltWrong(plan, est.revert);
        return {
          kind: "efs.send",
          status: "STALE",
          planId: plan.id,
          reasons: [`simulation reverts with ${revertName(est.revert)}`],
          revert: est.revert,
        };
      }
      // The limit per fee profile (gasLimitOf): on prague and osaka 25% over the estimate and never above the
      // per-transaction cap (EIP-7825: a node refuses a transaction by its gas LIMIT, not the gas it would use); on
      // amsterdam the cap bounds execution only and the state gas rides in the reservoir above it (EIP-8037).
      const cap = txGasCapOf(efs.deployment);
      const limit = "gas" in est ? planGasLimit(efs.deployment, plan, est.gas) : undefined;
      if (limit && !limit.ok && "gas" in est) {
        // Too big for one atomic transaction: not a stale plan. Nothing is sent; split, then send each part.
        const suggestedParts = limit.suggestedParts;
        return {
          kind: "efs.send",
          status: "NOT_SENT",
          planId: plan.id,
          reason: {
            ...reason(
              "OVER_TX_GAS_CAP",
              "after-replan",
              `${limit.detail}: split it into about ${suggestedParts} publications`,
            ),
            gas: { estimate: est.gas, cap, suggestedParts },
          },
          gas: { estimate: est.gas, cap, suggestedParts },
        };
      }
      const gas = limit?.ok ? limit.gas : undefined;
      let record: AttemptRecord =
        resending && prior
          ? stamp(prior, "SUBMISSION_POSSIBLE", "sent again after a funds refusal")
          : { schema: "efs-sdk-attempt/1", planId: plan.id, plan, stage: "PLANNED", history: [] };

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
          const how = classifyWalletError(e, "eth_sendTransaction", gas);
          if ("notSent" in how) {
            const code = (e as { code?: unknown }).code;
            await bestEffort(
              journal.put(
                stamp(record, "NOT_SENT", `the wallet refused it before signing (${code})`),
              ),
            );
            return { kind: "efs.send", status: "NOT_SENT", planId: plan.id, reason: how.notSent };
          }
          if (how.ambiguous.code === "INSUFFICIENT_FUNDS")
            await bestEffort(
              journal.put(fundsRefusal(record, how.ambiguous.detail ?? "insufficient funds")),
            );
          return { kind: "efs.send", status: "AMBIGUOUS", planId: plan.id, reason: how.ambiguous };
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
      // Set when an endpoint failed in transport: it may have received and broadcast the signed transaction before
      // its response was lost, so a later endpoint's refusal proves nothing about the original.
      let lostAnEndpoint = false;
      const sent = await onEndpoint(
        efs._internal.pool,
        async (s) => {
          const out = await s.request("eth_sendRawTransaction", [signed]);
          if (!out.ok && out.kind === "transport") lostAnEndpoint = true;
          return out.ok
            ? { ok: true, value: out.result }
            : { ok: false, retryElsewhere: out.kind === "transport", reason: out.reason };
        },
        o,
      );
      if (!sent.ok) {
        // The node refused it for funds (the limit at these fees is more than the balance): named, still AMBIGUOUS,
        // and recorded so the same plan may go again, but only when that answer came from the first endpoint that
        // took the send. After a transport failure the original may be out: a lost response, waiting for reconcile.
        if (FUNDS_WORDS.test(sent.reason.detail ?? "") && !lostAnEndpoint) {
          const why = insufficientFunds(gas);
          await bestEffort(journal.put(fundsRefusal(record, why.detail ?? "insufficient funds")));
          return { kind: "efs.send", status: "AMBIGUOUS", planId: plan.id, reason: why };
        }
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
      }
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

/**
 * A guard the ledger refuses for its shape (E_READSET_SHAPE) or because the Realm has no guard (E_UNSUPPORTED_GUARD)
 * is the SDK's own error, or a deployment document that lied about its capabilities past the execution-set check:
 * never a stale plan, so never planned again as one. INVARIANT, before any wallet request (nothing was sent).
 * E_READSET_STALE stays STALE: a guarded head moved since the plan (reprepare, like E_CAS).
 */
export function guardBuiltWrong(plan: Plan, revert: RevertInfo): void {
  if (revert.error !== "E_READSET_SHAPE" && revert.error !== "E_UNSUPPORTED_GUARD") return;
  throw new EfsFault(
    "INVARIANT",
    `the ledger refuses this plan's read-set guard (${revert.error}): the SDK built a guard it should not have; nothing was sent`,
    { details: { planId: plan.id, revert } },
  );
}
