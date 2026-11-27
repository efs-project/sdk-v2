// SPDX-License-Identifier: MIT
// Plan one publication: read the account's next nonce and the acceptance profile at one basis, bind both
// expectations (execution set and acceptance profile), and compute the native intent digest. The digest is what
// the ledger uses to recognize an exact retry (AlreadyAdmitted), so a plan is safe to re-send only unchanged.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { callsAt } from "../chain/basis.js";
import { onEndpoint } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, EfsFault, reason } from "../core/errors.js";
import { type Address, type Hex, lower } from "../core/hex.js";
import { ingressAbi, ledgerAbi } from "../generated/abis.js";
import { keyPrincipal, nativeIntentDigest } from "../protocol/keys.js";
import { scheduleCheck } from "./schedule.js";
import type { ActionData, EffectView, Plan, PlanResult } from "./types.js";

/** The ABI type of Action[] exactly as `execute` declares it (taken from the generated ABI, not hand-written). */
const executeAbi = ledgerAbi.find(
  (x) => x.type === "function" && x.name === "execute",
) as unknown as {
  inputs: readonly [{ type: string; components: readonly unknown[] }, ...unknown[]];
};
const ACTIONS_PARAM = [executeAbi.inputs[0]] as const;
const EMPTY_GUARD: Hex = "0x";
const ZERO = /^0x0{64}$/;

/**
 * How far a basis block's timestamp may run ahead of this device's clock (seconds) before planning fails over. A plan's
 * deadline is the basis block's timestamp + its window, so an endpoint can never stretch a signed deadline more than
 * this past the device's clock + the window. A basis behind the clock (an idle chain) is accepted as it is.
 */
export const CLOCK_SKEW_SECONDS = 900;

/** The hash of a publication's actions as the ledger checks them (keccak256 of their ABI encoding), part of its digest. */
export function actionsHash(actions: readonly ActionData[]): Hex {
  return keccak256(encodeAbiParameters(ACTIONS_PARAM as never, [actions] as never));
}

export interface PlanInput {
  account: Address;
  actions: readonly ActionData[];
  bodies: readonly Hex[];
  effects: readonly EffectView[];
  /** Seconds from the basis block's timestamp (default 15 minutes). The ledger refuses the plan after this. */
  deadlineSeconds?: number;
  /**
   * An explicit native nonce, for the later parts of a sequence (planSequence): part i of a split save uses the
   * first part's nonce + i. Default: the principal's next nonce at the basis.
   */
  nonce?: bigint;
  /**
   * The planner's estimate of this publication (batchGasOf: intrinsic and calldata included), and with an amsterdam
   * model its whole gas (state gas included). With both, the plan carries them as `plannedGas`.
   */
  gas?: number;
  total?: number;
}

/**
 * @internal Re-derive a plan's calldata and digest from its own fields and this deployment, before any wallet is
 * asked: a plan read back from the journal (resume, a resend after a funds refusal) or handed in by an app is signed
 * only if its calldata is exactly the publication it names, for this deployment and account, with both expectations
 * bound. INVARIANT otherwise (altered, corrupted or another deployment's), and nothing is sent.
 */
