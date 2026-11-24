// SPDX-License-Identifier: MIT
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeJournalRecord,
  encodeJournalRecord,
  lockKey,
  memoryJournal,
} from "../src/actions/journal.ts";
import { fileJournal } from "../src/node/journal.ts";
import { journalContract, SAMPLE } from "./journal-contract.ts";

journalContract("memory", () => memoryJournal());

let dir = "";
journalContract(
  "file",
  () => {
    dir = mkdtempSync(join(tmpdir(), "efs-journal-"));
    return fileJournal(dir);
  },
  { reopen: () => fileJournal(dir) },
);

describe("journal record codec", () => {
  it("round-trips the storage form and refuses anything that is not an efs-sdk-attempt/1 record", () => {
    expect(encodeJournalRecord(decodeJournalRecord(encodeJournalRecord(SAMPLE)))).toBe(
      encodeJournalRecord(SAMPLE),
    );
    expect(() => decodeJournalRecord("{torn")).toThrow(/invalid JSON/);
    expect(() => decodeJournalRecord(JSON.stringify({ schema: "efs-sdk-attempt/2" }))).toThrow(
      /not an efs-sdk-attempt\/1/,
    );
  });
});

describe("file journal specifics", () => {
  it("never leaves temporary files behind, and refuses a path-like plan id", async () => {
    const d = mkdtempSync(join(tmpdir(), "efs-journal-"));
    const j = fileJournal(d);
    await j.put(SAMPLE);
    await j.put({ ...SAMPLE, stage: "SUBMITTED" });
    expect(readdirSync(join(d, "attempts"))).toEqual([`${SAMPLE.planId}.json`]);
    expect(await j.get("../../etc/passwd" as never)).toBeUndefined();
    await expect(j.put({ ...SAMPLE, planId: "../x" as never })).rejects.toThrow(/not a plan id/);
  });

  it("an unreadable record is a fault, never silently skipped", async () => {
    const d = mkdtempSync(join(tmpdir(), "efs-journal-"));
    const j = fileJournal(d);
    await j.put(SAMPLE);
    writeFileSync(join(d, "attempts", `0x${"cd".repeat(32)}.json`), "{torn");
    await expect(j.unresolved(lockKey(SAMPLE.plan))).rejects.toThrow(/is unreadable/);
  });

  it("another process holding the lock makes this one BUSY; a dead holder's lock is taken over", async () => {
    const d = mkdtempSync(join(tmpdir(), "efs-journal-"));
    const lock = "efs:test:cross-process";
    // A child process takes the lock and holds it until told to exit.
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        // Run the TypeScript source directly: map the source's NodeNext ".js" specifiers to the ".ts" files.
        `const { registerHooks } = require("node:module");
        registerHooks({ resolve(spec, ctx, next) {
          try { return next(spec, ctx); }
          catch (e) { if (spec.endsWith(".js")) return next(spec.slice(0, -3) + ".ts", ctx); throw e; }
        } });
        import(${JSON.stringify(new URL("../src/node/journal.ts", import.meta.url).href)}).then(async ({ fileJournal }) => {
          await fileJournal(${JSON.stringify(d)}).withLock(${JSON.stringify(lock)}, false, async () => {
            process.stdout.write("held\\n");
            await new Promise((r) => process.stdin.once("data", r));
          });
          process.exit(0);
        });`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    const j = fileJournal(d, { pollMs: 10 });
    expect(await j.withLock(lock, false, async () => "mine")).toBe("BUSY");
    expect(await j.withLock(lock, 100, async () => "mine")).toBe("BUSY");
    // Kill it while it holds the lock: the lock file stays, but its process is gone.
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(readdirSync(join(d, "locks")).length).toBe(1);
    expect(await j.withLock(lock, false, async () => "mine")).toBe("mine");
    expect(readdirSync(join(d, "locks"))).toEqual([]);
  });
});
