// SPDX-License-Identifier: MIT
// createWriter: the write side of a client, bound to one account and one journal.
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault } from "../core/errors.js";
import { type Address, type Hex, lower, type PrincipalId } from "../core/hex.js";
import { setTimer } from "../core/platform.js";
import { keyPrincipal } from "../protocol/keys.js";
import { type AttemptRecord, type Journal, lockKey } from "./journal.js";
import { type PlanInput, planPublication } from "./plan.js";
import { type ReconcileOpts, reconcileAttempt } from "./reconcile.js";
import { type Authorizer, estimate, type SendOpts, sendPlan } from "./send.js";
import type { Plan, PlanResult, ReconcileResult, Review, SendResult } from "./types.js";

export interface WriterConfig {
  authorizer: Authorizer;
  journal: Journal;
}

export interface RunResult {
  kind: "efs.run";
  send: SendResult;
  reconcile?: ReconcileResult;
}

export interface EfsWriter {
  readonly account: Address;
  readonly principal: PrincipalId;
  /** Plan a publication from raw actions (the Files planner builds these for you). */
  planActions(input: Omit<PlanInput, "account">, o?: CallOpts): Promise<PlanResult>;
  review(plan: Plan, o?: CallOpts): Promise<Review>;
  send(plan: Plan, o?: SendOpts): Promise<SendResult>;
  reconcile(planId: Hex, o?: ReconcileOpts): Promise<ReconcileResult>;
  /** send, then reconcile once it is SUBMITTED or AMBIGUOUS. Never retries on its own. */
  run(plan: Plan, o?: SendOpts & ReconcileOpts): Promise<RunResult>;
  pending(): Promise<AttemptRecord[]>;
}

export async function createWriter(
  efs: Efs,
  config: WriterConfig,
  o: CallOpts = {},
): Promise<EfsWriter> {
  const a = config.authorizer;
  let account: Address;
  if (a.kind === "local") account = lower(a.account.address);
  else if (a.account) account = lower(a.account);
  else {
    // eth_accounts never prompts; connecting (eth_requestAccounts) is the app's job.
    const accounts = (await a.provider.request({ method: "eth_accounts" })) as string[];
    if (!accounts?.[0])
      throw new EfsFault(
        "MISUSE",
        "the wallet has no connected account: connect it first (eth_requestAccounts)",
      );
    account = lower(accounts[0] as Address);
  }
  void o;
  const principal = keyPrincipal(account);
  const lock = lockKey({
    chainId: efs.deployment.chainId,
    realmId: efs.deployment.realmId,
    ledger: efs.deployment.ledger,
    account,
  });
  return {
    account,
    principal,
    planActions: (input, opts) => planPublication(efs, { ...input, account }, opts),
    async review(plan, opts) {
      const est = await estimate(efs, plan, opts);
      const pin = await efs.at("latest", opts);
      const stale = pin.status !== "VERIFIED" || pin.basis.executionSet !== plan.executionSet;
      return {
        kind: "efs.review",
        effects: plan.effects,
        prompts: 1,
        gas: { estimate: "gas" in est ? est.gas : null, floor: null },
        wouldRevert: "revert" in est ? est.revert : null,
        stale,
        atomic: true,
      };
    },
    send: (plan, opts) => sendPlan(efs, config.journal, a, plan, opts),
    reconcile: (planId, opts) => reconcileAttempt(efs, config.journal, planId, opts),
    async run(plan, opts) {
      const send = await sendPlan(efs, config.journal, a, plan, opts);
      if (send.status !== "SUBMITTED" && send.status !== "AMBIGUOUS")
        return { kind: "efs.run", send };
      if (send.status === "SUBMITTED") await waitForReceipt(efs, send.txHash, opts);
      return {
        kind: "efs.run",
        send,
        reconcile: await reconcileAttempt(efs, config.journal, plan.id, opts),
      };
    },
    pending: () => config.journal.unresolved(lock),
  };
}

/** Wait (bounded) until a transaction has a receipt. Reconcile decides the outcome; this only avoids racing it. */
async function waitForReceipt(
  efs: Efs,
  txHash: Hex,
  o: CallOpts = {},
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  const port = efs._internal.pool.ports[0];
  if (!port) return;
  while (Date.now() - started < timeoutMs) {
    const [out] = await port.send([{ method: "eth_getTransactionReceipt", params: [txHash] }], {
      timeoutMs: 5000,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (out?.ok && out.result) return;
    await new Promise<void>((r) => {
      setTimer(r, 250);
    });
  }
}
