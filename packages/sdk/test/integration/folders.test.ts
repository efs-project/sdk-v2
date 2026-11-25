// SPDX-License-Identifier: MIT
// Folder reads on a real chain: listing pages (coverage, the kind filter and its counts, cursors), one name's lookup
// with every candidate, and path resolution from a parent the caller names. The Realm's shared root is only a
// stand-in parent here; no link format names it.
import { readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";
import { createEfs } from "../../src/client.ts";
import { EfsFault } from "../../src/core/errors.ts";
import type { Hex, PrincipalId, RecordId, SubjectId } from "../../src/core/hex.ts";
import {
  type FolderRef,
  folderOf,
  listFolder,
  lookupEntry,
  resolvePath,
} from "../../src/files/folders.ts";

type SeedFile = { name: string; subjectId: SubjectId; headRecordId: RecordId };
const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId; principalId: PrincipalId };
  seed: {
    folder: { name: string; directoryRecordId: RecordId; subjectId: SubjectId };
    files: SeedFile[];
  };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const docs: FolderRef = {
  kind: "folder",
  directory: deployment.seed.folder.directoryRecordId,
  subject: deployment.seed.folder.subjectId,
};
const t = (deployment as unknown as { typeIds: Record<string, Hex> }).typeIds;
const seeder = deployment.root.principalId;
const seeded = (name: string): SeedFile =>
  deployment.seed.files.find((f) => f.name === name) as SeedFile;

