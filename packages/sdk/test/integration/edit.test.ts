// SPDX-License-Identifier: MIT
// planEditFile on a real chain: an edit is a files-child/1 revision plus a HEAD bind with a compare-and-swap on the
// editor's own binding. A moved base is BASE_CHANGED before anything is planned; a race the base check cannot see is
// refused by the ledger (E_CAS), never a silent overwrite. The seeded files are edited only by other accounts, so the
// default Lens (the fixture principal) keeps seeing them unchanged for every other test.
import { readFileSync } from "node:fs";
import { keccak256, sha256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import { EfsFault } from "../../src/core/errors.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile, readBytes } from "../../src/files/bytes.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { putInline } from "./recipes.ts";

type SeedFile = { name: string; subjectId: SubjectId; headRecordId: RecordId; length: number };
const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex }; files: SeedFile[] };
};
const seeded = (name: string): SeedFile =>
  deployment.seed.files.find((f) => f.name === name) as SeedFile;
const docs = deployment.seed.folder.directoryRecordId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
// anvil's well-known development accounts #6 and #9 (public test keys), used by no other test file
const carol = privateKeyToAccount(
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
);
const grace = privateKeyToAccount(
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const writerFor = (account: typeof carol) =>
  createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account },
    journal: memoryJournal(),
  });
const revisionOf = async (subject: SubjectId, lens = efs.lens.default) => {
  const o = await openFile(efs, { kind: "file", subject }, { lens });
  if (o.status !== "PRESENT") throw new Error(`file is ${o.status}`);
  return o.file;
};