export function checkPlan(efs: Efs, plan: Plan): void {
  const d = efs.deployment;
  const wrong: string[] = [];
  if (plan.chainId !== d.chainId) wrong.push("chain id");
  if (lower(plan.ledger) !== lower(d.ledger)) wrong.push("ledger");
  if (lower(plan.realmId) !== lower(d.realmId)) wrong.push("realm");
  if (lower(plan.principal) !== lower(keyPrincipal(lower(plan.account)))) wrong.push("principal");
  if (ZERO.test(plan.executionSet) || ZERO.test(plan.acceptanceProfile))
    wrong.push("an unbound expectation (0)");
  if (plan.actions.length !== plan.bodies.length) wrong.push("bodies");
  try {
    const ctx = {
      nonce: plan.nonce,
      deadline: plan.deadline,
      expectedExecutionSet: plan.executionSet,
      expectedAcceptanceProfile: plan.acceptanceProfile,
    };
    const calldata = encodeFunctionData({
      abi: ledgerAbi,
      functionName: "execute",
      args: [plan.actions as never, plan.bodies, ctx, EMPTY_GUARD],
    });
    if (calldata !== lower(plan.calldata)) wrong.push("calldata");
    const digest = nativeIntentDigest({
      realmId: plan.realmId,
      principal: plan.principal,
      nonce: plan.nonce,
      deadline: plan.deadline,
      expectedExecutionSet: plan.executionSet,
      expectedAcceptanceProfile: plan.acceptanceProfile,
      guardHash: keccak256(EMPTY_GUARD),
      actionsHash: actionsHash(plan.actions),
    });
    if (lower(digest) !== lower(plan.digest) || lower(plan.id) !== lower(plan.digest))
      wrong.push("digest");
  } catch {
    wrong.push("fields that don't encode");
  }
  if (wrong.length)
    throw new EfsFault(
      "INVARIANT",
      `this plan is not the publication it names (${wrong.join(", ")}): it was altered, corrupted or made for another deployment; nothing was sent`,
      { details: { planId: plan.id, wrong } },
    );
}

/**
 * Plan one publication from its actions and bodies, without a wallet (what `writer.planActions` runs): limits
 * checked, the nonce and acceptance profile read at a pinned basis, the calldata encoded. PLANNED, REFUSED or UNKNOWN.
 */
