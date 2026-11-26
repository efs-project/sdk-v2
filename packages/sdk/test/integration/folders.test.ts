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
  listFolder,
  lookupEntry,
  openObject,
  openPath,
  resolvePath,
} from "../../src/files/folders.ts";
import { link, parseLink } from "../../src/names/links.ts";

type SeedFile = { name: string; subjectId: SubjectId; headRecordId: RecordId };
const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId; principalId: PrincipalId };
  seed: {
    folder: { name: string; directoryRecordId: RecordId };
    files: SeedFile[];
  };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const docs: FolderRef = { kind: "folder", directory: deployment.seed.folder.directoryRecordId };
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

  it("kinds are one vocabulary across views: a kind a folder can't hold matches nothing; a string that is no kind is MISUSE", async () => {
    // "revision" and "topic" are topic-view kinds: a folder never holds one, so nothing matches, and it is counted.
    const none = await listFolder(efs, docs, { kinds: ["revision", "topic"] });
    if (none.status !== "PRESENT") throw new Error(none.status);
    expect(none.rows).toEqual([]);
    expect(none.skipped.filtered).toBe(3);
    // A typo is never a filter that matches nothing (a scan from the start would read COMPLETE and empty: a false
    // "none of that kind").
    await expect(listFolder(efs, docs, { kinds: ["files" as never] })).rejects.toMatchObject({
      code: "MISUSE",
    });
    await expect(listFolder(efs, docs, { kinds: ["File" as never] })).rejects.toMatchObject({
      code: "MISUSE",
    });
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
    // Every folder on the way carries its creator, read with the record that proves it is a folder.
    expect(p.chain).toEqual([
      {
        folder: { ...root, owner: seeder },
        name: "docs",
        author: seeder,
        target: { kind: "folder", directory: docs.directory, owner: seeder },
      },
      {
        folder: { kind: "folder", directory: docs.directory, owner: seeder },
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

  it("openObject tells a folder's id from a file's, with who created each, and a non-folder is never an empty folder", async () => {
    const readme = seeded("readme.txt");
    expect(await openObject(efs, docs.directory)).toMatchObject({
      status: "FOLDER",
      folder: { kind: "folder", directory: docs.directory, owner: seeder },
    });
    const file = await openObject(efs, readme.subjectId);
    expect(file).toMatchObject({
      status: "FILE",
      file: { kind: "file", subject: readme.subjectId },
      creator: seeder,
      open: { status: "PRESENT", file: { revision: readme.headRecordId } },
    });
    // A revision record is a record of another Type: not an object (it has its own ~efs/v link).
    expect(await openObject(efs, readme.headRecordId)).toMatchObject({ status: "INVALID" });
    expect(await openObject(efs, `0x${"9e".repeat(32)}` as RecordId)).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    // Listing what isn't a folder: no such record, or a record of another Type.
    expect(
      await listFolder(efs, { kind: "folder", directory: `0x${"9e".repeat(32)}` as RecordId }),
    ).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    expect(await listFolder(efs, { kind: "folder", directory: readme.headRecordId })).toMatchObject(
      {
        status: "INVALID",
        reason: { code: "UNSUPPORTED_PROFILE" },
      },
    );
    const looked = await lookupEntry(efs, { folder: root, name: "docs" });
    expect(looked.status === "PRESENT" && looked.selected.target).toEqual({
      ...docs,
      owner: seeder,
    });
  });

  it("openPath opens a path link from a folder's id, with the folder's creator in the default Lens", async () => {
    const readme = seeded("readme.txt");
    const parsed = parseLink(link({ kind: "path", folder: docs.directory, names: ["readme.txt"] }));
    if (parsed.status !== "OK" || parsed.target.kind !== "path") throw new Error("not a path link");
    const opened = await openPath(efs, parsed.target);
    expect(opened).toMatchObject({
      kind: "efs.path",
      status: "PRESENT",
      target: { kind: "file", subject: readme.subjectId },
    });
    // The Lens it resolved under: no reader here, so the folder's creator, then the default.
    expect(opened.status === "PRESENT" && opened.lens).toEqual(efs.lens.place({ owner: seeder }));
    // The shared root is a folder like any other: reached by its id, with names after it.
    expect(
      await openPath(efs, { kind: "path", folder: root.directory, names: ["docs", "readme.txt"] }),
    ).toMatchObject({ status: "PRESENT", target: { kind: "file", subject: readme.subjectId } });
    // The creator joins the default Lens after the reader: a reader and a base with no entries still see the
    // creator's. Under the same Lens without the creator, nothing is there.
    const stranger = `0x${"0".repeat(24)}${"12".repeat(20)}` as PrincipalId;
    const nobody = { principals: [stranger] };
    const viaCreator = await openPath(
      efs,
      { kind: "path", folder: docs.directory, names: ["readme.txt"] },
      { reader: stranger, base: nobody },
    );
    expect(viaCreator).toMatchObject({ status: "PRESENT" });
    expect(viaCreator.status === "PRESENT" && viaCreator.lens).toEqual({
      principals: [stranger, seeder],
    });
    expect(
      await resolvePath(efs, { from: docs, segments: ["readme.txt"] }, { lens: nobody }),
    ).toMatchObject({ status: "ABSENT_PROVEN", segment: 0 });
    // A Lens the link carries is used as it is: the sharer's view, with no creator added.
    expect(
      await openPath(efs, {
        kind: "path",
        folder: docs.directory,
        names: ["readme.txt"],
        lens: nobody,
      }),
    ).toMatchObject({ status: "ABSENT_PROVEN", segment: 0, lens: nobody });
  });

  it("openPath refuses names below a file id, and says when nothing has the id", async () => {
    const readme = seeded("readme.txt");
    // A file has no names below it: INVALID, never the file itself.
    const below = await openPath(efs, {
      kind: "path",
      folder: readme.subjectId as unknown as RecordId,
      names: ["inside"],
    });
    expect(below).toMatchObject({
      kind: "efs.path",
      status: "INVALID",
      reason: { code: "UNSUPPORTED_PROFILE", retry: "never" },
    });
    expect(below).not.toHaveProperty("target");
    // A record of another Type (a revision) is not a folder either.
    expect(
      await openPath(efs, { kind: "path", folder: readme.headRecordId, names: ["inside"] }),
    ).toMatchObject({ kind: "efs.path", status: "INVALID" });
    // Nothing has this id: openObject's own proven absence, not a missing name.
    expect(
      await openPath(efs, {
        kind: "path",
        folder: `0x${"9e".repeat(32)}` as RecordId,
        names: ["readme.txt"],
      }),
    ).toMatchObject({ kind: "efs.object", status: "ABSENT_PROVEN" });
  });

  it("an author outside the Lens is not shown, and a Lens of nobody is refused", async () => {
    const stranger = `0x${"0".repeat(24)}${"12".repeat(20)}` as PrincipalId;
    const page = await listFolder(efs, docs, { lens: { principals: [stranger] } });
    expect(page).toMatchObject({ status: "PRESENT", rows: [], coverage: { state: "COMPLETE" } });
    await expect(listFolder(efs, docs, { lens: { principals: [] } })).rejects.toThrow(EfsFault);
  });
});
