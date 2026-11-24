// SPDX-License-Identifier: MIT
// Caches passed in by the caller (api-0.1 §6). Async, so IndexedDB or files can back them. A cache only ever saves
// work: every entry is re-verified when it is read (a byte entry against its content id or digest, a result entry
// only for the exact endpoint and block hash it was computed at), and an eviction or a bad entry is a miss, never
// "absent".
import type { Hex } from "../core/hex.js";
import { clone } from "../core/platform.js";

/** Exact verified bytes, keyed by content id (record id or sha256). */
export interface ByteStore {
  get(key: Hex): Promise<Uint8Array | undefined>;
  put(key: Hex, bytes: Uint8Array): Promise<void>;
}
/** Results qualified by deployment, endpoint and block hash, keyed by a string the SDK builds. */
export interface ResultStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
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

/** In-memory result store, least recently used first out (default 1,024 entries). The default for every client. */
export function memoryResultStore(o: { maxEntries?: number } = {}): ResultStore {
  const max = o.maxEntries ?? 1024;
  const entries = new Map<string, unknown>();
  return {
    async get(key) {
      if (!entries.has(key)) return undefined;
      const v = entries.get(key);
      entries.delete(key);
      entries.set(key, v);
      return clone(v);
    },
    async put(key, value) {
      entries.delete(key);
      entries.set(key, clone(value));
      while (entries.size > max) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
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
