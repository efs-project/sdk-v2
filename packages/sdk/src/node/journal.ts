// SPDX-License-Identifier: MIT
// A durable attempt journal on the local filesystem, for Node scripts, servers and CLIs. One JSON file per attempt,
// written to a temporary file, fsynced, then renamed into place (and the directory fsynced), so a crash leaves
// either the old record or the new one, never a torn one. The submission lock is a lock file that other processes
// on this machine respect; a lock left by a process that died is taken over. The lock is best effort under
// pathological races (several processes taking over one stale lock in the same instant); the ledger's same-nonce
// rule is the final guard, so even then a plan commits at most once.
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type AttemptRecord,
  decodeJournalRecord,
  decodeSequenceRecord,
  encodeJournalRecord,
  encodeSequenceRecord,
  isOpenSequence,
  isResolved,
  type Journal,
  localLocks,
  lockKey,
  type SequenceRecord,
} from "../actions/journal.js";
import { EfsFault } from "../core/errors.js";

export interface FileJournalOptions {
  /** A lock file older than this is taken over even if its process looks alive (pid reuse). Default 30 minutes. */
  staleLockMs?: number;
  /** How often a waiting caller retries a lock file held by another process. Default 100 ms. */
  pollMs?: number;
}

const PLAN_ID = /^0x[0-9a-f]{64}$/;

const unavailable = (e: unknown, what: string): EfsFault =>
  new EfsFault("JOURNAL_UNAVAILABLE", `the attempt journal is unavailable: ${what}`, { cause: e });

const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

