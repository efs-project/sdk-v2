// SPDX-License-Identifier: MIT
// A recorder and a replay whose chain head moves only with the recorded event that moved it.
//
// createRecorder numbers the RPC calls, the wallet calls and the harness's marks in one sequence (when each answer
// came back). In the transcript a gate is an event that can move the head: a wallet write (eth_sendTransaction,
// wallet_sendCalls), an eth_sendRawTransaction, or a mark (a head move the page didn't make, such as an actor's write
// or a mine). Every recorded answer belongs to the epoch it was recorded in: the number of gates recorded before it.
//
// createReplay serves a read from the current epoch: the answers its key was given in that epoch, in recorded order,
// then the epoch's last answer again. So a page that reads "latest" more often than the recording did gets the same
// head again, never the one a later write produced. A key with no answer yet in this epoch gets its latest earlier
// one; a key recorded only later gets its first (an early read). Both are forgiven and counted in `extraReads`.
// Writes stay strict: each gate is served once, in recorded order, and the next gate moves the epoch on. An
// unrecorded write, a repeated one, or a mark out of order is a miss, and so is a gate never served (`finish`).
// A transcript without `seq` is one epoch with no gates: its reads replay as createRpcReplay always did.
import type { Eip1193Like, FetchLike } from "../chain/rpc.js";
import { utf8Encode } from "../core/platform.js";
import type { RecordedMark, RpcCall, RpcTranscript, WalletCall } from "./index.js";

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
type Answer = Omit<JsonRpcResponse, "id" | "jsonrpc">;

const keyOf = (method: string, params: unknown): string => JSON.stringify([method, params ?? []]);
const items = <T>(body: unknown): T[] => (Array.isArray(body) ? (body as T[]) : [body as T]);
const WALLET_WRITES = new Set(["eth_sendTransaction", "wallet_sendCalls"]);
const RPC_WRITES = new Set(["eth_sendRawTransaction"]);

/** A short, stable digest of a call's params (FNV-1a, 32 bits), for `extraReads` keys. */
const digest = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

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

/**
 * Record the RPC half (a fetch) and, optionally, the wallet half of a flow, numbering every answer and every mark
 * in one sequence. `transcript(meta)` gives an efs-sdk-rpc-transcript/1 with `seq` and `marks`.
 */
