// SPDX-License-Identifier: MIT
// createReplay: a replay whose head moves only when the recorded event that moved it is served (the client's WebKit
// miss, 2026-11-26). Every recorded answer belongs to the epoch it was recorded in, which is the number of gates (a
// wallet write, an eth_sendRawTransaction, a harness mark) recorded before it. Reads are served from the current
// epoch, in recorded order, repeating the epoch's last answer and never borrowing a later one; what that forgives is
// counted in `extraReads`. Writes stay strict: an unrecorded or repeated write is a miss, and so is a mark that comes
// out of order or never comes (`finish`). A transcript without `seq` is one epoch, as createRpcReplay always was.
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/chain/rpc.ts";
import {
  createRecorder,
  createReplay,
  createRpcReplay,
  type RpcCall,
  type RpcTranscript,
  type WalletCall,
} from "../src/testing/index.ts";

const LATEST = ["latest", false];
const block = (n: number) => ({
  number: `0x${n.toString(16)}`,
  hash: `0x${n.toString(16).padStart(64, "0")}`,
});
const call = (
  seq: number | undefined,
  method: string,
  params: unknown[],
  result: unknown,
): RpcCall => ({
  request: { jsonrpc: "2.0", id: 1, method, params },
  response: { jsonrpc: "2.0", id: 1, result },
  ...(seq !== undefined ? { seq } : {}),
});
const walletCall = (seq: number, method: string, params: unknown, result: unknown): WalletCall => ({
  method,
  params,
  result,
  seq,
});
const transcript = (
  calls: RpcCall[],
  wallet: WalletCall[] = [],
  marks: { seq: number; label: string }[] = [],
): RpcTranscript => ({
  schema: "efs-sdk-rpc-transcript/1",
  case: "test",
  note: "",
  contractsCommit: "",
  ids: {},
  steps: [],
  calls,
  wallet,
  ...(marks.length ? { marks } : {}),
});
const ask = (method: string, params: unknown[]) => ({ jsonrpc: "2.0", id: 7, method, params });
const result = (r: unknown) => (r as { result?: unknown }).result;
const SEND = [{ from: "0x01", to: "0x02", data: "0x" }];

describe("createReplay: the head moves only with the event that moved it", () => {
  // The client's case: Review reads latest once, then Send reads latest and sends; block 83 exists only after it.
  const t = transcript(
    [
      call(1, "eth_getBlockByNumber", LATEST, block(82)),
      call(2, "eth_getBlockByNumber", LATEST, block(82)),
      call(4, "eth_getBlockByNumber", LATEST, block(83)),
    ],
    [walletCall(3, "eth_sendTransaction", SEND, "0xabc")],
  );

  it("an extra read before the send gets the same head again (createRpcReplay would hand it the next one)", async () => {
    const r = createReplay(t);
    const heads = [1, 2, 3].map(() => result(r.answer(ask("eth_getBlockByNumber", LATEST))));
    expect(heads).toEqual([block(82), block(82), block(82)]);
    expect(await r.provider.request({ method: "eth_sendTransaction", params: SEND })).toBe("0xabc");
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(83));
    expect(r.finish()).toEqual([]);
    expect(Object.values(r.extraReads)).toEqual([1]); // the one read served by repetition, counted
    // The old replay serves repeats in recorded order: the third read borrows block 83 before the send.
    const old = createRpcReplay(t);
    const oldHeads = [1, 2, 3].map(() => result(old.answer(ask("eth_getBlockByNumber", LATEST))));
    expect(oldHeads[2]).toEqual(block(83));
  });

  it("answers left from an earlier epoch are skipped once the head moves: never a stale head after the write", async () => {
    const r = createReplay(t);
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(82)); // one of the two recorded
    await r.provider.request({ method: "eth_sendTransaction", params: SEND });
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(83));
  });

  it("writes stay strict: a second send of a recorded write in the same epoch is a miss, never a repeat", async () => {
    const r = createReplay(t);
    await r.provider.request({ method: "eth_sendTransaction", params: SEND });
    await expect(
      r.provider.request({ method: "eth_sendTransaction", params: SEND }),
    ).rejects.toThrow();
    expect(r.misses.some((m) => m.startsWith("eth_sendTransaction"))).toBe(true);
  });

  it("an unrecorded or repeated eth_sendRawTransaction is a miss", () => {
    const raw = transcript([
      call(1, "eth_getBlockByNumber", LATEST, block(5)),
      call(2, "eth_sendRawTransaction", ["0xdead"], "0x01"),
      call(3, "eth_getBlockByNumber", LATEST, block(6)),
    ]);
    const r = createReplay(raw);
    expect(
      (r.answer(ask("eth_sendRawTransaction", ["0xbeef"])) as { error?: unknown }).error,
    ).toBeDefined();
    expect(result(r.answer(ask("eth_sendRawTransaction", ["0xdead"])))).toBe("0x01");
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(6));
    expect(
      (r.answer(ask("eth_sendRawTransaction", ["0xdead"])) as { error?: unknown }).error,
    ).toBeDefined();
    expect(r.misses.length).toBe(2);
  });
});

