// SPDX-License-Identifier: MIT
// A persistent byte cache for pages and workers: verified record bodies and external content, kept across reloads
// in IndexedDB. Opt-in (pass it as `createEfs({ cache: { bytes } })`): the default cache is memory only, so a guest
// visit writes nothing. Reads never create the database. Every entry is re-verified by the SDK when it is read
// (record id or sha256), so a tampered or corrupted entry is only a miss. Note for apps: external bytes a person
// loaded once with `allowOrigins` stay readable from this store after a reload (no request is made for a cache
// hit). The permission itself is never stored.
import type { ByteStore } from "../cache/stores.js";
import type { Hex } from "../core/hex.js";
import { committed, done, lazyDb } from "./idb.js";

export interface IndexedDbByteStoreOptions {
  /** IndexedDB database name. Default "efs-sdk-cache". */
  name?: string;
  /** Keep at most this many bytes; least recently used entries go first. Default 256 MiB. */
  maxBytes?: number;
}

export interface WebByteStore extends ByteStore {
  /** Delete every entry (the database stays). */
  clear(): Promise<void>;
  close(): void;
}

const STORE = "bytes";
const BY_TIME = "at";
interface Row {
  key: string;
  bytes: Uint8Array;
  size: number;
  /** Last use, in ms; drives eviction. */
  at: number;
}

export function indexedDbByteStore(options: IndexedDbByteStoreOptions = {}): WebByteStore {
  const max = options.maxBytes ?? 256 * 1024 * 1024;
  const db = lazyDb(
    options.name ?? "efs-sdk-cache",
    1,
    (conn) => {
      const store = conn.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex(BY_TIME, "at", { unique: false });
    },
    (e) => (e instanceof Error ? e : new Error(String(e))),
  );
  // Running total of stored bytes, loaded once per store instance; eviction runs only when a put takes it over.
  let total: number | undefined;

  /** Evict least recently used rows, oldest first through the time index, until the total fits. */
  const evict = async (conn: IDBDatabase): Promise<void> => {
    const t = conn.transaction(STORE, "readwrite");
    const cursor = t.objectStore(STORE).index(BY_TIME).openCursor();
    await new Promise<void>((resolve, reject) => {
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || (total as number) <= max) return resolve();
        total = (total as number) - (c.value as Row).size;
        c.delete();
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
    await committed(t);
  };
  const loadTotal = async (conn: IDBDatabase): Promise<void> => {
    if (total !== undefined) return;
    const rows = (await done(conn.transaction(STORE).objectStore(STORE).getAll())) as Row[];
    total = rows.reduce((n, r) => n + r.size, 0);
  };

  return {
    async get(key: Hex) {
      try {
        const conn = await db.connect(false);
        if (!conn) return undefined;
        const t = conn.transaction(STORE, "readwrite");
        const store = t.objectStore(STORE);
        const row = (await done(store.get(key.toLowerCase()))) as Row | undefined;
        if (!row) return undefined;
        store.put({ ...row, at: Date.now() }); // refresh recency; best effort
        return row.bytes.slice();
      } catch {
        return undefined; // a broken cache is a miss
      }
    },
    async put(key: Hex, bytes: Uint8Array) {
      if (bytes.length > max) return;
      try {
        const conn = (await db.connect(true)) as IDBDatabase;
        await loadTotal(conn);
        const t = conn.transaction(STORE, "readwrite");
        const store = t.objectStore(STORE);
        const k = key.toLowerCase();
        const old = (await done(store.get(k))) as Row | undefined;
        store.put({
          key: k,
          bytes: bytes.slice(),
          size: bytes.length,
          at: Date.now(),
        } satisfies Row);
        await committed(t);
        total = (total as number) + bytes.length - (old?.size ?? 0);
        if (total > max) await evict(conn);
      } catch {
        // a full or broken cache never fails a read
      }
    },
    async clear() {
      const conn = await db.connect(false);
      if (!conn) return;
      const t = conn.transaction(STORE, "readwrite");
      t.objectStore(STORE).clear();
      await committed(t);
      total = 0;
    },
    close() {
      db.close();
    },
  };
}