describe("folder reads (fixture)", () => {
  it("lists the seed: one COMPLETE page, each row with its kind, author and HEAD", async () => {
    const top = await listFolder(efs, root);
    if (top.status !== "PRESENT") throw new Error(top.status);
    expect(top.coverage).toEqual({ state: "COMPLETE" });
    expect(top.folder).toMatchObject({ directory: root.directory, owner: seeder });
    expect(top.rows).toEqual([
      expect.objectContaining({
        name: "docs",
        kind: "folder",
        typeId: t["files-directory/1"],
        target: { ...docs, owner: seeder },
        author: seeder,
      }),
    ]);
    const page = await listFolder(efs, docs);
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.coverage).toEqual({ state: "COMPLETE" });
    expect(page.skipped).toEqual({ hidden: 0, filtered: 0 });
    expect(page.rows.map((r) => r.name).sort()).toEqual(["big.bin", "readme.txt", "remote.txt"]);
    for (const r of page.rows) {
      const f = seeded(r.name);
      expect(r).toMatchObject({
        kind: "file",
        typeId: t["files-root/1"],
        author: seeder,
        target: { kind: "file", subject: f.subjectId },
        head: { record: f.headRecordId, revision: 1n },
      });
    }
  });

  it("withSize reads each file's content length, inline or under a descriptor", async () => {
    const page = await listFolder(efs, docs, { withSize: true });
    if (page.status !== "PRESENT") throw new Error(page.status);
    const size = Object.fromEntries(page.rows.map((r) => [r.name, r.size]));
    expect(size).toEqual({ "readme.txt": 18n, "big.bin": 20_000n, "remote.txt": 51n });
    const plain = await listFolder(efs, docs);
    expect(plain.status === "PRESENT" && plain.rows.every((r) => r.size === undefined)).toBe(true);
  });

  it("the kind filter counts what it leaves out, and an empty filtered page is still COMPLETE only when it is", async () => {
    const folders = await listFolder(efs, docs, { kinds: ["folder"] });
    if (folders.status !== "PRESENT") throw new Error(folders.status);
    expect(folders.rows).toEqual([]);
    expect(folders.skipped).toEqual({ hidden: 0, filtered: 3 });
    expect(folders.coverage).toEqual({ state: "COMPLETE" }); // the whole listing was scanned: truly no folders
    const files = await listFolder(efs, docs, { kinds: ["file"] });
    expect(files.status === "PRESENT" && files.rows.length).toBe(3);
  });

  it("pages: PARTIAL with a cursor until the end, never COMPLETE from a cursor; a cursor is bound to its query", async () => {
    const names: string[] = [];
    let page = await listFolder(efs, docs, { limit: 1 });
    if (page.status !== "PRESENT") throw new Error(page.status);
    expect(page.coverage).toEqual({ state: "PARTIAL", why: "MORE_PAGES" });
    names.push(...page.rows.map((r) => r.name));
    let guard = 0;
    while (page.status === "PRESENT" && page.next && guard++ < 10) {
      const cursor = page.next;
      page = await listFolder(efs, docs, { limit: 1, cursor });
      if (page.status !== "PRESENT") throw new Error(page.status);
      expect(page.coverage.state).toBe("PARTIAL");
      names.push(...page.rows.map((r) => r.name));
    }
    expect(page.status === "PRESENT" && page.next).toBeFalsy();
    expect(page.status === "PRESENT" && page.coverage).toEqual({
      state: "PARTIAL",
      why: "RESUMED",
    });
    expect(names.sort()).toEqual(["big.bin", "readme.txt", "remote.txt"]);

    const first = await listFolder(efs, docs, { limit: 1 });
    if (first.status !== "PRESENT" || !first.next) throw new Error("no cursor");
    const cursor = first.next;
    await expect(listFolder(efs, docs, { limit: 1, kinds: ["file"], cursor })).rejects.toThrow(
      EfsFault,
    );
    await expect(listFolder(efs, root, { limit: 1, cursor })).rejects.toThrow(/another listing/);
  });

  it("looks up one name: the Lens's choice and every candidate, or a proven absence", async () => {
    const readme = seeded("readme.txt");
    const found = await lookupEntry(efs, { folder: docs, name: "readme.txt" });
    if (found.status !== "PRESENT") throw new Error(found.status);
    expect(found.selected).toMatchObject({
      name: "readme.txt",
      kind: "file",
      author: seeder,
      target: { kind: "file", subject: readme.subjectId },
      head: { record: readme.headRecordId },
    });
    expect(found.candidates).toEqual([
      expect.objectContaining({
        author: seeder,
        target: { kind: "file", subject: readme.subjectId },
      }),
    ]);
    expect(found.candidates[0]?.firstBound).toBeGreaterThan(0n);
    expect(found.conflict).toBe(false);
    expect((await lookupEntry(efs, { folder: docs, name: "nothing-here.txt" })).status).toBe(
      "ABSENT_PROVEN",
    );
    await expect(lookupEntry(efs, { folder: docs, name: "a/b" })).rejects.toMatchObject({
      code: "MISUSE",
      details: { rule: "excluded-character" },
    });
  });

  it("resolves a path from the parent it is given, segment by segment, with each segment's author", async () => {
    const readme = seeded("readme.txt");
    const p = await resolvePath(efs, { from: root, segments: ["docs", "readme.txt"] });
    if (p.status !== "PRESENT") throw new Error(p.status);
    expect(p.target).toEqual({ kind: "file", subject: readme.subjectId });
    expect(p.chain).toEqual([
      {
        folder: root,
        name: "docs",
        author: seeder,
        target: { kind: "folder", directory: docs.directory },
      },
      {
        folder: { kind: "folder", directory: docs.directory },
        name: "readme.txt",
        author: seeder,
        target: { kind: "file", subject: readme.subjectId },
      },
    ]);
    expect(p.entry.selected.kind).toBe("file");
    expect(await resolvePath(efs, { from: root, segments: ["docs", "nope"] })).toMatchObject({
      status: "ABSENT_PROVEN",
      segment: 1,
    });
    expect(
      await resolvePath(efs, { from: root, segments: ["docs", "readme.txt", "inside"] }),
    ).toMatchObject({ status: "NOT_A_FOLDER", segment: 1 });
    expect(await resolvePath(efs, { from: root, segments: ["docs", ".."] })).toMatchObject({
      status: "INVALID",
      segment: 1,
      rule: "dot-or-dotdot",
    });
    expect(
      await resolvePath(efs, { from: root, segments: ["docs", "readme.txt"] }, { maxSegments: 1 }),
    ).toMatchObject({ status: "INVALID", reason: { code: "LIMIT_EXCEEDED" } });
    // The same names from another parent are another path: nothing is guessed from the root.
    expect(await resolvePath(efs, { from: docs, segments: ["docs"] })).toMatchObject({
      status: "ABSENT_PROVEN",
      segment: 0,
    });
  });

  it("a folder is named by its subject (its object link) with no read, and a non-folder is never an empty folder", async () => {
    expect(folderOf(efs, deployment.seed.folder.subjectId)).toEqual(docs);
    const looked = await lookupEntry(efs, { folder: root, name: "docs" });
    expect(looked.status === "PRESENT" && looked.selected.target).toEqual(docs);
    const readme = seeded("readme.txt");
    // A subject that minted a file, not a folder: no files-directory/1 record exists for it.
    expect(await listFolder(efs, folderOf(efs, readme.subjectId))).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    // A record that exists but is a file revision, not a folder.
    expect(await listFolder(efs, { kind: "folder", directory: readme.headRecordId })).toMatchObject(
      { status: "INVALID", reason: { code: "UNSUPPORTED_PROFILE" } },
    );
  });

  it("an author outside the Lens is not shown, and a Lens of nobody is refused", async () => {
    const stranger = `0x${"0".repeat(24)}${"12".repeat(20)}` as PrincipalId;
    const page = await listFolder(efs, docs, { lens: { principals: [stranger] } });
    expect(page).toMatchObject({ status: "PRESENT", rows: [], coverage: { state: "COMPLETE" } });
    await expect(listFolder(efs, docs, { lens: { principals: [] } })).rejects.toThrow(EfsFault);
  });
});
