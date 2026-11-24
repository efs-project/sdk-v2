// SPDX-License-Identifier: MIT
// Reconcile an attempt from the ledger alone: no wallet, no rebroadcast.
//   COMMITTED             publicationAt(principal, nonce) names this plan's digest at the latest block. `final`
//                         says whether that is also true at the finalized block.
//   NOT_COMMITTED_PROVEN  reorg-safe only: either a FINALIZED block is past the plan's deadline (the ledger can
//                         never admit it afterwards), or another plan's admission of the nonce is finalized.
//   UNKNOWN               anything else: wait, then reconcile again.
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { callsAt, getBlock } from "../chain/basis.js";
import { onEndpoint, type Session, type Step } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { type CallOpts, reason } from "../core/errors.js";
import { type Hex, lower } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import type { Journal } from "./journal.js";
import type { Plan, ReconcileResult } from "./types.js";

export type ReconcileOpts = CallOpts;

type Admitted = { present: true; publication: bigint; digest: Hex } | { present: false };

/** publicationAt at one block. `present: false` = empty return data: no ledger reader answered at this block. */
async function admittedAt(
  s: Session,
  d: DeploymentInfo,
  plan: Plan,
  blockHash: Hex,
): Promise<Step<Admitted>> {
  const [out] = await callsAt(s, blockHash, [
    {
      to: d.readers.ledgerReads,
      data: encodeFunctionData({
        abi: ledgerReadsAbi,
        functionName: "publicationAt",
        args: [d.ledger, plan.principal, plan.nonce],
      }),
    },
  ]);
  if (!out?.ok)
    return {
      ok: false,
      retryElsewhere: true,
      reason: out ? out.reason : reason("RPC_UNAVAILABLE", "transient"),
    };
  // A live reader never returns empty data; empty means no code there (before deployment, or a wrong
  // address/chain/fork). It is never read as "not admitted" by itself.
  if (out.result === "0x") return { ok: true, value: { present: false } };
  try {
    const [, publication, digest] = decodeFunctionResult({
      abi: ledgerReadsAbi,
      functionName: "publicationAt",
      data: out.result as Hex,
    }) as unknown as [number, bigint, Hex];
    return {
      ok: true,
      value: { present: true, publication: BigInt(publication), digest: lower(digest) },
    };
  } catch {
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason("RPC_ERROR", "transient", "publicationAt() did not decode"),
    };
  }
}

export async function reconcileAttempt(
  efs: Efs,
  journal: Journal,
  planId: Hex,
  o: ReconcileOpts = {},
): Promise<ReconcileResult> {
  const record = await journal.get(planId);
  if (!record)
    return {
      kind: "efs.reconcile",
      planId,
      outcome: "UNKNOWN",
      reason: reason("NOT_IN_JOURNAL", "never", "no attempt with this plan id"),
    };
  const plan = record.plan;
  const pin = await efs.at("latest", o);
  if (pin.status !== "VERIFIED")
    return {
      kind: "efs.reconcile",
      planId,
      outcome: "UNKNOWN",
      reason: pin.status === "UNKNOWN" ? pin.reason : reason("NOT_VERIFIED_DEPLOYMENT", "never"),
    };
  const basis = pin.basis;
  const d = efs.deployment;
  type Seen = {
    latest: { publication: bigint; digest: Hex };
    final: Admitted;
    finalTimestamp: bigint;
  };
  const r = await onEndpoint<Seen>(
    efs._internal.pool,
    async (s) => {
      const latest = await admittedAt(s, d, plan, basis.blockHash);
      if (!latest.ok) return latest;
      // The pin verified the ledger at this block, so an empty answer here is an endpoint fault: try another.
      if (!latest.value.present)
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "NOT_VERIFIED_DEPLOYMENT",
            "transient",
            "no ledger reader answered at the pinned block",
          ),
        };
      const fin = await getBlock(s, "finalized");
      if (!fin.ok) return fin;
      const atFinal = await admittedAt(s, d, plan, fin.value.hash);
      if (!atFinal.ok) return atFinal;
      // No reader at a finalized block that is already past the deadline is impossible for a real deployment
      // (the deadline was set against a live ledger): surface it, never conclude from it.
      if (!atFinal.value.present && fin.value.timestamp > plan.deadline) {
        return {
          ok: false,
          retryElsewhere: true,
          reason: reason(
            "NOT_VERIFIED_DEPLOYMENT",
            "transient",
            "no ledger reader at a finalized block past the deadline",
          ),
        };
      }
      return {
        ok: true,
        value: { latest: latest.value, final: atFinal.value, finalTimestamp: fin.value.timestamp },
      };
    },
    o,
  );
  if (!r.ok) return { kind: "efs.reconcile", planId, outcome: "UNKNOWN", reason: r.reason, basis };
  const { latest, final, finalTimestamp } = r.value;
  let outcome: ReconcileResult["outcome"] = "UNKNOWN";
  let why = "not admitted, and no finalized block is past the deadline yet";
  if (latest.publication !== 0n && latest.digest === plan.digest) outcome = "COMMITTED";
  else if (final.present && final.publication !== 0n && final.digest !== plan.digest)
    outcome = "NOT_COMMITTED_PROVEN"; // nonce finalized for another plan
  else if (latest.publication === 0n && final.present && finalTimestamp > plan.deadline)
    outcome = "NOT_COMMITTED_PROVEN"; // a live ledger, final, past the deadline
  else if (latest.publication !== 0n)
    why = "the nonce was admitted for a different plan, but that is not final yet";
  const isFinal =
    outcome === "COMMITTED"
      ? final.present && final.publication !== 0n && final.digest === plan.digest
      : outcome === "NOT_COMMITTED_PROVEN";
  if (outcome !== "UNKNOWN") {
    await journal.put({
      ...record,
      stage: outcome,
      ...(outcome === "COMMITTED" ? { publication: latest.publication } : {}),
      history: [
        ...record.history,
        {
          stage: outcome,
          at: Date.now(),
          detail: `basis ${basis.blockNumber}${isFinal ? " (final)" : ""}`,
        },
      ],
    });
  }
  return {
    kind: "efs.reconcile",
    planId,
    outcome,
    final: isFinal,
    ...(outcome === "COMMITTED" ? { publication: latest.publication } : {}),
    ...(outcome === "UNKNOWN"
      ? { reason: reason("NOT_YET_DECIDABLE", "after-reconcile", why) }
      : {}),
    basis,
  };
}
