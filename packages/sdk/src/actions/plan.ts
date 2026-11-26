// SPDX-License-Identifier: MIT
// Plan one publication: read the account's next nonce and the acceptance profile at one basis, bind both
// expectations (execution set and acceptance profile), and compute the native intent digest. The digest is what
// the ledger uses to recognize an exact retry (AlreadyAdmitted), so a plan is safe to re-send only unchanged.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { callsAt } from "../chain/basis.js";
import { onEndpoint } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, reason } from "../core/errors.js";
import { type Address, type Hex, lower } from "../core/hex.js";
import { ingressAbi, ledgerAbi } from "../generated/abis.js";
import { keyPrincipal, nativeIntentDigest } from "../protocol/keys.js";
import type { ActionData, EffectView, Plan, PlanResult } from "./types.js";

/** The ABI type of Action[] exactly as `execute` declares it (taken from the generated ABI, not hand-written). */
const executeAbi = ledgerAbi.find(
  (x) => x.type === "function" && x.name === "execute",
) as unknown as {
  inputs: readonly [{ type: string; components: readonly unknown[] }, ...unknown[]];
};
const ACTIONS_PARAM = [executeAbi.inputs[0]] as const;
const EMPTY_GUARD: Hex = "0x";

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
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.planResult",
      status: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
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
      const [nonce] = decodeFunctionResult({
        abi: ledgerAbi,
        functionName: "nonceOf",
        data: (outs[0] as { result: Hex }).result,
      }) as unknown as [bigint, bigint];
      const profile = decodeFunctionResult({
        abi: ingressAbi,
        functionName: "acceptanceProfileOf",
        data: (outs[1] as { result: Hex }).result,
      }) as unknown as Hex;
      return {
        ok: true,
        value: { nonce: input.nonce ?? nonce, profile: lower(profile), timestamp },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.planResult", status: "UNKNOWN", reason: r.reason };
  const deadline = r.value.timestamp + BigInt(input.deadlineSeconds ?? 900);
  const hash = actionsHash(input.actions);
  const digest = nativeIntentDigest({
    realmId: d.realmId,
    principal,
    nonce: r.value.nonce,
    deadline,
    expectedExecutionSet: basis.executionSet,
    expectedAcceptanceProfile: r.value.profile,
    guardHash: keccak256(EMPTY_GUARD),
    actionsHash: hash,
  });
  const ctx = {
    nonce: r.value.nonce,
    deadline,
    expectedExecutionSet: basis.executionSet,
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
    executionSet: basis.executionSet,
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
