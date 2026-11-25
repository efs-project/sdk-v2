// SPDX-License-Identifier: MIT
// A throw out of runSequence or resume is never "nothing was saved" by itself: every one is an EfsFault whose
// `sequence` says whether this call may have broadcast and whether any part of the save may be on chain. These cases
// fail before any chain read; the broadcast-then-fail and abort-after-broadcast cases are in integration/sequences.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createWriter, type Journal, lockKey, memoryJournal } from "../src/actions/index.ts";
import type { SequenceRecord } from "../src/actions/journal.ts";
import { createEfs } from "../src/client.ts";
import { EfsFault } from "../src/core/errors.ts";
import type { Hex } from "../src/core/hex.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });
// anvil #9: a public development key; nothing here reaches a chain.
const account = privateKeyToAccount(
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
);
const part = { actions: [], bodies: [], effects: [] };
const unavailable = () => new EfsFault("JOURNAL_UNAVAILABLE", "the journal went away");

/** A memory journal with chosen methods replaced. */
const journalWith = (over: Partial<Journal>): Journal => {
  const j = memoryJournal();
  return {
    durable: j.durable,
    put: over.put ?? j.put,
    get: over.get ?? j.get,
    unresolved: over.unresolved ?? j.unresolved,
    putSequence: over.putSequence ?? j.putSequence,
    getSequence: over.getSequence ?? j.getSequence,
    openSequences: over.openSequences ?? j.openSequences,
    withLock: over.withLock ?? j.withLock,
  };
};

const writerWith = (journal: Journal) =>
  createWriter(efs, { authorizer: { kind: "local", profile: "direct", account }, journal });

/** The sequence fields of a fault, as one object (sequenceId left out when absent). */
const where = (f: EfsFault) => ({
  ...(f.sequenceId !== undefined ? { sequenceId: f.sequenceId } : {}),
  mayHaveSent: f.mayHaveSent,
  sequenceMayHaveSent: f.sequenceMayHaveSent,
});

const caught = async (p: Promise<unknown>): Promise<EfsFault> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EfsFault) return e;
    throw new Error(`not an EfsFault: ${String(e)}`);
  }
  throw new Error("did not throw");
};

describe("faults out of runSequence and resume", () => {
  it("a journal that fails before the record exists: nothing sent, no sequenceId", async () => {
    const w = await writerWith(
      journalWith({ putSequence: async () => Promise.reject(unavailable()) }),
    );
    const f = await caught(w.runSequence([part]));
    expect(f.code).toBe("JOURNAL_UNAVAILABLE");
    expect(where(f)).toEqual({ mayHaveSent: false, sequenceMayHaveSent: false });
    expect(f.cause).toBeInstanceOf(EfsFault);
  });

  it("a non-EfsFault is wrapped as INVARIANT and keeps the original as its cause", async () => {
    const boom = new TypeError("journal bug");
    const w = await writerWith(journalWith({ putSequence: async () => Promise.reject(boom) }));
    const f = await caught(w.runSequence([part]));
    expect(f.code).toBe("INVARIANT");
    expect(f.message).toContain("journal bug");
    expect(f.cause).toBe(boom);
    expect(where(f)).toEqual({ mayHaveSent: false, sequenceMayHaveSent: false });
  });

  it("bad input before any record: MISUSE for no parts, INVARIANT (with the cause) for an unserializable part", async () => {
    const w = await writerWith(memoryJournal());
    const empty = await caught(w.runSequence([]));
    expect(empty.code).toBe("MISUSE");
    expect(where(empty)).toEqual({ mayHaveSent: false, sequenceMayHaveSent: false });
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    const bad = await caught(w.runSequence([{ ...part, effects: [loop as never] }]));
    expect(bad.code).toBe("INVARIANT");
    expect(bad.cause).toBeInstanceOf(Error);
    expect(where(bad)).toEqual({ mayHaveSent: false, sequenceMayHaveSent: false });
  });

  it("resume when the record cannot be read: it may have been sent (never 'nothing saved')", async () => {
    const id = `0x${"11".repeat(32)}` as Hex;
    const w = await writerWith(
      journalWith({ getSequence: async () => Promise.reject(unavailable()) }),
    );
    const f = await caught(w.resume(id));
    expect(f.code).toBe("JOURNAL_UNAVAILABLE");
    expect(where(f)).toEqual({ sequenceId: id, mayHaveSent: false, sequenceMayHaveSent: true });
  });

  it("resume of a save that is not in the journal: MISUSE, nothing of it on chain", async () => {
    const id = `0x${"22".repeat(32)}` as Hex;
    const f = await caught((await writerWith(memoryJournal())).resume(id));
    expect(f.code).toBe("MISUSE");
    expect(where(f)).toEqual({ sequenceId: id, mayHaveSent: false, sequenceMayHaveSent: false });
  });

  it("resume of a save with a committed part, failing before it sends: this call sent nothing, the save did", async () => {
    let broken = false;
    const journal = journalWith({});
    const failing: Journal = {
      ...journal,
      get: async (id) => (broken ? Promise.reject(unavailable()) : journal.get(id)),
    };
    const w = await writerWith(failing);
    const d = efs.deployment;
    const record: SequenceRecord = {
      schema: "efs-sdk-sequence/1",
      sequenceId: `0x${"33".repeat(32)}`,
      lock: lockKey({
        chainId: d.chainId,
        realmId: d.realmId,
        ledger: d.ledger,
        account: account.address.toLowerCase() as Hex,
      }),
      chainId: d.chainId,
      realmId: d.realmId,
      ledger: d.ledger,
      account: account.address.toLowerCase() as Hex,
      parts: [
        { ...part, planId: `0x${"44".repeat(32)}`, committed: true, final: true },
        { ...part, planId: `0x${"55".repeat(32)}` },
      ],
      state: "IN_FLIGHT",
      history: [],
    };
    await failing.putSequence(record);
    // Another account's writer cannot resume it, and must not read the refusal as "nothing of it on chain".
    const other = await createWriter(efs, {
      authorizer: {
        kind: "local",
        profile: "direct",
        // anvil #8: another public development key
        account: privateKeyToAccount(
          "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
        ),
      },
      journal: failing,
    });
    const refused = await caught(other.resume(record.sequenceId));
    expect(refused.code).toBe("MISUSE");
    expect(refused.message).toMatch(/another account/);
    expect(where(refused)).toEqual({
      sequenceId: record.sequenceId,
      mayHaveSent: false,
      sequenceMayHaveSent: true,
    });
    broken = true;
    const f = await caught(w.resume(record.sequenceId));
    expect(f.code).toBe("JOURNAL_UNAVAILABLE");
    expect(where(f)).toEqual({
      sequenceId: record.sequenceId,
      mayHaveSent: false,
      sequenceMayHaveSent: true,
    });
  });
});
