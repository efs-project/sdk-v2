// SPDX-License-Identifier: MIT
// JSON-RPC ports: plain HTTP (with batching) or any EIP-1193 provider. A port never throws for an expected failure;
// it returns an RpcOutcome so callers can record the attempt and fail over.
import { type AbortSignalLike, type Reason, reason, throwIfAborted } from "../core/errors.js";
import { clearTimer, setTimer } from "../core/platform.js";

export interface Eip1193Like {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
  on?(
    event: "accountsChanged" | "chainChanged" | "disconnect",
    listener: (...a: unknown[]) => void,
  ): unknown;
  removeListener?(event: string, listener: (...a: unknown[]) => void): unknown;
}

/** Structural fetch, so the portable core needs no DOM or Node types. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: unknown;
    redirect?: "follow" | "error" | "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: unknown;
}>;

export type RpcEndpoint =
  | string
  | { url: string; label?: string }
  | { provider: Eip1193Like; label?: string };

export interface RpcRequest {
  method: string;
  params: readonly unknown[];
}
export type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; kind: "transport"; reason: Reason } // retry elsewhere
  | { ok: false; kind: "rpc"; code: number; message: string; data?: unknown; reason: Reason }; // the node answered

export interface RequestEvent {
  endpoint: string;
  methods: readonly string[];
  batched: boolean;
}

export interface RpcPort {
  /** Label or origin, never a URL with a path or query (those often carry API keys). */
  readonly label: string;
  send(
    requests: readonly RpcRequest[],
    o: { signal?: AbortSignalLike; timeoutMs: number },
  ): Promise<RpcOutcome[]>;
}

/** The scheme and host of a URL, with any user:password removed. */
export function endpointOrigin(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)/i.exec(url);
  return m ? `${(m[1] as string).toLowerCase()}${(m[2] as string).toLowerCase()}` : "rpc";
}

let nextId = 1;
const rpcError = (code: number, message: string, data: unknown): RpcOutcome => ({
  ok: false,
  kind: "rpc",
  code,
  message,
  data,
  reason: reason(
    "RPC_ERROR",
    code === -32005 || code === 429 ? "transient" : "never",
    `${code} ${message}`,
  ),
});
const transport = (detail: string): RpcOutcome => ({
  ok: false,
  kind: "transport",
  reason: reason("RPC_UNAVAILABLE", "transient", detail),
});

/** Run `work` with a timeout and the caller's signal; resolves to a transport failure on timeout. */
async function bounded<T>(
  work: (signal: AbortSignalLike | undefined) => Promise<T>,
  o: { signal?: AbortSignalLike; timeoutMs: number },
  onTimeout: () => T,
): Promise<T> {
  throwIfAborted(o.signal);
  const Ctl = (
    globalThis as {
      AbortController?: new () => { signal: AbortSignalLike; abort(r?: unknown): void };
    }
  ).AbortController;
  const ctl = Ctl ? new Ctl() : undefined;
  const forward = (): void => ctl?.abort(o.signal?.reason);
  o.signal?.addEventListener("abort", forward, { once: true });
  let timer: unknown;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimer(() => {
      ctl?.abort(new Error("timeout"));
      resolve(onTimeout());
    }, o.timeoutMs);
  });
  try {
    return await Promise.race([work(ctl?.signal), timeout]);
  } finally {
    clearTimer(timer);
    o.signal?.removeEventListener("abort", forward);
    throwIfAborted(o.signal);
  }
}

export function httpPort(
  url: string,
  o: { label?: string; fetch?: FetchLike; onRequest?: (e: RequestEvent) => void },
): RpcPort {
  const label = o.label ?? endpointOrigin(url);
  return {
    label,
    async send(requests, call) {
      const fetchImpl = o.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
      if (!fetchImpl) return requests.map(() => transport("no fetch implementation available"));
      o.onRequest?.({
        endpoint: label,
        methods: requests.map((r) => r.method),
        batched: requests.length > 1,
      });
      const ids = requests.map(() => nextId++);
      const body = requests.map((r, i) => ({
        jsonrpc: "2.0",
        id: ids[i],
        method: r.method,
        params: r.params,
      }));
      return bounded(
        async (signal) => {
          let text: string;
          try {
            const res = await fetchImpl(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(requests.length === 1 ? body[0] : body),
              signal,
            });
            if (res.status === 429)
              return requests.map(() => rpcError(429, "rate limited", undefined));
            if (!res.ok) return requests.map(() => transport(`HTTP ${res.status}`));
            text = await res.text();
          } catch (e) {
            if (call.signal?.aborted) throw e;
            return requests.map(() => transport(e instanceof Error ? e.message : "fetch failed"));
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return requests.map(() => transport("malformed JSON-RPC response"));
          }
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const byId = new Map<
            number,
            { result?: unknown; error?: { code: number; message: string; data?: unknown } }
          >();
          for (const item of list)
            if (item && typeof item === "object" && "id" in item) byId.set(item.id as number, item);
          return ids.map((id) => {
            const item = byId.get(id);
            if (!item) return transport("missing JSON-RPC response item");
            if (item.error) return rpcError(item.error.code, item.error.message, item.error.data);
            return { ok: true, result: item.result };
          });
        },
        call,
        () => requests.map(() => transport(`timeout after ${call.timeoutMs} ms`)),
      );
    },
  };
}

export function eip1193Port(
  provider: Eip1193Like,
  o: { label?: string; onRequest?: (e: RequestEvent) => void },
): RpcPort {
  const label = o.label ?? "provider";
  return {
    label,
    async send(requests, call) {
      o.onRequest?.({ endpoint: label, methods: requests.map((r) => r.method), batched: false });
      return Promise.all(
        requests.map((r) =>
          bounded(
            async () => {
              try {
                return {
                  ok: true,
                  result: await provider.request({ method: r.method, params: r.params }),
                } as RpcOutcome;
              } catch (e) {
                if (call.signal?.aborted) throw e;
                const err = e as { code?: unknown; message?: unknown; data?: unknown };
                if (typeof err?.code === "number")
                  return rpcError(err.code, String(err.message ?? ""), err.data);
                return transport(e instanceof Error ? e.message : "provider request failed");
              }
            },
            call,
            () => transport(`timeout after ${call.timeoutMs} ms`),
          ),
        ),
      );
    },
  };
}

export function toPort(
  endpoint: RpcEndpoint,
  o: { fetch?: FetchLike; onRequest?: (e: RequestEvent) => void },
): RpcPort {
  if (typeof endpoint === "string") return httpPort(endpoint, o);
  if ("url" in endpoint)
    return httpPort(endpoint.url, { ...o, ...(endpoint.label ? { label: endpoint.label } : {}) });
  return eip1193Port(endpoint.provider, {
    ...o,
    ...(endpoint.label ? { label: endpoint.label } : {}),
  });
}
