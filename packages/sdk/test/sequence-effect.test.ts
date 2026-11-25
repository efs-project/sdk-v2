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

  it("hides and unhides list each entry once; a hide names the author it covers when the planner knew it", () => {
    const AUTHOR = `0x${"0".repeat(24)}${"ee".repeat(20)}`;
    const u = (name: string, st: string) => fx("files.unhide", { folder: DIR, name, ...stage(st) });
    expect(sequenceEffect([part(u("a", "finish"), u("b", "finish"))])).toEqual({
      kind: "files.unhide",
      entries: [
        { folder: DIR, name: "a" },
        { folder: DIR, name: "b" },
      ],
    });
    const h = (name: string, extra: Record<string, string>) =>
      fx("files.hide", { folder: DIR, name, ...extra, ...stage("finish") });
    expect(sequenceEffect([part(h("spam", { author: AUTHOR })), part(h("lone", {}))])).toEqual({
      kind: "files.hide",
      entries: [
        { folder: DIR, name: "spam", author: AUTHOR },
        { folder: DIR, name: "lone" },
      ],
    });
    // A malformed author is a malformed effect, not an entry without one.
    expect(sequenceEffect([part(h("spam", { author: "bob" }))])).toBeUndefined();
    expect(
      sequenceEffect([part(fx("files.unhide", { folder: "docs", name: "a" }))]),
    ).toBeUndefined();
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

describe("sequenceEffect for tag saves", () => {
  const TOPIC = `0x${"71".repeat(32)}`;
  const OTHER = `0x${"72".repeat(32)}`;
  const A = `0x${"a1".repeat(32)}`;
  const B = `0x${"b2".repeat(32)}`;
  const fx = (code: string, args: Record<string, string>): EffectView => ({ code, args });
  const reg = fx("tags.register", { topic: TOPIC, part: "1", parts: "2", stage: "register" });
  const tag = (code: string, thing: string, number?: string) =>
    fx(code, {
      topic: TOPIC,
      thing,
      ...(number !== undefined ? { number } : {}),
      part: "2",
      parts: "2",
      stage: "finish",
    });

  it("a tag, a denial or an untag names its topic, its number and its targets; registration parts fold in", () => {
    expect(
      sequenceEffect([part(reg), part(tag("tags.tag", A, "3"), tag("tags.tag", B, "3"))]),
    ).toEqual({
      kind: "tags.tag",
      topic: TOPIC,
      number: 3,
      targets: [A, B],
    });
    expect(sequenceEffect([part(tag("tags.deny", A, "-1"))])).toEqual({
      kind: "tags.deny",
      topic: TOPIC,
      number: -1,
      targets: [A],
    });
    expect(sequenceEffect([part(tag("tags.untag", A), tag("tags.untag", A))])).toEqual({
      kind: "tags.untag",
      topic: TOPIC,
      targets: [A],
    });
    // Only registration (an abandoned save's first parts): the topics it registers.
    expect(sequenceEffect([part(reg)])).toEqual({ kind: "tags.register", topics: [TOPIC] });
  });

  it("labels, same as and broader name their subject and the rest", () => {
    const fin = { part: "1", parts: "1", stage: "finish" };
    expect(
      sequenceEffect([
        part(reg),
        part(fx("tags.label", { subject: TOPIC, lang: "en", remove: "false", ...fin })),
      ]),
    ).toEqual({ kind: "tags.label", subject: TOPIC, lang: "en", remove: false });
    expect(
      sequenceEffect([
        part(fx("tags.same", { subject: TOPIC, other: OTHER, remove: "true", ...fin })),
      ]),
    ).toEqual({
      kind: "tags.same",
      subject: TOPIC,
      other: OTHER,
      remove: true,
    });
    expect(
      sequenceEffect([
        part(fx("tags.broader", { subject: TOPIC, other: OTHER, remove: "false", ...fin })),
      ]),
    ).toEqual({ kind: "tags.broader", subject: TOPIC, other: OTHER, remove: false });
  });

  it("is undefined for a malformed tag effect, two numbers, two topics, or tags mixed with files", () => {
    expect(sequenceEffect([part(tag("tags.tag", A, "one"))])).toBeUndefined();
    expect(
      sequenceEffect([part(tag("tags.tag", A, "1"), tag("tags.tag", B, "2"))]),
    ).toBeUndefined();
    expect(
      sequenceEffect([
        part(tag("tags.tag", A, "1"), fx("tags.tag", { topic: OTHER, thing: B, number: "1" })),
      ]),
    ).toBeUndefined();
    expect(sequenceEffect([part(tag("tags.tag", "cat.jpg", "1"))])).toBeUndefined();
    expect(
      sequenceEffect([
        part(tag("tags.tag", A, "1"), fx("files.hide", { folder: TOPIC, name: "a" })),
      ]),
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

  it("hide and unhide effects survive the journal codec and are listed from the record", async () => {
    const DIR = `0x${"dd".repeat(32)}` as Hex;
    const AUTHOR = `0x${"0".repeat(24)}${"ee".repeat(20)}` as Hex;
    const journal = memoryJournal();
    const effects = [
      { kind: "files.unhide", entries: [{ folder: DIR, name: "a" }] },
      {
        kind: "files.hide",
        entries: [
          { folder: DIR, name: "b", author: AUTHOR },
          { folder: DIR, name: "c" },
        ],
      },
    ] as const;
    for (const [i, effect] of effects.entries()) {
      const stored = record({ sequenceId: `0x${String(i + 1).repeat(64)}` as Hex, effect });
      expect(decodeSequenceRecord(encodeSequenceRecord(stored)).effect).toEqual(effect);
      await journal.putSequence(stored);
    }
    const pending = await openJournal(efs, { journal }).pendingSequences();
    expect(
      pending.map((p) => p.effect).sort((a, b) => (a?.kind ?? "").localeCompare(b?.kind ?? "")),
    ).toEqual([effects[1], effects[0]]);
  });

  it("tag effects survive the journal codec and are listed from the record", async () => {
    const journal = memoryJournal();
    const effect = {
      kind: "tags.tag",
      topic: `0x${"71".repeat(32)}`,
      number: 2,
      targets: [`0x${"a1".repeat(32)}`],
    } as const;
    const stored = record({ sequenceId: `0x${"9".repeat(64)}` as Hex, effect });
    expect(decodeSequenceRecord(encodeSequenceRecord(stored)).effect).toEqual(effect);
    await journal.putSequence(stored);
    expect((await openJournal(efs, { journal }).pendingSequences())[0]?.effect).toEqual(effect);
  });

  it("is absent on a record written before it (the client keeps its account-wide hold for those)", async () => {
    const journal = memoryJournal();
    await journal.putSequence(record({}));
    const [p] = await openJournal(efs, { journal }).pendingSequences();
    expect(p).toBeDefined();
    expect(p && "effect" in p).toBe(false);
  });
});
