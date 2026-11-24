// SPDX-License-Identifier: MIT
// The byte cache passed in by the caller (api-0.1 §6). Async, so IndexedDB or files can back it. A cache only ever
// saves work: every entry is re-verified when it is read (against its content id or digest), and an eviction or a
// bad entry is a miss, never "absent". Security decisions (verified pins) are never read from a caller's store.
import type { Hex } from "../core/hex.js";

/** Exact verified bytes, keyed by content id (record id or sha256). */
export interface ByteStore {
  get(key: Hex): Promise<Uint8Array | undefined>;
  put(key: Hex, bytes: Uint8Array): Promise<void>;
}
/** In-memory byte store, least recently used first out (default 32 MiB). The default for every client. */
export function memoryByteStore(o: { maxBytes?: number } = {}): ByteStore {
  const max = o.maxBytes ?? 32 * 1024 * 1024;
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  return {
    async get(key) {
      const k = key.toLowerCase();
      const v = entries.get(k);
      if (!v) return undefined;
      entries.delete(k); // refresh recency
      entries.set(k, v);
      return v.slice();
    },
    async put(key, bytes) {
      if (bytes.length > max) return;
      const k = key.toLowerCase();
      const old = entries.get(k);
      if (old) {
        total -= old.length;
        entries.delete(k);
      }
      entries.set(k, bytes.slice());
      total += bytes.length;
      for (const [ek, ev] of entries) {
        if (total <= max) break;
        entries.delete(ek);
        total -= ev.length;
      }
    },
  };
}

/** Read through a cache, never letting a cache failure fail the read. */
export async function cacheGet<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}
/** Write to a cache best effort: a full or broken cache never fails a read. */
export async function cachePut(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // a cache is only an optimization
  }
}