describe("planEditFile (fixture)", () => {
  it("an inline edit of your own file: one part, guarded by your own HEAD, reads back", async () => {
    const w = await writerFor(carol);
    const lens = efs.lens.mineFirst(carol.address);
    const put = putInline(
      efs,
      w.principal,
      docs,
      "notes.txt",
      text("v1\n"),
      keccak256(toHex("edit-notes")),
    );
    const created = await w.planActions(put);
    if (created.status !== "PLANNED") throw new Error(created.status);
    expect((await w.run(created.plan)).reconcile?.outcome).toBe("COMMITTED");
    const v1 = await revisionOf(put.file, lens);
    const opened = await openFile(efs, { kind: "file", subject: put.file }, { lens });
    const openedAt = opened.basis?.admissions;
    expect(openedAt).toBeGreaterThan(0n);

    const r = await planEditFile(efs, w, {
      file: { kind: "file", subject: put.file },
      base: { kind: "revision", recordId: v1.revision },
      content: text("v2\n"),
      lens,
    });
    expect(r.status).toBe("PLANNED");
    if (r.status !== "PLANNED") return;
    expect(r.parts).toHaveLength(1);
    expect(r.review).toMatchObject({
      file: put.file,
      base: v1.revision,
      author: w.principal,
      size: 3n,
      sha256: sha256(text("v2\n")),
      layout: "inline",
      parts: 1,
      prompts: { sequential: 1, atomicBatch: 1 },
      records: 1,
      guard: "own-head",
      visibleInLens: true,
    });
    expect(r.review.expectedRevision).toBeGreaterThan(0n); // the create's HEAD bind
    expect(r.parts[0]?.effects).toEqual([
      expect.objectContaining({
        code: "files.edit",
        args: expect.objectContaining({ stage: "finish", part: "1", parts: "1", layout: "inline" }),
      }),
    ]);
    const done = await w.runSequence(r.parts);
    expect(done).toMatchObject({ state: "COMPLETE", committed: 1, total: 1 });
    const v2 = await revisionOf(put.file, lens);
    expect(v2.revision).toBe(r.review.revision); // the record id commits to parent = v1
    expect(v2.author).toBe(w.principal);
    expect(new TextDecoder().decode((await readBytes(efs, v2)).bytes)).toBe("v2\n");

    // The person was still looking at v1: planning from it again is BASE_CHANGED, naming the HEAD now.
    const again = await planEditFile(efs, w, {
      file: { kind: "file", subject: put.file },
      base: { kind: "revision", recordId: v1.revision },
      content: text("v3\n"),
      lens,
    });
    expect(again).toMatchObject({
      status: "BASE_CHANGED",
      head: { kind: "revision", recordId: r.review.revision, file: put.file },
      headAuthor: w.principal,
    });
    // The head was set after the edit began: someone (here, this account) saved while the person was editing.
    expect(again.status === "BASE_CHANGED" && again.headAdmission).toBeGreaterThan(
      openedAt as bigint,
    );
  });

  it("two edits planned from one base: the first lands, the ledger refuses the second (E_CAS)", async () => {
    const w = await writerFor(carol);
    const lens = efs.lens.mineFirst(carol.address);
    const put = putInline(
      efs,
      w.principal,
      docs,
      "race.txt",
      text("base\n"),
      keccak256(toHex("edit-race")),
    );
    const created = await w.planActions(put);
    if (created.status !== "PLANNED") throw new Error(created.status);
    await w.run(created.plan);
    const base = (await revisionOf(put.file, lens)).revision;
    const edit = (s: string) =>
      planEditFile(efs, w, {
        file: { kind: "file", subject: put.file },
        base: { kind: "revision", recordId: base },
        content: text(s),
        lens,
      });
    const [a, b] = await Promise.all([edit("tab A\n"), edit("tab B\n")]);
    if (a.status !== "PLANNED" || b.status !== "PLANNED") throw new Error("not planned");
    expect(a.review.expectedRevision).toBe(b.review.expectedRevision);
    expect((await w.runSequence(a.parts)).state).toBe("COMPLETE");
    const lost = await w.runSequence(b.parts);
    expect(lost).toMatchObject({ state: "NOT_STARTED", committed: 0, reason: { code: "STALE" } });
    // Structured, never parsed from text: the vendored name and the decoded E_CAS(bytes32,uint64,uint64) arguments.
    expect(lost.reason).toMatchObject({ retry: "after-replan", revert: { error: "E_CAS" } });
    expect(lost.reason?.revert?.selector).toMatch(/^0x[0-9a-f]{8}$/);
    expect(lost.reason?.revert?.args).toHaveLength(3);
    expect(lost.reason?.detail).toContain("E_CAS");
    const head = await revisionOf(put.file, lens);
    expect(head.revision).toBe(a.review.revision);
    expect(new TextDecoder().decode((await readBytes(efs, head)).bytes)).toBe("tab A\n");
    await w.abandon(lost.sequenceId); // the client re-plans with the new base instead
  });

  it("a span edit of another author's file splits under the gas cap and shows only where the author is in the Lens", async () => {
    const w = await writerFor(grace);
    const big = seeded("big.bin");
    const content = new Uint8Array(20_000).map((_, i) => (i * 7 + 3) & 0xff);
    const input = {
      file: { kind: "file" as const, subject: big.subjectId },
      base: { kind: "revision" as const, recordId: big.headRecordId },
      content,
    };
    const hidden = await planEditFile(efs, w, input); // the default Lens: the fixture principal only
    expect(hidden.status).toBe("PLANNED");
    if (hidden.status !== "PLANNED") return;
    expect(hidden.review).toMatchObject({
      layout: "span",
      guard: "lens",
      visibleInLens: false,
      expectedRevision: 0n,
    });

    const lens = efs.lens.mineFirst(grace.address);
    const r = await planEditFile(efs, w, { ...input, lens });
    if (r.status !== "PLANNED") throw new Error(r.status);
    // 3 chunks (two fill one publication's 16,384 body bytes) + 2 spans, then the finish: 2 parts
    expect(r.review).toMatchObject({
      layout: "span",
      parts: 2,
      records: 7,
      guard: "lens",
      visibleInLens: true,
    });
    expect(r.review.gas.perPart.every((g) => g < 16_777_216 / 1.15)).toBe(true);
    expect(r.parts.map((p) => p.effects[0]?.args["stage"])).toEqual(["content", "finish"]);
    const done = await w.runSequence(r.parts);
    expect(done).toMatchObject({ state: "COMPLETE", committed: 2, total: 2 });

    const mine = await revisionOf(big.subjectId, lens);
    expect(mine).toMatchObject({ revision: r.review.revision, layout: "span", size: 20_000n });
    const bytes = await readBytes(efs, mine);
    expect(bytes.grade).toBe("VERIFIED");
    expect(bytes.bytes).toEqual(content);
    // Everyone else's view is unchanged.
    expect((await revisionOf(big.subjectId)).revision).toBe(big.headRecordId);
  });

  it("an external edit names a locator and its digest; the revision points at a files-external/1 record", async () => {
    const w = await writerFor(grace);
    const readme = seeded("readme.txt");
    const lens = efs.lens.mineFirst(grace.address);
    const payload = text("moved to IPFS\n");
    const locator = "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
    const r = await planEditFile(efs, w, {
      file: { kind: "file", subject: readme.subjectId },
      base: { kind: "revision", recordId: readme.headRecordId },
      content: {
        kind: "external",
        length: BigInt(payload.length),
        sha256: sha256(payload),
        locator,
      },
      lens,
    });
    if (r.status !== "PLANNED") throw new Error(r.status);
    expect(r.review).toMatchObject({ layout: "external", parts: 1, size: BigInt(payload.length) });
    expect((await w.runSequence(r.parts)).state).toBe("COMPLETE");
    const head = await revisionOf(readme.subjectId, lens);
    expect(head).toMatchObject({ layout: "external", sha256: sha256(payload) });
    expect(head.locations[0]?.uri).toBe(locator);
    expect((await revisionOf(readme.subjectId)).revision).toBe(readme.headRecordId);
  });

  it("repeated chunks are published once, and the span tree over them reads back verified", async () => {
    const w = await writerFor(carol);
    const lens = efs.lens.mineFirst(carol.address);
    const put = putInline(
      efs,
      w.principal,
      docs,
      "zeros.bin",
      text("z"),
      keccak256(toHex("edit-zeros")),
    );
    const created = await w.planActions(put);
    if (created.status !== "PLANNED") throw new Error(created.status);
    await w.run(created.plan);
    const zeros = new Uint8Array(2 * 8_160); // two identical canonical chunks
    const r = await planEditFile(efs, w, {
      file: { kind: "file", subject: put.file },
      base: { kind: "revision", recordId: (await revisionOf(put.file, lens)).revision },
      content: zeros,
      lens,
    });
    if (r.status !== "PLANNED") throw new Error(r.status);
    expect(r.review).toMatchObject({ layout: "span", records: 4 }); // 1 chunk + 1 span + descriptor + revision
    expect((await w.runSequence(r.parts)).state).toBe("COMPLETE");
    const head = await revisionOf(put.file, lens);
    const bytes = await readBytes(efs, head);
    expect(bytes.grade).toBe("VERIFIED");
    expect(bytes.bytes).toEqual(zeros);
  });

  it("refuses what it cannot carry, reports a missing HEAD, and rejects a base of another file", async () => {
    const w = await writerFor(grace);
    const big = seeded("big.bin");
    const input = {
      file: { kind: "file" as const, subject: big.subjectId },
      base: { kind: "revision" as const, recordId: big.headRecordId },
    };
    const tooMany = await planEditFile(
      efs,
      w,
      { ...input, content: new Uint8Array(20_000) },
      { maxParts: 1 },
    );
    expect(tooMany).toMatchObject({ status: "TOO_LARGE", reason: { code: "LIMIT_EXCEEDED" } });
    expect(tooMany.status === "TOO_LARGE" && tooMany.reason.detail).toMatch(/need more than 1 /);
    const huge = await planEditFile(efs, w, { ...input, content: new Uint8Array(64 * 16_384 + 1) });
    expect(huge.status).toBe("TOO_LARGE");
    // Passes the byte pre-check (2 × 16,384), but chunk headers, spans and the finish need a third publication:
    // the exact check after splitting refuses it.
    const split = await planEditFile(
      efs,
      w,
      { ...input, content: new Uint8Array(2 * 16_384).map((_, i) => (i * 7 + 3) & 0xff) }, // no repeated chunk
      { maxParts: 2 },
    );
    expect(split.status === "TOO_LARGE" && split.reason.detail).toMatch(
      /publications; the limit is 2/,
    );
    await expect(
      planEditFile(efs, w, {
        ...input,
        content: {
          kind: "external",
          length: 1n << 256n,
          sha256: sha256(text("x")),
          locator: "ipfs://x",
        },
      }),
    ).rejects.toBeInstanceOf(EfsFault);

    const nowhere = keccak256(toHex("no such file")) as SubjectId;
    const missing = await planEditFile(efs, w, {
      file: { kind: "file", subject: nowhere },
      base: { kind: "revision", recordId: big.headRecordId },
      content: text("x"),
    });
    expect(missing).toMatchObject({ status: "BASE_CHANGED", head: null });

    await expect(
      planEditFile(efs, w, {
        ...input,
        base: { kind: "revision", recordId: big.headRecordId, file: nowhere },
        content: text("x"),
      }),
    ).rejects.toBeInstanceOf(EfsFault);
  });

  it("media types: declared (normalized), kept from the base, cleared with an empty string, and read back", async () => {
    // The seed declares its descriptors' media types; an inline revision has no descriptor, so it has none.
    expect((await revisionOf(seeded("big.bin").subjectId)).mediaType).toBe(
      "application/octet-stream",
    );
    expect((await revisionOf(seeded("remote.txt").subjectId)).mediaType).toBe(
      "text/plain; charset=utf-8",
    );
    expect("mediaType" in (await revisionOf(seeded("readme.txt").subjectId))).toBe(false);

    const w = await writerFor(carol);
    const lens = efs.lens.mineFirst(carol.address);
    const put = putInline(
      efs,
      w.principal,
      docs,
      "logo.svg",
      text("<svg/>"),
      keccak256(toHex("edit-media")),
    );
    const created = await w.planActions(put);
    if (created.status !== "PLANNED") throw new Error(created.status);
    await w.run(created.plan);
    const file = { kind: "file" as const, subject: put.file };
    const save = async (
      base: RecordId,
      content: Parameters<typeof planEditFile>[2]["content"],
      mediaType?: string,
    ) => {
      const r = await planEditFile(efs, w, {
        file,
        base: { kind: "revision", recordId: base },
        content,
        lens,
        ...(mediaType !== undefined ? { mediaType } : {}),
      });
      if (r.status !== "PLANNED") throw new Error(r.status);
      expect((await w.runSequence(r.parts)).state).toBe("COMPLETE");
      const head = await revisionOf(put.file, lens);
      expect(head.revision).toBe(r.review.revision);
      return { review: r.review, effect: r.parts.at(-1)?.effects[0], head };
    };

    // Declared: the type and subtype are lowercased. Small enough to sit inline, but only a descriptor carries a media
    // type, so it is stored as one chunk under a files-content/1 descriptor.
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const typed = await save((await revisionOf(put.file, lens)).revision, svg, "Image/SVG+XML");
    expect(typed.review).toMatchObject({ layout: "chunk", mediaType: "image/svg+xml", records: 3 });
    expect(typed.effect?.args).toMatchObject({ layout: "chunk", mediaType: "image/svg+xml" });
    expect(typed.head).toMatchObject({ layout: "chunk", mediaType: "image/svg+xml" });
    expect((await readBytes(efs, typed.head)).bytes).toEqual(svg);

    // Omitted: the base revision's type is kept (read at the planning block), so the file stays a chunk.
    const kept = await save(typed.head.revision, text("<svg/>\n"));
    expect(kept.review).toMatchObject({ layout: "chunk", mediaType: "image/svg+xml" });
    expect(kept.head.mediaType).toBe("image/svg+xml");

    // "": no media type, and the small file goes back inline.
    const cleared = await save(kept.head.revision, text("plain"), "");
    expect(cleared.review).toMatchObject({ layout: "inline", mediaType: "" });
    expect(cleared.effect?.args && "mediaType" in cleared.effect.args).toBe(false);
    expect(cleared.head.layout).toBe("inline");
    expect("mediaType" in cleared.head).toBe(false);

    // External: the type is the rest of the files-external/1 body, after the locator; parameters keep their case.
    const payload = text("elsewhere\n");
    const ext = await save(
      cleared.head.revision,
      {
        kind: "external",
        length: BigInt(payload.length),
        sha256: sha256(payload),
        locator: "ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      },
      "TEXT/Plain; Charset=UTF-8",
    );
    expect(ext.review).toMatchObject({
      layout: "external",
      mediaType: "text/plain; Charset=UTF-8",
    });
    expect(ext.head).toMatchObject({ layout: "external", mediaType: "text/plain; Charset=UTF-8" });
  });
});
