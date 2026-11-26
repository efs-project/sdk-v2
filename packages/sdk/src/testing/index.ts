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
 *
 * Write flows also carry a wallet half (`wallet`): the EIP-1193 requests the writer made of the wallet, in order, with
 * the wallet's result or error. `replayProvider(t)` answers them by the same matching rule, so a fake wallet plus
 * `replayFetch(t)` replays a whole edit (plan, approval, send, settle) with no chain and no wallet.
 *
 * A replay whose head moves only with the event that moved it: record with `createRecorder(fetch, provider)` (both
 * halves and the harness's `mark(label)` in one sequence: `seq` on every call, `marks`), and replay with
 * `createReplay(t)` (`fetch`, `provider`, `mark`, `finish`). Reads are served from the current epoch (repeating it,
 * never borrowing a later head), so a page that reads "latest" more often than the recording did still lines up;
 * what that forgives is counted in `extraReads`. Writes stay strict: an unrecorded or repeated write, or a mark out
 * of order, is a miss, and `finish()` makes every gate never served a miss too. Call `mark` after every head move the
 * page doesn't make (an actor's write, a mine), in record and replay alike. A transcript without `seq` replays as
 * `createRpcReplay` always did.
 *
 * `planLoneHide(efs, writer, { folder, name })` plans, for writer.runSequence, a state the SDK's planners never make
 * on purpose: your hide at a name where you never placed anything (listRemoved's NEVER_BOUND row, which Unhide
 * answers). `planOtherEntry(efs, writer, { folder, name, salt? })` places a subject with no file version at a name in a
 * folder or a home (a listing shows kind "other": the junk row an owner blocks). Both are for tests on a real chain; an
 * app does not need them.
 */
import type { Eip1193Like, FetchLike } from "../chain/rpc.js";
import { utf8Encode } from "../core/platform.js";

export type {
  LoneHideInput,
  LoneHideReview,
  OtherEntryInput,
  OtherEntryReview,
} from "../files/entries.js";
export { planLoneHide, planOtherEntry } from "../files/entries.js";

export interface RpcCall {
  /** The request body as sent: one JSON-RPC object or a batch array. */
  request: unknown;
  /** The response body as received. */
  response: unknown;
  /** createRecorder: when the response came back, in one sequence with the wallet calls and the marks. */
  seq?: number;
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
  /** Write flows only: the wallet half, every EIP-1193 request the writer made of the wallet, in order. */
  wallet?: readonly WalletCall[];
  /** createRecorder: head moves the page didn't make (a harness's `mark`), in the calls' sequence. */
  marks?: readonly RecordedMark[];
}

/** A harness's mark: where the chain's head moved without a page write (an actor's write, a mine). */
export interface RecordedMark {
  seq: number;
  label: string;
}

/** One EIP-1193 request to the wallet and what the wallet answered (a result, or an error it threw). */
export interface WalletCall {
  method: string;
  params: unknown;
  result?: unknown;
  error?: { code?: number; message: string };
  /** createRecorder: when the wallet answered, in one sequence with the RPC calls and the marks. */
  seq?: number;
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

/**
 * Wrap an EIP-1193 provider so every request is recorded as a WalletCall, in the order the requests were made, with
 * the result or error filled in when it settles.
 */
export function recordingProvider(inner: Eip1193Like): {
  provider: Eip1193Like;
  calls: WalletCall[];
} {
  const calls: WalletCall[] = [];
  const provider: Eip1193Like = {
    async request(args: {
      method: string;
      params?: object | readonly unknown[];
    }): Promise<unknown> {
      const call: WalletCall = { method: args.method, params: args.params ?? [] };
      calls.push(call);
      try {
        call.result = await inner.request(args);
        return call.result;
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        const message = (e as { message?: unknown })?.message;
        call.error = {
          ...(typeof code === "number" ? { code } : {}),
          message: typeof message === "string" ? message : String(e),
        };
        throw e;
      }
    },
  };
  return { provider, calls };
}

/**
 * A fake wallet answering from the transcripts' wallet halves: each request is matched on `[method, params]`, answers
 * are served in recorded order and the last repeats (`strict`: never repeats), and a recorded error is thrown (with
 * its `code`). An unmatched request throws and is listed in `misses`.
 */
export function replayProvider(
  transcripts: RpcTranscript | readonly RpcTranscript[],
  o: {
    /**
     * Serve each recorded answer at most once: a request made more often than it was recorded (a second
     * eth_sendTransaction, say) is a miss instead of a repeat of the last answer.
     */
    strict?: boolean;
  } = {},
): Eip1193Like & { readonly misses: readonly string[] } {
  const answers = new Map<string, WalletCall[]>();
  const served = new Map<string, number>();
  for (const t of Array.isArray(transcripts) ? transcripts : [transcripts as RpcTranscript])
    for (const c of t.wallet ?? []) {
      const k = JSON.stringify([c.method, c.params ?? []]);
      answers.set(k, [...(answers.get(k) ?? []), c]);
    }
  const misses: string[] = [];
  return {
    misses,
    async request(args: {
      method: string;
      params?: object | readonly unknown[];
    }): Promise<unknown> {
      const k = JSON.stringify([args.method, args.params ?? []]);
      const list = answers.get(k);
      if (!list?.length) {
        misses.push(`${args.method} ${JSON.stringify(args.params ?? [])}`);
        throw Object.assign(new Error(`replay: no recorded wallet answer for ${args.method}`), {
          code: 4200,
        });
      }
      const n = served.get(k) ?? 0;
      if (o.strict && n >= list.length) {
        misses.push(
          `${args.method} ${JSON.stringify(args.params ?? [])} (more often than recorded)`,
        );
        throw Object.assign(
          new Error(`replay: ${args.method} was recorded ${list.length} time(s)`),
          { code: 4200 },
        );
      }
      served.set(k, n + 1);
      const c = list[Math.min(n, list.length - 1)] as WalletCall;
      if (c.error)
        throw Object.assign(
          new Error(c.error.message),
          c.error.code !== undefined ? { code: c.error.code } : {},
        );
      return c.result;
    },
  };
}

export type { Replay } from "./replay.js";
export { createRecorder, createReplay } from "./replay.js";
