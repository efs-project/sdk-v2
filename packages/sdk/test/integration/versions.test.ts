// SPDX-License-Identifier: MIT
// fileVersions on the fixture (tag model spec §3.9; contracts 04526b1 item 49, the head-authors list). One file, made
// by C, then in this order: A and B each save a version of their own; D says "not this" only (a lone no: an entry,
// never a version); E saves a version and takes it back (RELEASED); F saves one and hides it (MASKED). So the list holds
// C, A, B, D, E, F (first statements), `live` is 3 (C, A, B) and `count` 6. Checked: the Lens decision (a version, or
// "hidden by" a Lens author's lone no), the Lens tier, the creator's row apart, the public tier newest first with the
// Lens and the creator skipped, includeRemoved, paging by list position with short and empty pages that carry on, the
// early stop, a moved list (`changed`), and a list the index does not vouch for (the public tier UNKNOWN, the Lens tier
// and the decision exact). Accounts 36 to 42 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, PrincipalId, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { planCreateFile } from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { type FileVersionsCursor, fileVersions } from "../../src/files/versions.ts";
import { indexAbi, ledgerViewsAbi, lensReaderAbi } from "../../src/generated/abis.ts";
import { planHeadNo, planHeadRelease } from "../../src/testing/index.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const MNEMONIC = "test test test test test test test test test test test junk";
const account = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const C = account(36);
const A = account(37);
const B = account(38);
const D = account(39);
const E = account(40);
const F = account(41);
const G = account(42);
type Writer = Awaited<ReturnType<typeof createWriter>>;
const writers = new Map<string, Writer>();
const writerOf = async (who: typeof C): Promise<Writer> => {
  const known = writers.get(who.address);
  if (known) return known;
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [who.address, "0x56bc75e2d63100000"],
    }),
  });
  const w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: who },
    journal: memoryJournal(),
  });
  writers.set(who.address, w);
  return w;
};
const p = (who: typeof C) => efs.lens.principalOf(who.address).toLowerCase() as PrincipalId;
const lensOf = (...who: (typeof C)[]) => efs.lens.from(who.map((x) => x.address));
let file: SubjectId;
const revisions = new Map<string, RecordId>();

const rewriting = (
  abi: readonly unknown[],
  functionName: string,
  edit: (r: unknown[]) => unknown[],
) => lyingEfs(fixture.rpcUrl, deployment, abi, functionName, edit);

/**
 * A HEAD statement the SDK's planners never make, by the testing helpers (planHeadNo: a "not this", planHeadRelease: a
 * take-back), checking what each says it made of the head.
 */
const headStatement = async (
  who: typeof C,
  kind: "no" | "release",
  want: { before: string; statement: string },
) => {
  const w = await writerOf(who);
  const p = await (kind === "no" ? planHeadNo : planHeadRelease)(efs, w, {
    file: { kind: "file", subject: file },
  });
  if (p.status !== "PLANNED") throw new Error(p.status);
  expect(p.review).toMatchObject({ kind: "efs.headStatementReview", ...want, parts: 1 });
  expect((await w.runSequence(p.parts)).state).toBe("COMPLETE");
};
/** `who` saves a version of their own, edited from C's. */
const saveVersion = async (who: typeof C, text: string) => {
  const w = await writerOf(who);
  const base = await openFile(efs, { kind: "file", subject: file }, { lens: lensOf(C) });
  if (base.status !== "PRESENT") throw new Error(base.status);
  const r = await planEditFile(efs, w, {
    file: { kind: "file", subject: file },
    base: { kind: "revision", recordId: base.file.revision },
    content: new TextEncoder().encode(text),
    lens: lensOf(C),
  });
  if (r.status !== "PLANNED") throw new Error(r.status);
  expect((await w.runSequence(r.parts)).state).toBe("COMPLETE");
  const mine = await openFile(efs, { kind: "file", subject: file }, { lens: lensOf(who) });
  if (mine.status !== "PRESENT") throw new Error(mine.status);
  revisions.set(who.address, mine.file.revision);
};
const rev = (who: typeof C) => revisions.get(who.address) as RecordId;
const present = (who: typeof C, creator = false) => ({
  author: p(who),
  state: "PRESENT",
  revision: rev(who),
  creator,
});

