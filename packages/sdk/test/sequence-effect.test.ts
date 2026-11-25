// SPDX-License-Identifier: MIT
// SequenceProgress.effect names what a save is for (one file edit), so a UI can say "readme.txt: Partially saved"
// and hold new saves per file. It is stored when runSequence starts; records from before it simply have none.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSequenceRecord,
  encodeSequenceRecord,
  lockKey,
  memoryJournal,
  openJournal,
} from "../src/actions/index.ts";
import type { SequenceRecord } from "../src/actions/journal.ts";
import { sequenceEffect } from "../src/actions/sequence.ts";
import type { EffectView } from "../src/actions/types.ts";
import { createEfs } from "../src/client.ts";
import type { Hex } from "../src/core/hex.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });
const FILE = `0x${"aa".repeat(32)}` as Hex;
const REV = `0x${"bb".repeat(32)}` as Hex;
const edit = (file: string, revision: string, stage: string): EffectView => ({
  code: "files.edit",
  args: { file, revision, stage },
});
const part = (...effects: EffectView[]) => ({ actions: [], bodies: [], effects });

describe("sequenceEffect", () => {
  it("names the one file edit a save carries, across its content and finish parts", () => {
    expect(
      sequenceEffect([part(edit(FILE, REV, "content")), part(edit(FILE, REV, "finish"))]),
    ).toEqual({
      kind: "files.edit",
      file: FILE,
      revision: REV,
    });
  });

  it("is undefined with no edit, a malformed one, or two different edits", () => {
    expect(sequenceEffect([part({ code: "files.put", args: { file: FILE } })])).toBeUndefined();
    expect(sequenceEffect([part(edit("readme.txt", REV, "finish"))])).toBeUndefined();
    expect(
      sequenceEffect([part(edit(FILE, REV, "finish")), part(edit(REV, FILE, "finish"))]),
    ).toBeUndefined();
  });
});

describe("SequenceProgress.effect", () => {
  const account = "0x2a871d0798f97d79848a013d4936a73bf4cc922c" as Hex;
  const d = efs.deployment;
  const record = (extra: Partial<SequenceRecord>): SequenceRecord => ({
    schema: "efs-sdk-sequence/1",
    sequenceId: `0x${"cc".repeat(32)}`,
    lock: lockKey({ chainId: d.chainId, realmId: d.realmId, ledger: d.ledger, account }),
    chainId: d.chainId,
    realmId: d.realmId,
    ledger: d.ledger,
    account,
    parts: [part(edit(FILE, REV, "finish"))],
    state: "NOT_STARTED",
    history: [],
    ...extra,
  });

  it("is listed from the record, and survives the journal codec", async () => {
    const journal = memoryJournal();
    const stored = record({ effect: { kind: "files.edit", file: FILE, revision: REV } });
    expect(decodeSequenceRecord(encodeSequenceRecord(stored)).effect).toEqual(stored.effect);
    await journal.putSequence(stored);
    expect(await openJournal(efs, { journal }).pendingSequences()).toMatchObject([
      { sequenceId: stored.sequenceId, effect: { kind: "files.edit", file: FILE, revision: REV } },
    ]);
  });

  it("is absent on a record written before it (the client keeps its account-wide hold for those)", async () => {
    const journal = memoryJournal();
    await journal.putSequence(record({}));
    const [p] = await openJournal(efs, { journal }).pendingSequences();
    expect(p).toBeDefined();
    expect(p && "effect" in p).toBe(false);
  });
});
