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
import { type Hex, lower, ZERO_WORD } from "../core/hex.js";
import type { DeploymentInfo } from "../deployment/manifest.js";
import { ledgerReadsAbi } from "../generated/abis.js";
import { chainStatus } from "../protocol/status.js";
import type { Journal } from "./journal.js";
import type { Plan, ReconcileResult } from "./types.js";

export type ReconcileOpts = CallOpts;

type Admitted = { present: true; publication: bigint; digest: Hex } | { present: false };

/**
 * publicationAt at one block, by its Status:
 *   PRESENT        the nonce is used: by `publication`, for `digest`;
 *   ABSENT_PROVEN  a live ledger at this block, and the nonce is unused (publication 0);
 *   UNKNOWN        no ledger code at this block (before the deployment, or a wrong address, chain or fork), and
 *                  empty return data (no reader code at this block) are both `present: false`: never evidence of
 *                  absence.
 * Anything else (UNSUPPORTED: not this layout, or not a ledger) is refused, never guessed at.
 */
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
  if (out.result === "0x") return { ok: true, value: { present: false } };
  let status: ReturnType<typeof chainStatus>;
  let publication: bigint;
  let digest: Hex;
  try {
    const [st, pub, dig] = decodeFunctionResult({
      abi: ledgerReadsAbi,
      functionName: "publicationAt",
      data: out.result as Hex,
    }) as unknown as [number, bigint, Hex];
    status = chainStatus(st);
    publication = BigInt(pub);
    digest = lower(dig);
  } catch {
    return {
      ok: false,
      retryElsewhere: true,
      reason: reason("RPC_ERROR", "transient", "publicationAt() did not decode"),
    };
  }
  if (status === "PRESENT") return { ok: true, value: { present: true, publication, digest } };
  if (status === "ABSENT_PROVEN")
    return { ok: true, value: { present: true, publication: 0n, digest: ZERO_WORD } };
  if (status === "UNKNOWN") return { ok: true, value: { present: false } };
  return {
    ok: false,
    retryElsewhere: false,
    reason: reason("UNSUPPORTED_PROFILE", "never", `publicationAt() answered ${status}`),
  };
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
      // The pin verified the ledger at this block, so "no ledger here" (UNKNOWN or empty) is an endpoint fault: try
      // another.
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
      // The finalized read only decides `final` and the reorg-safe NOT_COMMITTED_PROVEN. When it cannot be made (an
      // endpoint without the "finalized" tag, or a finalized block inside the deployment window where the reader
      // reverts), COMMITTED at the latest block is still decidable: the finalized side is then simply unknown.
      const fin = await getBlock(s, "finalized");
      const atFinal = fin.ok ? await admittedAt(s, d, plan, fin.value.hash) : undefined;
      if (!fin.ok || !atFinal?.ok) {
        return {
          ok: true,
          value: { latest: latest.value, final: { present: false }, finalTimestamp: -1n },
        };
      }
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
  // Reorged out: this attempt was COMMITTED (not final) and the latest block no longer shows its admission. It goes
  // back to SUBMISSION_POSSIBLE, never left as a stale COMMITTED. Sending it again is the user's choice (the same
  // plan is safe to send: AlreadyAdmitted if the original is re-included); reconcile keeps watching meanwhile.
  if (record.stage === "COMMITTED" && outcome === "UNKNOWN") {
    await journal.put({
      ...record,
      stage: "SUBMISSION_POSSIBLE",
      final: false,
      history: [
        ...record.history,
        {
          stage: "SUBMISSION_POSSIBLE",
          at: Date.now(),
          detail: `reorged out (basis ${basis.blockNumber})`,
        },
      ],
    });
    return {
      kind: "efs.reconcile",
      planId,
      outcome: "UNKNOWN",
      final: false,
      reason: reason(
        "REORGED",
        "after-reconcile",
        "the admission is no longer at the latest block",
      ),
      basis,
    };
  }
  if (outcome !== "UNKNOWN") {
    const { final: _drop, ...rest } = record;
    void _drop;
    await journal.put({
      ...rest,
      stage: outcome,
      ...(outcome === "COMMITTED" ? { publication: latest.publication, final: isFinal } : {}),
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