beforeAll(async () => {
  const wc = await writerOf(C);
  const made = await planCreateFile(efs, wc, {
    folder: root,
    name: "versions-test.txt",
    content: new TextEncoder().encode("C's version\n"),
  });
  if (made.status !== "PLANNED") throw new Error(made.status);
  expect((await wc.runSequence(made.parts)).state).toBe("COMPLETE");
  file = made.review.file.subject;
  revisions.set(C.address, made.review.revision);
  await saveVersion(A, "A's version\n");
  await saveVersion(B, "B's version\n");
  await headStatement(D, "no", { before: "UNSET", statement: "lone-no" }); // a lone "not this"
  await saveVersion(E, "E's version\n");
  await headStatement(E, "release", { before: "BOUND", statement: "release" }); // taken back
  await saveVersion(F, "F's version\n");
  await headStatement(F, "no", { before: "BOUND", statement: "hide" }); // hidden
}, 240_000);

describe("fileVersions (fixture)", () => {
  it("under the creator's Lens: C decides; the public tier is B then A, newest first; 3 versions, 6 authors", async () => {
    const v = await fileVersions(efs, { kind: "file", subject: file }, { lens: lensOf(C) });
    if (v.status !== "PRESENT") throw new Error(v.status);
    expect(v.decision).toEqual({ kind: "version", author: p(C), revision: rev(C), lensIndex: 0 });
    expect(v.lens).toEqual([{ ...present(C, true), lensIndex: 0 }]);
    expect(v.creator).toBeUndefined(); // in the Lens
    expect(v.public).toEqual({
      status: "PRESENT",
      rows: [present(B), present(A)], // D (a lone no), E (released) and F (hidden) are no versions
      total: 2,
      live: 3,
      count: 6,
      scanned: 6,
      changed: false,
    });
  });

  it("includeRemoved adds the hidden and the taken-back versions, without a revision; never the lone no", async () => {
    const v = await fileVersions(
      efs,
      { kind: "file", subject: file },
      { lens: lensOf(C), includeRemoved: true },
    );
    if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
    expect(v.public.rows).toEqual([
      { author: p(F), state: "MASKED", creator: false },
      { author: p(E), state: "RELEASED", creator: false },
      present(B),
      present(A),
    ]);
    expect(v.public.total).toBe(2);
  });

  it("under another author's Lens: their version decides, the creator's row is apart, the public tier skips both", async () => {
    const v = await fileVersions(efs, { kind: "file", subject: file }, { lens: lensOf(A) });
    if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
    expect(v.decision).toEqual({ kind: "version", author: p(A), revision: rev(A), lensIndex: 0 });
    expect(v.lens).toEqual([{ ...present(A), lensIndex: 0 }]);
    expect(v.creator).toEqual(present(C, true));
    expect(v.public.rows).toEqual([present(B)]);
    expect(v.public.total).toBe(1); // 3 standing, less A (the Lens) and C (shown apart)
  });

  it("a Lens author's lone no hides the file for that Lens (decision hidden by D); D is never a version", async () => {
    const v = await fileVersions(efs, { kind: "file", subject: file }, { lens: lensOf(D, C) });
    if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
    expect(v.decision).toEqual({ kind: "hidden", author: p(D), lensIndex: 0 });
    expect(v.lens).toEqual([{ ...present(C, true), lensIndex: 1 }]);
    expect(v.public.rows).toEqual([present(B), present(A)]);
    // a Lens author who took their version back falls through: E, then C decides
    const e = await fileVersions(efs, { kind: "file", subject: file }, { lens: lensOf(E, C) });
    expect(e.status === "PRESENT" && e.decision).toEqual({
      kind: "version",
      author: p(C),
      revision: rev(C),
      lensIndex: 1,
    });
  });

  it("pages by list position, newest first: empty pages carry on, and the last version found ends it", async () => {
    const seen: { rows: string[]; next: boolean; scanned: number }[] = [];
    let cursor: FileVersionsCursor | undefined;
    for (let i = 0; i < 8; i++) {
      const v = await fileVersions(
        efs,
        { kind: "file", subject: file },
        { lens: lensOf(C), limit: 1, ...(cursor ? { cursor } : {}) },
      );
      if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
      seen.push({
        rows: v.public.rows.map((r) => r.author),
        next: v.public.next !== undefined,
        scanned: v.public.scanned,
      });
      cursor = v.public.next;
      if (!cursor) break;
    }
    // entries 5 (F), 4 (E), 3 (D) give nothing but carry on; 2 is B; 1 is A, the last standing one: no next (C, at
    // entry 0, is in the Lens and never scanned)
    expect(seen).toEqual([
      { rows: [], next: true, scanned: 1 },
      { rows: [], next: true, scanned: 1 },
      { rows: [], next: true, scanned: 1 },
      { rows: [p(B)], next: true, scanned: 1 },
      { rows: [p(A)], next: false, scanned: 1 },
    ]);
  });

  it("a list that moved between pages is `changed` and scans on, past the early stop", async () => {
    const first = await fileVersions(
      efs,
      { kind: "file", subject: file },
      { lens: lensOf(C), limit: 4 },
    );
    if (first.status !== "PRESENT" || first.public.status !== "PRESENT")
      throw new Error(first.status);
    expect(first.public.rows).toEqual([present(B)]); // entries 5..2
    const cursor = first.public.next as FileVersionsCursor;
    expect(cursor).toBeDefined();
    await saveVersion(G, "G's version\n"); // entry 6: live 4, count 7
    const later = await fileVersions(
      efs,
      { kind: "file", subject: file },
      { lens: lensOf(C), limit: 4, cursor },
    );
    if (later.status !== "PRESENT" || later.public.status !== "PRESENT")
      throw new Error(later.status);
    expect(later.public).toMatchObject({ changed: true, live: 4, count: 7, total: 3 });
    expect(later.public.rows).toEqual([present(A)]); // the page carries on from entry 1; G is newer than the cursor
    expect(later.public.next).toBeUndefined(); // the list's start
    // a fresh read sees G first
    const fresh = await fileVersions(efs, { kind: "file", subject: file }, { lens: lensOf(C) });
    expect(
      fresh.status === "PRESENT" && fresh.public.status === "PRESENT" && fresh.public.rows,
    ).toEqual([present(G), present(B), present(A)]);
  });

  it("the early stop trusts a cursor's count only while the list is unmoved", async () => {
    const first = await fileVersions(
      efs,
      { kind: "file", subject: file },
      { lens: lensOf(C), limit: 1 },
    );
    if (first.status !== "PRESENT" || first.public.status !== "PRESENT")
      throw new Error(first.status);
    const next = first.public.next as FileVersionsCursor; // after entry 6 (G)
    expect(next).toBeDefined();
    const page = async (cursor: FileVersionsCursor) => {
      const v = await fileVersions(
        efs,
        { kind: "file", subject: file },
        { lens: lensOf(C), limit: 1, cursor },
      );
      if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
      return v.public;
    };
    // a cursor that already counts every standing version: the scan ends, entries remaining or not
    const stop = await page({ ...next, found: 99 });
    expect([stop.changed, stop.next]).toEqual([false, undefined]);
    // the same count from a list that has moved since (here a different `live`): the scan carries on
    const moved = await page({ ...next, found: 99, live: next.live - 1 });
    expect(moved.changed).toBe(true);
    expect(moved.next).toMatchObject({ before: 5 });
  });

  it("with includeRemoved the pages run to the list's start: removed versions can lie past the last standing one", async () => {
    const rows: string[] = [];
    let pages = 0;
    let cursor: FileVersionsCursor | undefined;
    do {
      const v = await fileVersions(
        efs,
        { kind: "file", subject: file },
        { lens: lensOf(C), limit: 1, includeRemoved: true, ...(cursor ? { cursor } : {}) },
      );
      if (v.status !== "PRESENT" || v.public.status !== "PRESENT") throw new Error(v.status);
      rows.push(...v.public.rows.map((r) => `${r.author}:${r.state}`));
      cursor = v.public.next;
      pages++;
    } while (cursor && pages < 10);
    // every entry, 6 down to 0 (C, in the Lens, is skipped there): no early stop at A, the last standing one
    expect(pages).toBe(7);
    expect(rows).toEqual([
      `${p(G)}:PRESENT`,
      `${p(F)}:MASKED`,
      `${p(E)}:RELEASED`,
      `${p(B)}:PRESENT`,
      `${p(A)}:PRESENT`,
    ]);
  });

  it("a list the index does not vouch for: the public tier and its counts UNKNOWN, the Lens tier and decision exact", async () => {
    // The same endpoint, with every postingHeadOf reply's coverage rewritten to PARTIAL (1).
    const lying = rewriting(indexAbi, "postingHeadOf", ([, ...rest]) => [1, ...rest]);
    const v = await fileVersions(lying, { kind: "file", subject: file }, { lens: lensOf(A) });
    if (v.status !== "PRESENT") throw new Error(v.status);
    expect(v.decision).toEqual({ kind: "version", author: p(A), revision: rev(A), lensIndex: 0 });
    expect(v.lens).toEqual([{ ...present(A), lensIndex: 0 }]);
    expect(v.creator).toEqual(present(C, true));
    expect(v.public).toMatchObject({ status: "UNKNOWN", reason: { code: "NOT_YET_DECIDABLE" } });
    expect("rows" in v.public || "count" in v.public || "live" in v.public).toBe(false);
  });

  it("an endpoint whose Lens walk names a decider outside the Lens is not believed: the read fails over (UNKNOWN here)", async () => {
    const stranger = `0x${"0".repeat(24)}${"ee".repeat(20)}` as Hex;
    const lying = rewriting(lensReaderAbi, "resolve", ([q, sel]) => [
      q,
      { ...(sel as object), principalId: stranger },
    ]);
    const v = await fileVersions(lying, { kind: "file", subject: file }, { lens: lensOf(C) });
    expect(v).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("a MASKED walk whose selection is not MASKED names no one: the endpoint's fault, never hidden", async () => {
    const lying = rewriting(lensReaderAbi, "resolve", ([q, sel]) => [
      { ...(q as object), status: 4 }, // MASKED, while the selection still says PRESENT
      sel,
    ]);
    const v = await fileVersions(lying, { kind: "file", subject: file }, { lens: lensOf(C) });
    expect(v).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("a headsAt reply with a status no headsAt read accepts is the endpoint's fault (UNKNOWN here)", async () => {
    const lying = rewriting(ledgerViewsAbi, "headsAt", ([, ...rest]) => [9, ...rest]); // INVALID
    const v = await fileVersions(lying, { kind: "file", subject: file }, { lens: lensOf(C) });
    expect(v).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
  });

  it("the HEAD helpers say what they make, and refuse a take-back with nothing to take back", async () => {
    const d = await planHeadNo(efs, await writerOf(D), { file: { kind: "file", subject: file } });
    expect(d.status === "PLANNED" && d.review).toMatchObject({
      before: "MASKED",
      statement: "no-again",
    });
    await expect(
      planHeadRelease(efs, await writerOf(E), { file: { kind: "file", subject: file } }),
    ).rejects.toMatchObject({ code: "MISUSE" }); // E's HEAD is RELEASED already
    await expect(
      planHeadNo(efs, await writerOf(D), {
        file: { kind: "file", subject: `0x${"5e".repeat(32)}` as SubjectId },
      }),
    ).rejects.toMatchObject({ code: "MISUSE" }); // never created
  });

  it("a subject never created is ABSENT_PROVEN", async () => {
    const v = await fileVersions(efs, {
      kind: "file",
      subject: `0x${"5e".repeat(32)}` as SubjectId,
    });
    expect(v.status).toBe("ABSENT_PROVEN");
  });
});
