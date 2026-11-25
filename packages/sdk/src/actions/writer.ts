// SPDX-License-Identifier: MIT
// createWriter: the write side of a client, bound to one account and one journal.
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault } from "../core/errors.js";
import { type Address, type Hex, lower, type PrincipalId } from "../core/hex.js";
import { keyPrincipal } from "../protocol/keys.js";
import { type AttemptRecord, type Journal, lockKey } from "./journal.js";
import { type PlanInput, planPublication } from "./plan.js";
import { waitForReceipt } from "./receipt.js";
import { type ReconcileOpts, reconcileAttempt } from "./reconcile.js";
import { type Authorizer, estimate, type SendOpts, sendPlan } from "./send.js";
import {
  type SequenceOpts,
  type SequencePartInput,
  type SequenceProgress,
  sequenceOps,
} from "./sequence.js";
import { gasPlanFor, type PlannedAction, ruleGas } from "./split.js";
import type {
  Plan,
  PlanResult,
  PlanSequenceResult,
  ReconcileResult,
  Review,
  SendResult,
} from "./types.js";

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
  /**
   * Plan the parts of one save (for example the output of splitPublications) as consecutive native nonces: part 0
   * takes the next nonce, part i that nonce + i. Send them in order; each part is its own plan, journal record and
   * exactly-once identity, so a failure anywhere is reconciled part by part.
   */
  planSequence(
    parts: readonly Omit<PlanInput, "account" | "nonce">[],
    o?: CallOpts,
  ): Promise<PlanSequenceResult>;
  review(plan: Plan, o?: CallOpts): Promise<Review>;
  send(plan: Plan, o?: SendOpts): Promise<SendResult>;
  reconcile(planId: Hex, o?: ReconcileOpts): Promise<ReconcileResult>;
  /** send, then reconcile once it is SUBMITTED or AMBIGUOUS. Never retries on its own. */
  run(plan: Plan, o?: SendOpts & ReconcileOpts): Promise<RunResult>;
  pending(): Promise<AttemptRecord[]>;
  /**
   * A save split into several publications (for example the parts of splitPublications), made resumable. Atomic
   * EIP-5792 wallets get one request for all parts; otherwise parts go one at a time, each planned just before it
   * is sent. COMPLETE is the only success; PARTIAL means "k of N saved, continue with resume".
   */
  runSequence(parts: readonly SequencePartInput[], o?: SequenceOpts): Promise<SequenceProgress>;
  /** Continue a sequence. The only sequence call that may prompt. */
  resume(sequenceId: Hex, o?: SequenceOpts): Promise<SequenceProgress>;
  /** Settle a sequence from the ledger alone: never prompts (safe on every app start). */
  reconcileSequence(sequenceId: Hex, o?: SequenceOpts): Promise<SequenceProgress>;
  /** Open sequences of this account (neither COMPLETE nor ABANDONED). */
  pendingSequences(): Promise<SequenceProgress[]>;
  /** Stop offering to continue; committed parts stay on chain. Refused while a part is in flight. */
  abandon(sequenceId: Hex, o?: SequenceOpts): Promise<SequenceProgress>;
}

/** V for a plan's actions alone (no shapes or rows known): every bind a first statement, so an upper bound. */
function floorOf(
  efs: Efs,
  plan: { actions: readonly PlannedAction["action"][]; bodies: readonly Hex[] },
): bigint | null {
  const g = gasPlanFor(efs.deployment);
  if (!g.ok || !g.model.floor) return null;
  const list: PlannedAction[] = plan.actions.map((action, i) => ({
    action,
    body: plan.bodies[i] ?? "0x",
    firstStatement: true,
  }));
  return BigInt(ruleGas(list, g.model, false, g.typeNames).V);
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
  const writer: EfsWriter = {
    account,
    principal,
    planActions: (input, opts) => planPublication(efs, { ...input, account }, opts),
    async planSequence(parts, opts) {
      if (parts.length === 0) throw new EfsFault("MISUSE", "planSequence needs at least one part");
      const plans: Plan[] = [];
      for (let i = 0; i < parts.length; i++) {
        const first = plans[0];
        const r = await planPublication(
          efs,
          {
            ...(parts[i] as Omit<PlanInput, "account">),
            account,
            ...(first ? { nonce: first.nonce + BigInt(i) } : {}),
          },
          opts,
        );
        if (r.status !== "PLANNED")
          return { kind: "efs.planSequence", status: r.status, reason: r.reason, at: i };
        plans.push(r.plan);
      }
      return { kind: "efs.planSequence", status: "PLANNED", plans };
    },
    async review(plan, opts) {
      const est = await estimate(efs, plan, opts);
      const pin = await efs.at("latest", opts);
      const stale = pin.status !== "VERIFIED" || pin.basis.executionSet !== plan.executionSet;
      return {
        kind: "efs.review",
        effects: plan.effects,
        prompts: 1,
        gas: { estimate: "gas" in est ? est.gas : null, floor: floorOf(efs, plan) },
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
    ...sequenceOps({
      efs,
      journal: config.journal,
      authorizer: a,
      account,
      lock,
      plan: (input, opts) => planPublication(efs, { ...input, account }, opts),
      planSequence: (parts, opts) => writer.planSequence(parts, opts),
    }),
  };
  return writer;
}

export { waitForReceipt } from "./receipt.js";