export function createRecorder(
  inner: FetchLike,
  wallet?: Eip1193Like,
): {
  fetch: FetchLike;
  provider: Eip1193Like | undefined;
  calls: RpcCall[];
  wallet: WalletCall[];
  marks: RecordedMark[];
  /** A head move the page didn't make (an actor's write, a mine): call it right after, in record and replay alike. */
  mark(label: string): void;
  transcript(meta: Omit<RpcTranscript, "schema" | "calls" | "wallet" | "marks">): RpcTranscript;
} {
  let seq = 0;
  const calls: RpcCall[] = [];
  const walletCalls: WalletCall[] = [];
  const marks: RecordedMark[] = [];
  const fetch: FetchLike = async (url, init) => {
    const res = await inner(url, init);
    if (init.method !== "POST" || init.body === undefined) return res;
    const text = await res.text();
    try {
      calls.push({ request: JSON.parse(init.body), response: JSON.parse(text), seq: ++seq });
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
  const provider: Eip1193Like | undefined = wallet
    ? {
        async request(args: { method: string; params?: object | readonly unknown[] }) {
          const call: WalletCall = { method: args.method, params: args.params ?? [] };
          try {
            call.result = await wallet.request(args);
            return call.result;
          } catch (e) {
            const code = (e as { code?: unknown })?.code;
            const message = (e as { message?: unknown })?.message;
            call.error = {
              ...(typeof code === "number" ? { code } : {}),
              message: typeof message === "string" ? message : String(e),
            };
            throw e;
          } finally {
            call.seq = ++seq;
            walletCalls.push(call);
          }
        },
      }
    : undefined;
  return {
    fetch,
    provider,
    calls,
    wallet: walletCalls,
    marks,
    mark: (label) => {
      marks.push({ seq: ++seq, label });
    },
    transcript: (meta) => ({
      schema: "efs-sdk-rpc-transcript/1",
      ...meta,
      calls: [...calls],
      wallet: [...walletCalls],
      ...(marks.length ? { marks: [...marks] } : {}),
    }),
  };
}

export interface Replay {
  /** A fetch answering JSON-RPC POSTs (any URL); everything else is a 404. */
  fetch: FetchLike;
  /** Answer one request body (object or batch) as a node would. */
  answer(body: unknown): unknown;
  /** The wallet half: writes are strict, reads follow the epochs. */
  provider: Eip1193Like;
  /** The harness's mark: must be the next recorded gate, with the same label. */
  mark(label: string): void;
  /** Every miss: an unrecorded call, an unrecorded or repeated write, a mark out of order. */
  readonly misses: readonly string[];
  /** Reads forgiven, by `method params-digest`: served again from their epoch, or early from a later one. */
  readonly extraReads: Readonly<Record<string, number>>;
  /** The epoch the replay is in (gates served so far). */
  readonly epoch: number;
  /** End of the flow: every recorded gate never served becomes a miss. Returns all misses. */
  finish(): readonly string[];
}

type Gate = { kind: "rpc" | "wallet" | "mark"; key: string; answer: Answer | WalletCall };

/** Replay transcripts with the head gated by their writes and marks (see the header). */
export function createReplay(transcripts: RpcTranscript | readonly RpcTranscript[]): Replay {
  const list: readonly RpcTranscript[] = Array.isArray(transcripts)
    ? (transcripts as readonly RpcTranscript[])
    : [transcripts as RpcTranscript];
  const gates: Gate[] = [];
  // key → epoch → answers in recorded order (RPC reads and wallet reads alike).
  const reads = new Map<string, Map<number, (Answer | WalletCall)[]>>();
  const add = (key: string, epoch: number, a: Answer | WalletCall) => {
    const byEpoch = reads.get(key) ?? new Map<number, (Answer | WalletCall)[]>();
    byEpoch.set(epoch, [...(byEpoch.get(epoch) ?? []), a]);
    reads.set(key, byEpoch);
  };
  for (const t of list) {
    type Ev =
      | { seq: number; kind: "rpc"; req: JsonRpcRequest; res: Answer }
      | { seq: number; kind: "wallet"; call: WalletCall }
      | { seq: number; kind: "mark"; label: string };
    const events: Ev[] = [];
    // Without seq, everything keeps its place in its own list: one epoch, no gates.
    const timed = t.calls.some((c) => c.seq !== undefined);
    t.calls.forEach((c, i) => {
      const byId = new Map(
        items<JsonRpcResponse>(c.response).map((r) => [JSON.stringify(r.id), r]),
      );
      for (const req of items<JsonRpcRequest>(c.request)) {
        const res = byId.get(JSON.stringify(req.id));
        if (!res) continue;
        events.push({
          seq: c.seq ?? i,
          kind: "rpc",
          req,
          res: res.error ? { error: res.error } : { result: res.result },
        });
      }
    });
    (t.wallet ?? []).forEach((c, i) => {
      events.push({ seq: c.seq ?? i, kind: "wallet", call: c });
    });
    for (const m of t.marks ?? []) events.push({ seq: m.seq, kind: "mark", label: m.label });
    if (timed) events.sort((a, b) => a.seq - b.seq);
    for (const e of events) {
      const epoch = timed ? gates.length : 0;
      if (e.kind === "mark") {
        if (timed) gates.push({ kind: "mark", key: e.label, answer: { result: null } });
      } else if (e.kind === "wallet") {
        const key = keyOf(e.call.method, e.call.params);
        if (timed && WALLET_WRITES.has(e.call.method))
          gates.push({ kind: "wallet", key, answer: e.call });
        else add(`wallet:${key}`, epoch, e.call);
      } else {
        const key = keyOf(e.req.method, e.req.params);
        if (timed && RPC_WRITES.has(e.req.method)) gates.push({ kind: "rpc", key, answer: e.res });
        else add(`rpc:${key}`, epoch, e.res);
      }
    }
  }

  let epoch = 0;
  const served = new Map<string, number>();
  const misses: string[] = [];
  const extraReads: Record<string, number> = {};
  const forgive = (method: string, params: unknown) => {
    const k = `${method} ${digest(JSON.stringify(params ?? []))}`;
    extraReads[k] = (extraReads[k] ?? 0) + 1;
  };
  /** A read's answer at the current epoch, or undefined when the key was never recorded. */
  const read = (key: string, method: string, params: unknown): Answer | WalletCall | undefined => {
    const byEpoch = reads.get(key);
    if (!byEpoch) return undefined;
    const epochs = [...byEpoch.keys()].sort((a, b) => a - b);
    const at = epochs.filter((e) => e <= epoch).pop();
    if (at === undefined) {
      forgive(method, params); // asked before the epoch it was recorded in
      return (byEpoch.get(epochs[0] as number) as (Answer | WalletCall)[])[0];
    }
    const answers = byEpoch.get(at) as (Answer | WalletCall)[];
    const slot = `${key}@${at}`;
    const n = served.get(slot) ?? 0;
    served.set(slot, n + 1);
    if (n >= answers.length) forgive(method, params);
    return answers[Math.min(n, answers.length - 1)];
  };
  /** The next gate, if it is this one: served, and the epoch moves on. */
  const gate = (kind: Gate["kind"], key: string): Gate | undefined => {
    const next = gates[epoch];
    if (next && next.kind === kind && next.key === key) {
      epoch++;
      return next;
    }
    return undefined;
  };

  const answer = (body: unknown): unknown => {
    const out = items<JsonRpcRequest>(body).map((req): JsonRpcResponse => {
      const key = keyOf(req.method, req.params);
      const fail = (why: string): JsonRpcResponse => {
        misses.push(`${req.method} ${JSON.stringify(req.params ?? [])}${why}`);
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: { code: -32601, message: `replay: no recorded answer for ${req.method}${why}` },
        };
      };
      if (RPC_WRITES.has(req.method) && gates.length > 0) {
        const g = gate("rpc", key);
        if (!g) return fail(" (a write that is not the next recorded one)");
        return { jsonrpc: "2.0", id: req.id ?? null, ...(g.answer as Answer) };
      }
      const a = read(`rpc:${key}`, req.method, req.params);
      if (!a) return fail("");
      return { jsonrpc: "2.0", id: req.id ?? null, ...(a as Answer) };
    });
    return Array.isArray(body) ? out : out[0];
  };

  const provider: Eip1193Like = {
    async request(args: { method: string; params?: object | readonly unknown[] }) {
      const key = keyOf(args.method, args.params);
      const miss = (why: string) => {
        misses.push(`${args.method} ${JSON.stringify(args.params ?? [])}${why}`);
        return Object.assign(
          new Error(`replay: no recorded wallet answer for ${args.method}${why}`),
          {
            code: 4200,
          },
        );
      };
      let c: WalletCall | undefined;
      if (WALLET_WRITES.has(args.method) && gates.length > 0) {
        const g = gate("wallet", key);
        if (!g) throw miss(" (a write that is not the next recorded one)");
        c = g.answer as WalletCall;
      } else {
        c = read(`wallet:${key}`, args.method, args.params) as WalletCall | undefined;
        if (!c) throw miss("");
      }
      if (c.error)
        throw Object.assign(
          new Error(c.error.message),
          c.error.code !== undefined ? { code: c.error.code } : {},
        );
      return c.result;
    },
  };

  const fetch = (async (_url, init) => {
    if (init.method !== "POST" || init.body === undefined) return respond(404, "");
    return respond(200, JSON.stringify(answer(JSON.parse(init.body))));
  }) as FetchLike;

  return {
    fetch,
    answer,
    provider,
    mark(label) {
      if (!gate("mark", label))
        misses.push(`mark ${JSON.stringify(label)} (not the next recorded gate)`);
    },
    misses,
    extraReads,
    get epoch() {
      return epoch;
    },
    finish() {
      for (const g of gates.slice(epoch))
        misses.push(`never served: ${g.kind === "mark" ? `mark ${JSON.stringify(g.key)}` : g.key}`);
      epoch = gates.length;
      return misses;
    },
  };
}
