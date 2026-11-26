// SPDX-License-Identifier: MIT
// inFlightTwin: which earlier attempt holds back another plan of the same publication. Open attempts hold it (on its
// way: SUBMISSION_POSSIBLE or SUBMITTED; COMMITTED and not yet final). Settled ones (final, NOT_SENT, proven not
// committed) and an unsent PLANNED record don't. Only the same actions and bodies, from the same account, under
// another plan id count, and the twin names its save when the journal has one.
import { describe, expect, it } from "vitest";
import {
  type AttemptRecord,
  type AttemptStage,
  lockKey,
  memoryJournal,
  type SequenceRecord,
} from "../src/actions/journal.ts";
import { inFlightTwin } from "../src/actions/send.ts";
import type { Plan } from "../src/actions/types.ts";
import type { Hex } from "../src/core/hex.ts";
import { textRecordAction } from "../src/tags/topics.ts";

const T = {
  word: `0x${"11".repeat(32)}`,
  path: `0x${"22".repeat(32)}`,
  text: `0x${"33".repeat(32)}`,
} as never;
const account = `0x${"cc".repeat(20)}` as Hex;
const planOf = (id: string, text: string, who: Hex = account): Plan => {
  const { action, body } = textRecordAction(T, text);
  return {
    chainId: 31337,
    realmId: `0x${"aa".repeat(32)}`,
    ledger: `0x${"bb".repeat(20)}`,
    account: who,
    id: `0x${id.repeat(64)}`,
    actions: [action],
    bodies: [body],
  } as unknown as Plan;
};
const attempt = (plan: Plan, stage: AttemptStage, final?: boolean): AttemptRecord => ({
  schema: "efs-sdk-attempt/1",
  planId: plan.id,
  plan,
  stage,
  history: [],
  ...(final !== undefined ? { final } : {}),
});

describe("inFlightTwin", () => {
  const first = planOf("1", "the same publication");
  const again = planOf("2", "the same publication");
  const cases: [AttemptStage, boolean | undefined, boolean][] = [
    ["PLANNED", undefined, false],
    ["SUBMISSION_POSSIBLE", undefined, true],
    ["SUBMITTED", undefined, true],
    ["COMMITTED", false, true],
    ["COMMITTED", true, false],
    ["NOT_SENT", undefined, false],
    ["NOT_COMMITTED_PROVEN", undefined, false],
  ];
  for (const [stage, final, holds] of cases)
    it(`${stage}${final === undefined ? "" : final ? " (final)" : " (not final)"} ${holds ? "holds the repeat back" : "lets it go"}`, async () => {
      const j = memoryJournal();
      await j.put(attempt(first, stage, final));
      const twin = await inFlightTwin(j, lockKey(again), again);
      expect(twin?.record.planId).toBe(holds ? first.id : undefined);
    });

  it("only the same publication from the same account under another plan id: never itself, another text or account", async () => {
    const j = memoryJournal();
    await j.put(attempt(first, "SUBMITTED"));
    expect(await inFlightTwin(j, lockKey(first), first)).toBeUndefined();
    const other = planOf("3", "another publication");
    expect(await inFlightTwin(j, lockKey(other), other)).toBeUndefined();
    const elsewhere = planOf("4", "the same publication", `0x${"dd".repeat(20)}` as Hex);
    expect(await inFlightTwin(j, lockKey(elsewhere), elsewhere)).toBeUndefined();
  });

  it("names the twin's save when the journal holds it", async () => {
    const j = memoryJournal();
    await j.put(attempt(first, "SUBMITTED"));
    const seq = {
      schema: "efs-sdk-sequence/1",
      sequenceId: `0x${"5".repeat(64)}`,
      lock: lockKey(first),
      state: "IN_FLIGHT",
      parts: [{ actions: first.actions, bodies: first.bodies, effects: [], planId: first.id }],
      history: [],
    } as unknown as SequenceRecord;
    await j.putSequence(seq);
    expect(await inFlightTwin(j, lockKey(again), again)).toMatchObject({
      record: { planId: first.id },
      sequenceId: seq.sequenceId,
    });
  });
});