async function writeDurably(dir: string, file: string, text: string): Promise<void> {
  const tmp = join(dir, `.${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, join(dir, file));
  try {
    const d = await open(dir, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch (e) {
    // Some platforms (Windows) cannot fsync a directory; the rename itself is still atomic there.
    if (!["EISDIR", "EPERM", "EINVAL", "EACCES"].includes(code(e) ?? "")) throw e;
  }
}

interface Owner {
  pid: number;
  host: string;
  at: number;
  token: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return code(e) === "EPERM"; // exists, owned by another user
  }
};

/**
 * The journal for Node clients. `dir` is created if missing and holds `attempts/` and `locks/`. Keep one directory
 * per user and machine; a network filesystem is not supported (its rename and lock-file semantics vary).
 */
export function fileJournal(dir: string, options: FileJournalOptions = {}): Journal {
  const attempts = join(dir, "attempts");
  const sequences = join(dir, "sequences");
  const lockDir = join(dir, "locks");
  const staleMs = options.staleLockMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 100;
  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    ready ??= Promise.all([
      mkdir(attempts, { recursive: true }),
      mkdir(sequences, { recursive: true }),
      mkdir(lockDir, { recursive: true }),
    ]).then(
      () => undefined,
      (e) => {
        ready = undefined;
        throw unavailable(e, `cannot create ${dir}`);
      },
    );
    return ready;
  };

  const readRecord = async (file: string): Promise<AttemptRecord | undefined> => {
    let text: string;
    try {
      text = await readFile(join(attempts, file), "utf8");
    } catch (e) {
      if (code(e) === "ENOENT") return undefined;
      throw unavailable(e, `cannot read ${file}`);
    }
    try {
      return decodeJournalRecord(text);
    } catch (e) {
      // Never skip a record silently: an unreadable record may be an attempt that still needs reconciling.
      throw new EfsFault("INVARIANT", `attempt journal record ${file} is unreadable`, {
        cause: e,
      });
    }
  };

  /** Try once to take the lock file. Returns a release function, or null if another live owner holds it. */
  const tryFileLock = async (path: string): Promise<(() => Promise<void>) | null> => {
    const me: Owner = {
      pid: process.pid,
      host: hostname(),
      at: Date.now(),
      token: randomBytes(16).toString("hex"),
    };
    const release = async () => {
      // Remove only our own lock: if it was (wrongly) taken over, the new owner's file stays. Never throws: this
      // runs after the guarded call (perhaps a broadcast), whose result must not be lost. A lock file we fail to
      // remove names a live process (us) until we exit or it turns stale.
      try {
        const now = await readFile(path, "utf8").catch(() => "");
        if (now.includes(me.token)) await rm(path, { force: true });
      } catch {
        // see above
      }
    };
    for (let tries = 0; tries < 3; tries++) {
      try {
        const fh = await open(path, "wx");
        try {
          await fh.writeFile(JSON.stringify(me), "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        return release;
      } catch (e) {
        if (code(e) !== "EEXIST") throw unavailable(e, `cannot create lock ${path}`);
      }
      const text = await readFile(path, "utf8").catch(() => null);
      if (text === null) continue; // released in between: try again
      let owner: Owner | undefined;
      try {
        owner = JSON.parse(text) as Owner;
      } catch {
        // Being written right now, or garbage. Take it over only once it is old.
        const info = await stat(path).catch(() => null);
        if (!info || Date.now() - info.mtimeMs < staleMs) return null;
      }
      const stale =
        owner === undefined ||
        Date.now() - owner.at > staleMs ||
        (owner.host === me.host && !alive(owner.pid));
      if (!stale) return null;
      // Take over through a rename, so two processes that both saw the stale owner cannot both remove a newer lock:
      // only one rename of this exact file succeeds, and the loser's next exclusive create fails.
      const grave = `${path}.${me.token}.stale`;
      try {
        await rename(path, grave);
        const moved = await readFile(grave, "utf8").catch(() => null);
        if (moved !== text && moved !== null) {
          // We moved a newer, live lock: put it back without overwriting any lock created meanwhile.
          await link(grave, path).catch(() => {});
          await rm(grave, { force: true });
          return null;
        }
        await rm(grave, { force: true });
      } catch (e) {
        if (code(e) !== "ENOENT") throw unavailable(e, `cannot take over lock ${path}`);
      }
    }
    return null;
  };

  const local = localLocks();
  // One in-process queue first (the lock file names a process, not a caller), then the cross-process file. A
  // numeric `wait` bounds both together.
  const withLock: Journal["withLock"] = (lock, wait, fn) => {
    const deadline =
      wait === true ? Number.POSITIVE_INFINITY : Date.now() + (wait === false ? 0 : wait);
    return local(lock, wait, async () => {
      await ensure();
      const name = createHash("sha256").update(lock).digest("hex").slice(0, 32);
      const path = join(lockDir, `${name}.lock`);
      for (;;) {
        const release = await tryFileLock(path);
        if (release) {
          try {
            return await fn();
          } finally {
            await release();
          }
        }
        if (Date.now() >= deadline) return "BUSY" as const;
        await new Promise((r) =>
          setTimeout(r, Math.min(pollMs, Math.max(1, deadline - Date.now()))),
        );
      }
    });
  };

  const readSequence = async (file: string): Promise<SequenceRecord | undefined> => {
    let text: string;
    try {
      text = await readFile(join(sequences, file), "utf8");
    } catch (e) {
      if (code(e) === "ENOENT") return undefined;
      throw unavailable(e, `cannot read ${file}`);
    }
    try {
      return decodeSequenceRecord(text);
    } catch (e) {
      throw new EfsFault("INVARIANT", `sequence record ${file} is unreadable`, { cause: e });
    }
  };

  return {
    durable: true,
    async putSequence(record) {
      const id = record.sequenceId.toLowerCase();
      if (!PLAN_ID.test(id))
        throw new EfsFault("MISUSE", `not a sequence id: ${record.sequenceId}`);
      await ensure();
      try {
        await writeDurably(sequences, `${id}.json`, `${encodeSequenceRecord(record)}\n`);
      } catch (e) {
        throw unavailable(e, `cannot write ${id}.json`);
      }
    },
    async getSequence(id) {
      const k = id.toLowerCase();
      if (!PLAN_ID.test(k)) return undefined;
      await ensure();
      return readSequence(`${k}.json`);
    },
    async openSequences(lock) {
      await ensure();
      let files: string[];
      try {
        files = await readdir(sequences);
      } catch (e) {
        throw unavailable(e, `cannot list ${sequences}`);
      }
      const out: SequenceRecord[] = [];
      for (const f of files.filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n)).sort()) {
        const r = await readSequence(f);
        if (r && r.lock === lock && isOpenSequence(r)) out.push(r);
      }
      return out;
    },
    async put(record) {
      const id = record.planId.toLowerCase();
      if (!PLAN_ID.test(id)) throw new EfsFault("MISUSE", `not a plan id: ${record.planId}`);
      await ensure();
      try {
        await writeDurably(attempts, `${id}.json`, `${encodeJournalRecord(record)}\n`);
      } catch (e) {
        throw unavailable(e, `cannot write ${id}.json`);
      }
    },
    async get(planId) {
      const id = planId.toLowerCase();
      if (!PLAN_ID.test(id)) return undefined;
      await ensure();
      return readRecord(`${id}.json`);
    },
    async unresolved(lock) {
      await ensure();
      let files: string[];
      try {
        files = await readdir(attempts);
      } catch (e) {
        throw unavailable(e, `cannot list ${attempts}`);
      }
      const out: AttemptRecord[] = [];
      for (const f of files.filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n)).sort()) {
        const r = await readRecord(f);
        if (r && !isResolved(r.stage) && lockKey(r.plan) === lock) out.push(r);
      }
      return out;
    },
    withLock,
  };
}
