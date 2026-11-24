// SPDX-License-Identifier: MIT
/**
 * `@efs/sdk/testing`: development helpers, never needed at runtime.
 *
 * RPC transcripts (`efs-sdk-rpc-transcript/1`, shipped as `@efs/sdk/fixtures/rpc/*.json`) are recorded JSON-RPC
 * traffic from a real fixture chain. Replaying one runs the real SDK with no chain: pass `replayFetch(t)` as
 * `createEfs({ fetch })`, or answer intercepted requests yourself with `createRpcReplay(t).answer(body)` (for example
 * in a Playwright `page.route` handler on a fake RPC origin).
 *
 * Matching rule: each JSON-RPC call is matched on `[method, params]` exactly; the JSON-RPC `id` is ignored and
 * answered with the caller's own id. Calls inside a batch are matched one by one and answered in the caller's order,
 * so a batch is never matched as a whole. When one call was recorded several times its answers are served in
 * recorded order, and the last answer repeats.
 */
import type { FetchLike } from "../chain/rpc.js";
import { utf8Encode } from "../core/platform.js";

export interface RpcCall {
  /** The request body as sent: one JSON-RPC object or a batch array. */
  request: unknown;
  /** The response body as received. */
  response: unknown;
}

export interface RpcTranscript {
  schema: "efs-sdk-rpc-transcript/1";
  case: string;
  note: string;
  contractsCommit: string;
  /** The ids a replay needs to name (for example the file subjects opened). */
  ids: Record<string, string>;
  /** The steps the SDK ran, in order, as human-readable calls. */
  steps: readonly string[];
  calls: readonly RpcCall[];
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const keyOf = (r: JsonRpcRequest): string => JSON.stringify([r.method, r.params ?? []]);
const items = <T>(body: unknown): T[] => (Array.isArray(body) ? (body as T[]) : [body as T]);

export interface RpcReplay {
  /** Answer one request body (object or batch) as an RPC node would. Unmatched calls get a JSON-RPC error. */
  answer(body: unknown): unknown;
  /** Calls that had no recorded answer, as "method params" strings. Empty in a faithful replay. */
  readonly misses: readonly string[];
}

export function createRpcReplay(transcripts: RpcTranscript | readonly RpcTranscript[]): RpcReplay {
  const answers = new Map<string, Omit<JsonRpcResponse, "id" | "jsonrpc">[]>();
  const served = new Map<string, number>();
  for (const t of Array.isArray(transcripts) ? transcripts : [transcripts as RpcTranscript]) {
    for (const call of t.calls) {
      const reqs = items<JsonRpcRequest>(call.request);
      const byId = new Map(
        items<JsonRpcResponse>(call.response).map((r) => [JSON.stringify(r.id), r]),
      );
      for (const req of reqs) {
        const res = byId.get(JSON.stringify(req.id));
        if (!res) continue;
        const k = keyOf(req);
        const list = answers.get(k) ?? [];
        list.push(res.error ? { error: res.error } : { result: res.result });
        answers.set(k, list);
      }
    }
  }
  const misses: string[] = [];
  return {
    misses,
    answer(body) {
      const out = items<JsonRpcRequest>(body).map((req): JsonRpcResponse => {
        const k = keyOf(req);
        const list = answers.get(k);
        if (!list?.length) {
          misses.push(`${req.method} ${JSON.stringify(req.params ?? [])}`);
          return {
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: { code: -32601, message: `replay: no recorded answer for ${req.method}` },
          };
        }
        const n = served.get(k) ?? 0;
        served.set(k, n + 1);
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          ...(list[Math.min(n, list.length - 1)] as object),
        };
      });
      return Array.isArray(body) ? out : out[0];
    },
  };
}

const respond = (status: number, text: string): ReturnType<FetchLike> =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => text,
    arrayBuffer: async () => utf8Encode(text).slice().buffer,
  });

/** A fetch that answers JSON-RPC POSTs from transcripts (any URL) and 404s everything else. */
export function replayFetch(
  transcripts: RpcTranscript | readonly RpcTranscript[],
): FetchLike & { readonly replay: RpcReplay } {
  const replay = createRpcReplay(transcripts);
  const f = (async (_url, init) => {
    if (init.method !== "POST" || init.body === undefined) return respond(404, "");
    return respond(200, JSON.stringify(replay.answer(JSON.parse(init.body))));
  }) as FetchLike & { replay: RpcReplay };
  f.replay = replay;
  return f;
}

/** Wrap a fetch so every JSON-RPC POST is recorded as an RpcCall (request and response bodies, verbatim). */
export function recordingFetch(inner: FetchLike): { fetch: FetchLike; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const f: FetchLike = async (url, init) => {
    const res = await inner(url, init);
    if (init.method !== "POST" || init.body === undefined) return res;
    const text = await res.text();
    try {
      calls.push({ request: JSON.parse(init.body), response: JSON.parse(text) });
    } catch {
      // not JSON-RPC: not recorded
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => text,
      arrayBuffer: async () => utf8Encode(text).slice().buffer,
    };
  };
  return { fetch: f, calls };
}