describe("marks: head moves the page doesn't make", () => {
  const t = transcript(
    [
      call(1, "eth_getBlockByNumber", LATEST, block(10)),
      call(3, "eth_getBlockByNumber", LATEST, block(11)),
      call(5, "eth_getBlockByNumber", ["finalized", false], block(1)),
      call(7, "eth_getBlockByNumber", ["finalized", false], block(65)),
    ],
    [],
    [
      { seq: 2, label: "actor" },
      { seq: 6, label: "mine 64" },
    ],
  );

  it("a marked actor write moves the head when the replay is marked, not before", () => {
    const r = createReplay(t);
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(10));
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(10));
    r.mark("actor");
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(11));
  });

  it("finalized follows the epochs: the new finalized block only after the mark", () => {
    const r = createReplay(t);
    r.mark("actor");
    expect(result(r.answer(ask("eth_getBlockByNumber", ["finalized", false])))).toEqual(block(1));
    expect(result(r.answer(ask("eth_getBlockByNumber", ["finalized", false])))).toEqual(block(1));
    r.mark("mine 64");
    expect(result(r.answer(ask("eth_getBlockByNumber", ["finalized", false])))).toEqual(block(65));
    expect(r.finish()).toEqual([]);
  });

  it("a mark out of order is a miss, and so is a mark that never comes (finish)", () => {
    const r = createReplay(t);
    r.mark("mine 64");
    expect(r.misses.some((m) => m.includes("mine 64"))).toBe(true);
    const s = createReplay(t);
    s.mark("actor");
    expect(s.finish().some((m) => m.includes("mine 64"))).toBe(true);
  });

  it("a pending transaction: its receipt is null for as long as the replay is before the mark that mined it", () => {
    const pending = transcript(
      [
        call(1, "eth_getTransactionReceipt", ["0xaa"], null),
        call(3, "eth_getTransactionReceipt", ["0xaa"], { blockNumber: "0x2", status: "0x1" }),
      ],
      [],
      [{ seq: 2, label: "mine 1" }],
    );
    const r = createReplay(pending);
    for (let i = 0; i < 5; i++)
      expect(result(r.answer(ask("eth_getTransactionReceipt", ["0xaa"])))).toBeNull();
    r.mark("mine 1");
    expect(result(r.answer(ask("eth_getTransactionReceipt", ["0xaa"])))).toMatchObject({
      status: "0x1",
    });
  });
});

describe("compatibility and the recorder", () => {
  it("a transcript without seq replays as createRpcReplay does", () => {
    const t = transcript([
      call(undefined, "eth_getBlockByNumber", LATEST, block(1)),
      call(undefined, "eth_getBlockByNumber", LATEST, block(2)),
      call(undefined, "eth_chainId", [], "0x7a69"),
    ]);
    const a = createReplay(t);
    const b = createRpcReplay(t);
    const seq = [
      "eth_getBlockByNumber",
      "eth_getBlockByNumber",
      "eth_getBlockByNumber",
      "eth_chainId",
    ];
    for (const m of seq) {
      const params = m === "eth_chainId" ? [] : LATEST;
      expect(result(a.answer(ask(m, params)))).toEqual(result(b.answer(ask(m, params))));
    }
  });

  it("createRecorder numbers both halves and the marks in one sequence, in completion order", async () => {
    let head = 1;
    const inner: FetchLike = async (_url, init) => {
      const req = JSON.parse(init.body as string);
      const body = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: block(head) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
      };
    };
    const wallet = {
      async request(_a: { method: string; params?: unknown }) {
        head++;
        return "0xabc";
      },
    };
    const rec = createRecorder(inner, wallet);
    const post = (r: unknown) =>
      rec.fetch("http://x", { method: "POST", body: JSON.stringify(r) } as never);
    await post(ask("eth_getBlockByNumber", LATEST));
    await rec.provider?.request({ method: "eth_sendTransaction", params: SEND });
    rec.mark("actor");
    await post(ask("eth_getBlockByNumber", LATEST));
    const t = rec.transcript({ case: "rec", note: "", contractsCommit: "", ids: {}, steps: [] });
    expect(t.calls.map((c) => c.seq)).toEqual([1, 4]);
    expect(t.wallet?.map((c) => c.seq)).toEqual([2]);
    expect(t.marks).toEqual([{ seq: 3, label: "actor" }]);
    // And it replays: the send, then the mark, move the head.
    const r = createReplay(t);
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(1));
    await r.provider.request({ method: "eth_sendTransaction", params: SEND });
    r.mark("actor");
    expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(2));
    expect(r.finish()).toEqual([]);
  });

  it("40 runs with random extra reads between steps: no misses, and every head is its epoch's", async () => {
    const t = transcript(
      [
        call(1, "eth_getBlockByNumber", LATEST, block(1)),
        call(3, "eth_getBlockByNumber", LATEST, block(2)),
        call(5, "eth_getBlockByNumber", LATEST, block(3)),
      ],
      [walletCall(2, "eth_sendTransaction", SEND, "0x1")],
      [{ seq: 4, label: "actor" }],
    );
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % 4;
    };
    for (let run = 0; run < 40; run++) {
      const r = createReplay(t);
      const read = (want: number) => {
        for (let i = 0; i <= rand(); i++)
          expect(result(r.answer(ask("eth_getBlockByNumber", LATEST)))).toEqual(block(want));
      };
      read(1);
      await r.provider.request({ method: "eth_sendTransaction", params: SEND });
      read(2);
      r.mark("actor");
      read(3);
      expect(r.finish()).toEqual([]);
    }
  });
});
