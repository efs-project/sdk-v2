// SPDX-License-Identifier: MIT
// A durable attempt journal for browser pages and workers. Records live in IndexedDB, and every write commits with
// strict durability before its promise resolves. The submission lock is a Web Lock, which every tab and worker of
// the origin shares, so two of them never submit for one account at once.
import {
  type AttemptRecord,
  decodeJournalRecord,
  encodeJournalRecord,
  isResolved,
  type Journal,
  localLocks,
  lockKey,
} from "../actions/journal.js";
import { EfsFault } from "../core/errors.js";

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

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const committed = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });

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
  // Only connections are cached, never "absent": a database another tab creates later is still found.
  let conn: Promise<IDBDatabase> | undefined;
  const factory = (): IDBFactory => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!idb) throw unavailable(new Error("no indexedDB in this context"));
    return idb;
  };
  const adopt = (c: IDBDatabase): IDBDatabase => {
    // Another context upgrading the schema: step aside, reopen on next use.
    c.onversionchange = () => {
      c.close();
      conn = undefined;
    };
    return c;
  };
  /** Open the database if it exists, creating nothing: a read on a fresh origin writes no storage. */
  const openExisting = (): Promise<IDBDatabase | null> =>
    new Promise((resolve, reject) => {
      const req = factory().open(name);
      let fresh = false;
      req.onupgradeneeded = (ev: IDBVersionChangeEvent) => {
        if (ev.oldVersion === 0) {
          fresh = true;
          req.transaction?.abort(); // aborting the creating upgrade leaves no database behind
        }
      };
      req.onsuccess = () => {
        if (fresh) {
          req.result.close();
          resolve(null);
        } else resolve(req.result);
      };
      req.onerror = (ev: Event) => {
        if (fresh) {
          ev.preventDefault();
          resolve(null);
        } else reject(unavailable(req.error));
      };
    });
  const openCreating = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = factory().open(name, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: "planId" });
        store.createIndex(BY_LOCK, "lock", { unique: false });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable(req.error));
    });
  /** The connection, or null when `create` is false and the database does not exist yet. */
  const connect = async (create: boolean): Promise<IDBDatabase | null> => {
    if (conn) return conn;
    if (!create) {
      const found = await openExisting();
      if (!found) return null;
      if (conn) {
        found.close(); // a concurrent caller connected first
        return conn;
      }
      conn = Promise.resolve(adopt(found));
      return conn;
    }
    conn = openCreating().then(adopt, (e) => {
      conn = undefined;
      throw e;
    });
    return conn;
  };
  const tx = async (mode: IDBTransactionMode): Promise<IDBTransaction | null> => {
    const c = await connect(mode === "readwrite");
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
      return rows
        .filter((r) => !isResolved(r.stage as AttemptRecord["stage"]))
        .map((r) => decodeJournalRecord(r.json));
    },
    withLock: webLock,
    close() {
      const pending = conn;
      conn = undefined;
      void pending?.then((c) => c.close()).catch(() => {});
    },
  };
}
