// SPDX-License-Identifier: MIT
// One behavioural contract for every Journal: memory (unit), file (unit, Node) and IndexedDB (browser).
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/journal-ambiguous-before.json" with { type: "json" };
import {
  type AttemptRecord,
  type Journal,
  lockKey,
  type SequenceRecord,
} from "../src/actions/journal.ts";
import { fromJson, toJson } from "../src/core/json.ts";

/** A real attempt recorded from a fixture chain (stage SUBMISSION_POSSIBLE). */
export const SAMPLE: AttemptRecord = fromJson<AttemptRecord>(JSON.stringify(fixture.result));

export function variant(
  base: AttemptRecord,
  n: number,
  over: Partial<AttemptRecord> = {},
): AttemptRecord {
  const id = `0x${n.toString(16).padStart(64, "0")}` as AttemptRecord["planId"];
  return { ...base, planId: id, plan: { ...base.plan, id }, ...over };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function journalContract(
  name: string,
  make: () => Journal | Promise<Journal>,
  opts: { reopen?: () => Journal | Promise<Journal> } = {},
): void {
  describe(`${name} journal contract`, () => {
    it("round-trips a record exactly, bigints and unknown fields included", async () => {
      const j = await make();
      const rec = { ...SAMPLE, extensions: { future: { a: [1, 2n] } } } as AttemptRecord;
      await j.put(rec);
      const back = await j.get(rec.planId);
      expect(back && toJson(back)).toBe(toJson(rec));
      expect(typeof back?.plan.nonce).toBe("bigint");
      expect(
        await j.get(rec.planId.toUpperCase().replace("0X", "0x") as AttemptRecord["planId"]),
      ).toBeDefined();
      expect(await j.get(`0x${"ab".repeat(32)}`)).toBeUndefined();
    });

    it("returns copies: mutating a result never changes the store", async () => {
      const j = await make();
      await j.put(SAMPLE);
      const a = (await j.get(SAMPLE.planId)) as AttemptRecord;
      (a as { stage: string }).stage = "COMMITTED";
      expect((await j.get(SAMPLE.planId))?.stage).toBe(SAMPLE.stage);
    });

    it("put replaces, and unresolved filters by lock and stage", async () => {
      const j = await make();
      const lock = lockKey(SAMPLE.plan);
      const other = variant(SAMPLE, 2, {});
      const otherAccount = variant(SAMPLE, 3);
      const foreign = {
        ...otherAccount,
        plan: { ...otherAccount.plan, account: "0x000000000000000000000000000000000000dead" },
      } as AttemptRecord;
      await j.put(variant(SAMPLE, 1));
      await j.put(other);
      await j.put(foreign);
      expect((await j.unresolved(lock)).map((r) => r.planId).sort()).toEqual(
        [variant(SAMPLE, 1).planId, other.planId].sort(),
      );
      await j.put({ ...other, stage: "COMMITTED" });
      expect((await j.get(other.planId))?.stage).toBe("COMMITTED");
      expect((await j.unresolved(lock)).map((r) => r.planId)).toEqual([variant(SAMPLE, 1).planId]);
      await j.put({ ...variant(SAMPLE, 1), stage: "NOT_SENT" });
      expect(await j.unresolved(lock)).toEqual([]);
      expect((await j.unresolved(lockKey(foreign.plan))).length).toBe(1);
    });

    it("withLock: BUSY at once when held and wait is false; free again after release, even after a throw", async () => {
      const j = await make();
      const lock = `efs:test:${name}:busy`;
      let release = (): void => {};
      const holding = j.withLock(
        lock,
        false,
        () => new Promise<string>((r) => (release = () => r("held"))),
      );
      await sleep(20);
      expect(await j.withLock(lock, false, async () => "second")).toBe("BUSY");
      release();
      expect(await holding).toBe("held");
      await expect(
        j.withLock(lock, false, async () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      expect(await j.withLock(lock, false, async () => "after")).toBe("after");
    });

    it("withLock: a numeric wait times out as BUSY, or acquires once the holder finishes in time", async () => {
      const j = await make();
      const lock = `efs:test:${name}:timed`;
      let release = (): void => {};
      const holding = j.withLock(lock, false, () => new Promise<void>((r) => (release = r)));
      await sleep(20);
      expect(await j.withLock(lock, 60, async () => "late")).toBe("BUSY");
      const waiting = j.withLock(lock, 5_000, async () => "acquired");
      await sleep(30);
      release();
      await holding;
      expect(await waiting).toBe("acquired");
    });

    it("withLock: queued callers never overlap", async () => {
      const j = await make();
      const lock = `efs:test:${name}:queue`;
      let inside = 0;
      let peak = 0;
      const order: number[] = [];
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          j.withLock(lock, true, async () => {
            inside++;
            peak = Math.max(peak, inside);
            await sleep(15);
            order.push(i);
            inside--;
          }),
        ),
      );
      expect(peak).toBe(1);
      expect(order.sort()).toEqual([0, 1, 2, 3]);
    });

    it("sequences: round-trip exactly, list only open ones for the lock, survive state changes", async () => {
      const j = await make();
      const seq = (n: number, state: SequenceRecord["state"]): SequenceRecord => ({
        schema: "efs-sdk-sequence/1",
        sequenceId: `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`,
        lock: lockKey(SAMPLE.plan),
        chainId: SAMPLE.plan.chainId,
        realmId: SAMPLE.plan.realmId,
        ledger: SAMPLE.plan.ledger,
        account: SAMPLE.plan.account,
        parts: [
          {
            actions: SAMPLE.plan.actions,
            bodies: SAMPLE.plan.bodies,
            effects: SAMPLE.plan.effects,
            planId: SAMPLE.planId,
            committed: true,
            publication: 7n,
          },
          {
            actions: SAMPLE.plan.actions,
            bodies: SAMPLE.plan.bodies,
            effects: SAMPLE.plan.effects,
          },
        ],
        state,
        history: [{ state, at: 1 }],
      });
      await j.putSequence(seq(1, "PARTIAL"));
      await j.putSequence(seq(2, "COMPLETE"));
      await j.putSequence(seq(3, "ABANDONED"));
      await j.putSequence({ ...seq(4, "IN_FLIGHT"), lock: "efs:other" });
      expect(toJson(await j.getSequence(seq(1, "PARTIAL").sequenceId))).toBe(
        toJson(seq(1, "PARTIAL")),
      );
      expect((await j.openSequences(lockKey(SAMPLE.plan))).map((r) => r.state)).toEqual([
        "PARTIAL",
      ]);
      await j.putSequence(seq(1, "COMPLETE"));
      expect(await j.openSequences(lockKey(SAMPLE.plan))).toEqual([]);
      expect(await j.getSequence(`0x${"ee".repeat(32)}`)).toBeUndefined();
    });

    if (opts.reopen) {
      const reopen = opts.reopen;
      it("is durable: a fresh instance over the same store sees every record", async () => {
        const j = await make();
        expect(j.durable).toBe(true);
        const rec = variant(SAMPLE, 9);
        await j.put(rec);
        const again = await reopen();
        expect(toJson(await again.get(rec.planId))).toBe(toJson(rec));
        expect(
          (await again.unresolved(lockKey(rec.plan))).some((r) => r.planId === rec.planId),
        ).toBe(true);
      });
    }
  });
}
