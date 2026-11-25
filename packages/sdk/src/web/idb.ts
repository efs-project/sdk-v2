// SPDX-License-Identifier: MIT
// IndexedDB plumbing shared by the journal and the byte cache. The one rule that matters: reading creates nothing.
// A database is opened without a version, and if it does not exist the creating upgrade is aborted, so a guest
// visit leaves `indexedDB.databases()` as it found it. Only `connect(true)` (a real write) creates the database.

export const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export const committed = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });

export interface LazyDb {
  /** The connection, or null when `create` is false and the database does not exist yet. */
  connect(create: boolean): Promise<IDBDatabase | null>;
  close(): void;
}

/** A database opened on demand. Only connections are cached, never "absent": one another tab creates is found. */
export function lazyDb(
  name: string,
  version: number,
  /** Create what versions after `oldVersion` add (0 for a new database). */
  upgrade: (db: IDBDatabase, oldVersion: number) => void,
  unavailable: (e: unknown) => Error,
): LazyDb {
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
      const req = factory().open(name, version);
      req.onupgradeneeded = (ev: IDBVersionChangeEvent) => upgrade(req.result, ev.oldVersion);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(unavailable(req.error));
    });
  return {
    async connect(create) {
      if (conn) {
        const c = await conn.catch(() => undefined);
        // A read opened an older version (it never upgrades); a write needs this version: reopen, upgrading.
        if (!(create && c && c.version < version)) return conn;
        c.close();
        conn = undefined;
      }
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
    },
    close() {
      const pending = conn;
      conn = undefined;
      void pending?.then((c) => c.close()).catch(() => {});
    },
  };
}
