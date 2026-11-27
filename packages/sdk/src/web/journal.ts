// SPDX-License-Identifier: MIT
// A durable attempt journal for browser pages and workers. Records live in IndexedDB, and every write commits with
// strict durability before its promise resolves. The submission lock is a Web Lock, which every tab and worker of
// the origin shares, so two of them never submit for one account at once.
import {
  type AttemptRecord,
  decodeJournalRecord,
  decodeSequenceRecord,
  encodeJournalRecord,
  encodeSequenceRecord,
  isOpenSequence,
  isSettled,
  type Journal,
  localLocks,
  lockKey,
  type SequenceRecord,
} from "../actions/journal.js";
import { EfsFault } from "../core/errors.js";
import { committed, done, lazyDb } from "./idb.js";

export interface IndexedDbJournalOptions {
  /** IndexedDB database name. Default "efs-sdk-journal"; one per origin is normal. */
  name?: string;
}

export interface WebJournal extends Journal {
  /**
   * True when the lock is a Web Lock, shared by every tab and worker of this origin. False when the context has no
   * Web Locks (a non-secure context or an old browser): the lock then covers this context only, and the ledger's
   * same-nonce rule alone stops a second tab's duplicate send of the same plan from committing twice.
   */
  readonly crossContext: boolean;
  /** Close the database connection. Later calls reopen it. */
  close(): void;
}

const STORE = "attempts";
const SEQUENCES = "sequences";
const BY_LOCK = "lock";
interface Row {
  planId: string;
  lock: string;
  stage: string;
  json: string;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

const unavailable = (e: unknown): EfsFault =>
  new EfsFault("JOURNAL_UNAVAILABLE", "the attempt journal (IndexedDB) is unavailable", {
    cause: e,
  });

/**
 * The journal for browser and worker clients. Pass it to `createWriter({ journal })`. Records survive reloads and
 * crashes; `writer.pending()` lists attempts that still need reconciling after the page comes back.
 *
 * Creating the journal, reading it (`get`, `unresolved`, so `writer.pending()`) and taking its lock write nothing to
 * storage: the database is created by the first `put`, which happens only when a submission is about to be made. A
 * guest visit leaves `indexedDB.databases()` as it found it.
 */
export function indexedDbJournal(options: IndexedDbJournalOptions = {}): WebJournal {
  const name = options.name ?? "efs-sdk-journal";
  const db = lazyDb(
    name,
    2,
    (conn, oldVersion) => {
      if (oldVersion < 1) {
        const store = conn.createObjectStore(STORE, { keyPath: "planId" });
        store.createIndex(BY_LOCK, "lock", { unique: false });
      }
      if (oldVersion < 2) {
        const seq = conn.createObjectStore(SEQUENCES, { keyPath: "sequenceId" });
        seq.createIndex(BY_LOCK, "lock", { unique: false });
      }
    },
    unavailable,
  );
  /** A transaction on the sequences store, or null when it does not exist yet (no write has created it). */
  const seqTx = async (mode: IDBTransactionMode): Promise<IDBTransaction | null> => {
    const c = await db.connect(mode === "readwrite");
    if (!c?.objectStoreNames.contains(SEQUENCES)) return null; // a version-1 database, read only
    try {
      return c.transaction(SEQUENCES, mode, { durability: "strict" });
    } catch (e) {
      throw unavailable(e);
    }
  };
  const tx = async (mode: IDBTransactionMode): Promise<IDBTransaction | null> => {
    const c = await db.connect(mode === "readwrite");
    if (!c) return null;
    try {
      return c.transaction(STORE, mode, { durability: "strict" });
    } catch (e) {
      throw unavailable(e);
    }
  };

  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  const local = localLocks();
  const webLock: Journal["withLock"] = async (lock, wait, fn) => {
    if (!locks) return local(lock, wait, fn);
    if (wait === false)
      return locks.request(lock, { ifAvailable: true }, async (held) => (held ? fn() : "BUSY"));
    if (wait === true) return locks.request(lock, {}, () => fn());
    const ac = new AbortController();
    let granted = false;
    const timer = setTimeout(() => ac.abort(), wait);
    try {
      return await locks.request(lock, { signal: ac.signal }, () => {
        granted = true;
        clearTimeout(timer);
        return fn();
      });
    } catch (e) {
      if (!granted && ac.signal.aborted) return "BUSY";
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    durable: true,
    crossContext: locks !== undefined,
    async put(record: AttemptRecord) {
      const t = (await tx("readwrite")) as IDBTransaction;
      const row: Row = {
        planId: record.planId.toLowerCase(),
        lock: lockKey(record.plan),
        stage: record.stage,
        json: encodeJournalRecord(record),
      };
      t.objectStore(STORE).put(row);
      try {
        await committed(t);
      } catch (e) {
        throw unavailable(e);
      }
    },
    async get(planId) {
      const t = await tx("readonly");
      if (!t) return undefined;
      const row = (await done(t.objectStore(STORE).get(planId.toLowerCase()))) as Row | undefined;
      return row ? decodeJournalRecord(row.json) : undefined;
    },
    async unresolved(lock) {
      const t = await tx("readonly");
      if (!t) return [];
      const rows = (await done(t.objectStore(STORE).index(BY_LOCK).getAll(lock))) as Row[];
      return rows.map((r) => decodeJournalRecord(r.json)).filter((r) => !isSettled(r));
    },
    async putSequence(record: SequenceRecord) {
      const t = (await seqTx("readwrite")) as IDBTransaction;
      t.objectStore(SEQUENCES).put({
        sequenceId: record.sequenceId.toLowerCase(),
        lock: record.lock,
        state: record.state,
        json: encodeSequenceRecord(record),
      });
      try {
        await committed(t);
      } catch (e) {
        throw unavailable(e);
      }
    },
    async getSequence(id) {
      const t = await seqTx("readonly");
      if (!t) return undefined;
      const row = (await done(t.objectStore(SEQUENCES).get(id.toLowerCase()))) as
        | { json: string }
        | undefined;
      return row ? decodeSequenceRecord(row.json) : undefined;
    },
    async openSequences(lock) {
      const t = await seqTx("readonly");
      if (!t) return [];
      const store = t.objectStore(SEQUENCES);
      const rows = (await done(
        lock === undefined ? store.getAll() : store.index(BY_LOCK).getAll(lock),
      )) as {
        json: string;
      }[];
      return rows.map((r) => decodeSequenceRecord(r.json)).filter(isOpenSequence);
    },
    withLock: webLock,
    close() {
      db.close();
    },
  };
}