export async function planPublication(
  efs: Efs,
  input: PlanInput,
  o: CallOpts = {},
): Promise<PlanResult> {
  const d = efs.deployment;
  if (input.actions.length === 0)
    return {
      kind: "efs.planResult",
      status: "REFUSED",
      reason: reason("LIMIT_EXCEEDED", "never", "a publication needs at least one action"),
    };
  if (input.actions.length !== input.bodies.length)
    return {
      kind: "efs.planResult",
      status: "REFUSED",
      reason: reason("INVALID", "never", "actions and bodies differ in length"),
    };
  if (input.actions.length > d.limits.maxActionsPerPublication) {
    return {
      kind: "efs.planResult",
      status: "REFUSED",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${input.actions.length} actions; the limit is ${d.limits.maxActionsPerPublication}`,
      ),
    };
  }
  const bodyBytes = input.bodies.reduce((n, b) => n + (b.length - 2) / 2, 0);
  if (bodyBytes > d.limits.maxBodyBytesPerPublication) {
    return {
      kind: "efs.planResult",
      status: "REFUSED",
      reason: reason(
        "LIMIT_EXCEEDED",
        "never",
        `${bodyBytes} body bytes; the limit is ${d.limits.maxBodyBytesPerPublication}`,
      ),
    };
  }
  // The document's fee schedule must be the chain's (one measurement per client, kept 10 minutes).
  const fee = await scheduleCheck(efs, o);
  if (!fee.ok)
    return {
      kind: "efs.planResult",
      status: fee.failed ? "UNKNOWN" : "REFUSED",
      reason: fee.reason,
    };
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.planResult",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  // The signed expectation is the deployment document's execution set, and only while the chain's is the same one:
  // a zero expectation would waive the ledger's check, so it is never signed.
  const executionSet = lower(d.executionSet);
  if (ZERO.test(executionSet))
    return {
      kind: "efs.planResult",
      status: "REFUSED",
      reason: reason(
        "NOT_VERIFIED_DEPLOYMENT",
        "never",
        "the deployment document names no execution set",
      ),
    };
  const account = lower(input.account);
  const principal = keyPrincipal(account);
  const ingress = d.ingress;
  const r = await onEndpoint(
    efs._internal.pool,
    async (s) => {
      const block = await s.request("eth_getBlockByHash", [basis.blockHash, false]);
      if (!block.ok) return { ok: false, retryElsewhere: true, reason: block.reason };
      const timestamp = BigInt((block.result as { timestamp: Hex }).timestamp);
      const outs = await callsAt(s, basis.blockHash, [
        {
          to: d.ledger,
          data: encodeFunctionData({ abi: ledgerAbi, functionName: "nonceOf", args: [principal] }),
        },
        {
          to: d.ledger,
          data: encodeFunctionData({ abi: ledgerAbi, functionName: "executionSet" }),
        },
        {
          to: ingress,
          data: encodeFunctionData({
            abi: ingressAbi,
            functionName: "acceptanceProfileOf",
            args: [d.ledger, input.actions as never],
          }),
        },
      ]);
      const bad = outs.find((x) => !x.ok);
      if (bad && !bad.ok)
        return { ok: false, retryElsewhere: bad.kind === "transport", reason: bad.reason };
      let nonce: bigint;
      let profile: Hex;
      let live: Hex;
      try {
        [nonce] = decodeFunctionResult({
          abi: ledgerAbi,
          functionName: "nonceOf",
          data: (outs[0] as { result: Hex }).result,
        }) as unknown as [bigint, bigint];
        live = decodeFunctionResult({
          abi: ledgerAbi,
          functionName: "executionSet",
          data: (outs[1] as { result: Hex }).result,
        }) as unknown as Hex;
        profile = decodeFunctionResult({
          abi: ingressAbi,
          functionName: "acceptanceProfileOf",
          data: (outs[2] as { result: Hex }).result,
        }) as unknown as Hex;
      } catch {
        // a reply that doesn't decode is this endpoint's fault, never a thrown error
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "RPC_ERROR",
            "transient",
            "nonceOf / executionSet / acceptanceProfileOf did not decode",
          ),
        };
      }
      // Each signed value this endpoint supplies is checked before it is signed: a reply that would waive a ledger
      // check, or stretch the deadline, fails over (with one endpoint the plan is UNKNOWN).
      if (lower(live) !== executionSet)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "NOT_VERIFIED_DEPLOYMENT",
            "transient",
            `the chain's execution set ${lower(live)} is not the deployment document's ${executionSet} (if every endpoint says so, the deployment moved on: update its document)`,
          ),
        };
      if (ZERO.test(profile))
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "RPC_ERROR",
            "transient",
            "acceptanceProfileOf answered 0, which would waive the ledger's check",
          ),
        };
      const clock = BigInt(Math.floor(Date.now() / 1000));
      if (timestamp > clock + BigInt(CLOCK_SKEW_SECONDS))
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "RPC_ERROR",
            "transient",
            `the basis block's timestamp is ${timestamp - clock} s ahead of this device's clock (at most ${CLOCK_SKEW_SECONDS} s)`,
          ),
        };
      return {
        ok: true,
        value: { nonce: input.nonce ?? nonce, profile: lower(profile), start: timestamp },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.planResult", status: "UNKNOWN", reason: r.reason };
  const deadline = r.value.start + BigInt(input.deadlineSeconds ?? 900);
  const hash = actionsHash(input.actions);
  const digest = nativeIntentDigest({
    realmId: d.realmId,
    principal,
    nonce: r.value.nonce,
    deadline,
    expectedExecutionSet: executionSet,
    expectedAcceptanceProfile: r.value.profile,
    guardHash: keccak256(EMPTY_GUARD),
    actionsHash: hash,
  });
  const ctx = {
    nonce: r.value.nonce,
    deadline,
    expectedExecutionSet: executionSet,
    expectedAcceptanceProfile: r.value.profile,
  };
  const calldata = encodeFunctionData({
    abi: ledgerAbi,
    functionName: "execute",
    args: [input.actions as never, input.bodies, ctx, EMPTY_GUARD],
  });
  const plan: Plan = {
    kind: "efs.plan",
    v: 1,
    id: digest,
    digest,
    chainId: d.chainId,
    realmId: d.realmId,
    ledger: d.ledger,
    principal,
    account,
    nonce: r.value.nonce,
    deadline,
    executionSet,
    acceptanceProfile: r.value.profile,
    actions: input.actions,
    bodies: input.bodies,
    calldata,
    effects: input.effects,
    basis,
    ...(input.gas !== undefined && input.total !== undefined
      ? { plannedGas: { execution: input.gas, total: input.total } }
      : {}),
  };
  return { kind: "efs.planResult", status: "PLANNED", plan };
}
