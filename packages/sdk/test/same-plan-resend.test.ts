// SPDX-License-Identifier: MIT
// When the same plan may be sent again (fundsResendable, src/actions/send.ts): only an attempt whose latest journal
// entry is a funds refusal (INSUFFICIENT_FUNDS) and that never reached SUBMITTED (no wallet ever returned a hash).
// Every other attempt that may have gone out keeps the rule that a plan id is never sent twice: a lost response, a
// disconnect, a submitted or committed attempt.
import { describe, expect, it } from "vitest";
import type { AttemptRecord, AttemptStage } from "../src/actions/journal.ts";
import { fundsRefusal, fundsResendable } from "../src/actions/send.ts";
import type { Plan } from "../src/actions/types.ts";
import type { Hex } from "../src/core/hex.ts";

const plan = { id: `0x${"aa".repeat(32)}` } as unknown as Plan;
const at = 1;
const rec = (
  history: AttemptRecord["history"],
  stage: AttemptStage = "SUBMISSION_POSSIBLE",
  extra: Partial<AttemptRecord> = {},
): AttemptRecord => ({
  schema: "efs-sdk-attempt/1",
  planId: plan.id,
  plan,
  stage,
  history,
  ...extra,
});
const refused = (r: AttemptRecord) =>
  fundsRefusal(r, "the wallet needs enough to cover the gas limit");

describe("fundsResendable", () => {
  it("a funds refusal as the latest entry, never SUBMITTED: the same plan may go again", () => {
    const r = refused(rec([{ stage: "SUBMISSION_POSSIBLE", at }]));
    expect(r.stage).toBe("SUBMISSION_POSSIBLE");
    expect(r.history.at(-1)).toMatchObject({
      stage: "SUBMISSION_POSSIBLE",
      refusal: "INSUFFICIENT_FUNDS",
    });
    expect(fundsResendable(r)).toBe(true);
    // A refused local-account broadcast carries its own (never accepted) hash: still never SUBMITTED.
    expect(fundsResendable({ ...r, txHash: `0x${"bb".repeat(32)}` as Hex })).toBe(true);
  });

  it("anything after the refusal, or any SUBMITTED entry, or another stage: never", () => {
    const r = refused(rec([{ stage: "SUBMISSION_POSSIBLE", at }]));
    expect(
      fundsResendable({ ...r, history: [...r.history, { stage: "SUBMISSION_POSSIBLE", at }] }),
    ).toBe(false);
    expect(
      fundsResendable(
        refused(
          rec([
            { stage: "SUBMISSION_POSSIBLE", at },
            { stage: "SUBMITTED", at },
          ]),
        ),
      ),
    ).toBe(false);
    for (const stage of [
      "SUBMITTED",
      "COMMITTED",
      "NOT_SENT",
      "PLANNED",
      "NOT_COMMITTED_PROVEN",
    ] as const)
      expect(fundsResendable({ ...r, stage }), stage).toBe(false);
  });

  it("a lost response or a disconnect (no refusal recorded) is never sent again", () => {
    expect(
      fundsResendable(
        rec([
          { stage: "SUBMISSION_POSSIBLE", at },
          { stage: "SUBMISSION_POSSIBLE", at, detail: "network connection lost" },
        ]),
      ),
    ).toBe(false);
    expect(fundsResendable(rec([{ stage: "SUBMISSION_POSSIBLE", at }]))).toBe(false);
  });
});
