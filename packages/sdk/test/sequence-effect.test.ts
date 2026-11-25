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

describe("sequenceEffect for folder saves", () => {
  const DIR = `0x${"dd".repeat(32)}`;
  const fx = (code: string, args: Record<string, string>): EffectView => ({ code, args });
  const stage = (st: string) => ({ part: "1", parts: "2", stage: st });

  it("a created file: one effect, the same across its content and finish parts", () => {
    const args = { folder: DIR, name: "a.txt", file: FILE, revision: REV };
    expect(
      sequenceEffect([
        part(fx("files.create", { ...args, ...stage("content") })),
        part(fx("files.create", { ...args, ...stage("finish") })),
      ]),
    ).toEqual({ kind: "files.create", folder: DIR, name: "a.txt", file: FILE, revision: REV });
  });

  it("moves, removes and restores list each entry once, across parts", () => {
    const m = (name: string) =>
      fx("files.move", {
        folder: DIR,
        name,
        toFolder: DIR,
        toName: `new-${name}`,
        target: FILE,
        ...stage("finish"),
      });
    expect(sequenceEffect([part(m("a"), m("b")), part(m("c"))])).toEqual({
      kind: "files.move",
      moves: ["a", "b", "c"].map((name) => ({
        folder: DIR,
        name,
        toFolder: DIR,
        toName: `new-${name}`,
        target: FILE,
      })),
    });
    const r = (name: string, hide: string) =>
      fx("files.remove", { folder: DIR, name, target: FILE, hide });
    expect(sequenceEffect([part(r("a", "false"), r("b", "false"))])).toEqual({
      kind: "files.remove",
      hide: false,
      entries: [
        { folder: DIR, name: "a", target: FILE },
        { folder: DIR, name: "b", target: FILE },
      ],
    });
    expect(sequenceEffect([part(r("a", "false"), r("b", "true"))])).toBeUndefined(); // one save, one hide
  });

  it("is undefined for mixed kinds or a malformed folder effect", () => {
    expect(
      sequenceEffect([
        part(
          edit(FILE, REV, "finish"),
          fx("files.remove", { folder: DIR, name: "a", target: FILE, hide: "false" }),
        ),
      ]),
    ).toBeUndefined();
    expect(
      sequenceEffect([part(fx("files.restore", { folder: "docs", name: "a", target: FILE }))]),
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
