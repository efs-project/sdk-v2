// SPDX-License-Identifier: MIT
// Resumable split saves on a real chain: COMPLETE is the only success, PARTIAL resumes after a reload, settling
// never needs the wallet, and an atomic EIP-5792 wallet takes every part under one approval.
import { readFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import {
  createWriter,
  type Journal,
  memoryJournal,
  type SequenceEvent,
  type SequenceProgress,
} from "../../src/actions/index.ts";
import type { Eip1193Like } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import { EfsFault } from "../../src/core/errors.ts";
import type { Hex } from "../../src/core/hex.ts";
import { putInline } from "./recipes.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex } };
};
const docs = deployment.seed.folder.directoryRecordId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const dave = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
); // anvil #3 (no other test file uses it)
const ERIN = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65" as Hex; // anvil #4 (unlocked on the fixture)
const FRANK = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Hex; // anvil #5 (unlocked)

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
  return j.result;
}

/**
 * A wallet over anvil's unlocked account. Knobs: refuse the n-th send, lose a response, speak EIP-5792, switch to
 * another account after the first send, or hold the first send back (signed, its hash returned, broadcast later by
 * the test from `held`). `account` can be set to switch accounts by hand.
 */
function wallet(
  account: Hex,
  k: {
    refuseSend?: number;
    loseFirst?: boolean;
    atomic5792?: boolean;
    refuseBatch?: boolean;
    /** wallet_sendCalls fails with this EIP-1193 code. */
    batchFailWith?: number;
    dead?: boolean;
    switchAfterFirstSend?: Hex;
    holdFirst?: boolean;
    /** Runs once the first send has gone out (e.g. the journal dies, or the person aborts). */
    afterFirstSend?: () => void;
  } = {},
) {
  const w = {
    sends: 0,
    batches: 0,
    account,
    held: [] as Hex[],
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      if (k.dead) throw new Error("wallet must not be used");
      if (method === "eth_accounts") return [w.account];
      if (method === "eth_sendTransaction") {
        w.sends++;
        if (k.refuseSend === w.sends)
          throw Object.assign(new Error("User rejected"), { code: 4001 });
        if (k.holdFirst && w.sends === 1) {
          const raw = (await rpc("eth_signTransaction", params as unknown[])) as Hex;
          w.held.push(raw);
          return keccak256(raw);
        }
        const hash = await rpc(method, params as unknown[]);
        if (k.loseFirst && w.sends === 1) throw new Error("connection lost");
        if (k.switchAfterFirstSend && w.sends === 1) w.account = k.switchAfterFirstSend;
        if (w.sends === 1) k.afterFirstSend?.();
        return hash;
      }
      if (method === "wallet_getCapabilities") {
        if (!k.atomic5792) throw Object.assign(new Error("method not found"), { code: -32601 });
        const id = (params as [string, string[]])[1][0] as string;
        return { [id]: { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") {
        w.batches++;
        if (k.refuseBatch) throw Object.assign(new Error("User rejected"), { code: 4001 });
        if (k.batchFailWith !== undefined)
          throw Object.assign(new Error("wallet error"), { code: k.batchFailWith });
        const req = (params as [{ from: string; calls: { to: string; data: string }[] }])[0];
        // A real wallet sequences its own transaction nonces; on anvil, wait for each call to be mined before the
        // next, or back-to-back sends share one pending nonce and only one of them is ever mined.
        for (const c of req.calls) {
          const hash = await rpc("eth_sendTransaction", [
            { from: req.from, to: c.to, data: c.data },
          ]);
          for (let t = 0; t < 100 && !(await rpc("eth_getTransactionReceipt", [hash])); t++)
            await new Promise((r) => setTimeout(r, 20));
        }
        if (w.batches === 1) k.afterFirstSend?.(); // every call above has gone out
        return { id: `batch-${w.batches}` };
      }
      if (method === "wallet_getCallsStatus") return { status: 200 };
      return rpc(method, (params as unknown[]) ?? []);
    },
  };
  return w as Eip1193Like & { sends: number; batches: number; account: Hex; held: Hex[] };
}

/**
 * An onProgress that records each event as [kind, parts|index, committed, current stage], then throws (or, with
 * `rejects`, is async and rejects): neither may break the save.
 */
function progressLog(k: { rejects?: boolean } = {}) {
  const seen: unknown[][] = [];
  const record = (p: SequenceProgress, e: SequenceEvent): void => {
    seen.push([
      e.kind,
      e.kind === "wallet-request" ? e.parts : e.index,
      p.committed,
      p.current?.stage ?? null,
    ]);
  };
  const onProgress = k.rejects
    ? async (p: SequenceProgress, e: SequenceEvent): Promise<void> => {
        record(p, e);
        throw new Error("an async UI callback that rejects must not break the save");
      }
    : (p: SequenceProgress, e: SequenceEvent): void => {
        record(p, e);
        throw new Error("a UI callback that throws must not break the save");
      };
  return { seen, onProgress };
}

const parts = (principal: Hex, tag: string, n = 3) =>
  Array.from({ length: n }, (_, i) =>
    putInline(
      efs,
      principal,
      docs,
      `${tag}-${i}.txt`,
      new TextEncoder().encode(`${tag} ${i}`),
      keccak256(toHex(`${tag}-${i}`)),
    ),
  );

describe("runSequence (fixture)", () => {
  it("a local account carries a 3-part save to COMPLETE, part by part", async () => {
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: dave },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-local"));
    expect(r).toMatchObject({ state: "COMPLETE", total: 3, committed: 3, mode: "sequential" });
    expect(r.current).toBeUndefined();
    // COMPLETE but not yet final: still listed ("Saved · confirming") until a finalized block confirms it. Other test
    // files mine blocks on this shared chain, so the save may already be final, and then it is no longer listed.
    expect((await w.pendingSequences()).map((x) => [x.state, x.final])).toEqual(
      r.final ? [] : [["COMPLETE", false]],
    );
  });

  it("a refusal at part 2 is PARTIAL (1 of 3); a reload resumes it to COMPLETE with fresh nonces", async () => {
    const journal = memoryJournal();
    const refusing = wallet(ERIN, { refuseSend: 2 });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: refusing },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-partial"));
    expect(r).toMatchObject({
      state: "PARTIAL",
      total: 3,
      committed: 1,
      reason: { code: "USER_REJECTED", retry: "transient" }, // the plan is still good: Continue is the person's call
    });
    expect(r.current).toMatchObject({ index: 1, stage: "NOT_PLANNED" }); // the refused part is planned again later
    // "Reload": a new writer over the same journal sees "1 of 3 saved — Continue".
    const good = wallet(ERIN);
    const again = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: good },
      journal,
    });
    const [open] = await again.pendingSequences();
    expect(open).toMatchObject({
      sequenceId: r.sequenceId,
      state: "PARTIAL",
      committed: 1,
      total: 3,
    });
    const done = await again.resume(r.sequenceId);
    expect(done).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(good.sends).toBe(2);
    expect((await again.pendingSequences()).map((x) => [x.state, x.final])).toEqual(
      done.final ? [] : [["COMPLETE", false]],
    );
  });

  it("onProgress: a wallet request before each part, a commit after it; a throwing callback changes nothing", async () => {
    const log = progressLog();
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(ERIN), account: ERIN },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-progress"), {
      onProgress: log.onProgress,
      pollMs: 50,
    });
    expect(r).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(log.seen).toEqual([
      ["wallet-request", [0], 0, "SUBMISSION_POSSIBLE"],
      ["committed", 0, 1, "NOT_PLANNED"],
      ["wallet-request", [1], 1, "SUBMISSION_POSSIBLE"],
      ["committed", 1, 2, "NOT_PLANNED"],
      ["wallet-request", [2], 2, "SUBMISSION_POSSIBLE"],
      ["committed", 2, 3, null],
    ]);
  });

  it("onProgress: one wallet request for an atomic batch; none for a local account", async () => {
    const batched = progressLog({ rejects: true });
    const w = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(ERIN, { atomic5792: true }),
        account: ERIN,
      },
      journal: memoryJournal(),
    });
    expect(
      await w.runSequence(parts(w.principal, "seq-progress-batch"), {
        onProgress: batched.onProgress,
        pollMs: 50,
      }),
    ).toMatchObject({ state: "COMPLETE", mode: "batch" });
    expect(batched.seen.map(([k, x]) => [k, x])).toEqual([
      ["wallet-request", [0, 1, 2]],
      ["committed", 0],
      ["committed", 1],
      ["committed", 2],
    ]);
    const local = progressLog();
    const l = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: dave },
      journal: memoryJournal(),
    });
    expect(
      await l.runSequence(parts(l.principal, "seq-progress-local", 2), {
        onProgress: local.onProgress,
      }),
    ).toMatchObject({ state: "COMPLETE" });
    expect(local.seen.map(([k, x]) => [k, x])).toEqual([
      ["committed", 0],
      ["committed", 1],
    ]);
  });

  it("a lost response is settled from the ledger and never sent twice", async () => {
    const lossy = wallet(FRANK, { loseFirst: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: lossy },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-lossy"), { pollMs: 50 });
    expect(r).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(lossy.sends).toBe(3);
  });

  it("a wallet that switches account mid-save sends nothing more; switching back continues it", async () => {
    const journal = memoryJournal();
    const switching = wallet(ERIN, { switchAfterFirstSend: FRANK });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: switching, account: ERIN },
      journal,
    });
    const before = Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]));
    const log = progressLog();
    const r = await w.runSequence(parts(w.principal, "seq-switch"), { onProgress: log.onProgress });
    // The moved wallet is never asked: one wallet request, for part 1 only.
    expect(log.seen.map(([k, x]) => [k, x])).toEqual([
      ["wallet-request", [0]],
      ["committed", 0],
    ]);
    expect(r).toMatchObject({
      state: "PARTIAL",
      total: 3,
      committed: 1,
      reason: {
        code: "WALLET_MISMATCH",
        retry: "transient",
        wallet: {
          expected: { chainId: 31337, account: ERIN },
          actual: { chainId: 31337, account: FRANK },
        },
      },
    });
    expect(r.current).toMatchObject({ index: 1, stage: "NOT_PLANNED" });
    // Nothing more was broadcast once the account moved: one wallet send, one transaction on chain.
    expect(switching.sends).toBe(1);
    expect(Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]))).toBe(before + 1);
    // The journal is intact: a reload still offers "1 of 3 saved — Continue".
    const again = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: switching, account: ERIN },
      journal,
    });
    expect(await again.pendingSequences()).toMatchObject([
      { sequenceId: r.sequenceId, state: "PARTIAL", committed: 1, total: 3 },
    ]);
    switching.account = ERIN; // the person switches back, then Continue
    expect(await again.resume(r.sequenceId)).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect(switching.sends).toBe(3);
    expect(Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]))).toBe(before + 3);
  });

  it("a receipt that arrives after settleMs leaves the part in flight, never failed; it commits once", async () => {
    const journal = memoryJournal();
    const slow = wallet(ERIN, { holdFirst: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: slow, account: ERIN },
      journal,
    });
    const before = Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]));
    const t0 = Date.now();
    const r = await w.runSequence(parts(w.principal, "seq-slow", 2), { settleMs: 300, pollMs: 50 });
    expect(Date.now() - t0).toBeLessThan(15_000); // bounded by settleMs, not a fixed 60 s receipt wait
    expect(r).toMatchObject({
      state: "IN_FLIGHT",
      committed: 0,
      reason: { code: "NOT_YET_DECIDABLE", retry: "after-reconcile" },
    });
    expect(r.current).toMatchObject({ index: 0, stage: "SUBMITTED" });
    expect(slow.sends).toBe(1); // part 2 waits for part 1: nothing else was sent
    // Unknown is not absence: settling from the ledger alone keeps it in flight, and lists it.
    expect(await w.reconcileSequence(r.sequenceId)).toMatchObject({
      state: "IN_FLIGHT",
      committed: 0,
    });
    expect((await w.pendingSequences()).map((x) => x.state)).toEqual(["IN_FLIGHT"]);
    // The transaction lands late; the ledger then decides the part, and resume sends only part 2.
    const hash = await rpc("eth_sendRawTransaction", [slow.held[0]]);
    for (let t = 0; t < 200 && !(await rpc("eth_getTransactionReceipt", [hash])); t++)
      await new Promise((res) => setTimeout(res, 20));
    expect(await w.reconcileSequence(r.sequenceId)).toMatchObject({
      state: "PARTIAL",
      committed: 1,
    });
    expect(await w.resume(r.sequenceId, { pollMs: 50 })).toMatchObject({
      state: "COMPLETE",
      committed: 2,
    });
    expect(slow.sends).toBe(2);
    expect(Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]))).toBe(before + 2);
  });

  it("the journal dies after the wallet sent: the fault says it may have gone out; a later reconcile commits once", async () => {
    const inner = memoryJournal();
    let broken = false;
    const gone = <T>(f: () => Promise<T>): Promise<T> =>
      broken ? Promise.reject(new EfsFault("JOURNAL_UNAVAILABLE", "IndexedDB went away")) : f();
    const flaky: Journal = {
      durable: inner.durable,
      put: (r) => gone(() => inner.put(r)),
      get: (id) => gone(() => inner.get(id)),
      unresolved: (l) => gone(() => inner.unresolved(l)),
      putSequence: (r) => gone(() => inner.putSequence(r)),
      getSequence: (id) => gone(() => inner.getSequence(id)),
      openSequences: (l) => gone(() => inner.openSequences(l)),
      withLock: (l, wait, fn) => inner.withLock(l, wait, fn),
    };
    // e.g. WebKit drops IndexedDB while the person is in the wallet app; the transaction still commits.
    const dying = wallet(ERIN, {
      afterFirstSend: () => {
        broken = true;
      },
    });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: dying, account: ERIN },
      journal: flaky,
    });
    const before = Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]));
    const fault = await w.runSequence(parts(w.principal, "seq-journal-dies", 1)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(fault).toBeInstanceOf(EfsFault);
    const f = fault as EfsFault;
    expect(f.code).toBe("JOURNAL_UNAVAILABLE");
    expect(f).toMatchObject({ mayHaveSent: true, sequenceMayHaveSent: true });
    expect(f.sequenceId).toMatch(/^0x[0-9a-f]{64}$/);
    // The journal comes back (the next visit): settling from the ledger finds the one transaction, sends nothing.
    broken = false;
    const id = f.sequenceId as Hex;
    expect(await w.reconcileSequence(id)).toMatchObject({ state: "COMPLETE", committed: 1 });
    expect(await w.resume(id)).toMatchObject({ state: "COMPLETE", committed: 1 });
    expect(dying.sends).toBe(1);
    expect(Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]))).toBe(before + 1);
  });

  it("an abort after the wallet sent: the fault says it may have gone out; a later reconcile commits once", async () => {
    const ctl = new AbortController();
    const aborting = wallet(ERIN, { afterFirstSend: () => ctl.abort() });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: aborting, account: ERIN },
      journal: memoryJournal(),
    });
    const before = Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]));
    const fault = await w
      .runSequence(parts(w.principal, "seq-abort", 2), { signal: ctl.signal })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(fault).toBeInstanceOf(EfsFault);
    const f = fault as EfsFault;
    expect(f.code).toBe("ABORTED");
    expect(f).toMatchObject({ mayHaveSent: true, sequenceMayHaveSent: true });
    const id = f.sequenceId as Hex;
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(aborting.sends).toBe(1); // part 2 was never asked for
    // Until the transaction is mined, settling says IN_FLIGHT (unknown is not absence); a later visit finds it.
    const [sent] = (await w.pending()) as { txHash?: Hex }[];
    for (let t = 0; t < 200 && !(await rpc("eth_getTransactionReceipt", [sent?.txHash])); t++)
      await new Promise((res) => setTimeout(res, 20));
    expect(await w.reconcileSequence(id)).toMatchObject({ state: "PARTIAL", committed: 1 });
    expect(await w.resume(id, { pollMs: 50 })).toMatchObject({ state: "COMPLETE", committed: 2 });
    expect(aborting.sends).toBe(2);
    expect(Number(await rpc("eth_getTransactionCount", [ERIN, "pending"]))).toBe(before + 2);
  });

  it("the journal dies after an atomic batch went out: the fault says it may have gone out; reconcile commits it", async () => {
    const inner = memoryJournal();
    let broken = false;
    const gone = <T>(f: () => Promise<T>): Promise<T> =>
      broken ? Promise.reject(new EfsFault("JOURNAL_UNAVAILABLE", "IndexedDB went away")) : f();
    const flaky: Journal = {
      durable: inner.durable,
      put: (r) => gone(() => inner.put(r)),
      get: (id) => gone(() => inner.get(id)),
      unresolved: (l) => gone(() => inner.unresolved(l)),
      putSequence: (r) => gone(() => inner.putSequence(r)),
      getSequence: (id) => gone(() => inner.getSequence(id)),
      openSequences: (l) => gone(() => inner.openSequences(l)),
      withLock: (l, wait, fn) => inner.withLock(l, wait, fn),
    };
    const batching = wallet(ERIN, {
      atomic5792: true,
      afterFirstSend: () => {
        broken = true;
      },
    });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: batching, account: ERIN },
      journal: flaky,
    });
    const fault = await w.runSequence(parts(w.principal, "seq-batch-dies")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(fault).toBeInstanceOf(EfsFault);
    const f = fault as EfsFault;
    expect(f.code).toBe("JOURNAL_UNAVAILABLE");
    expect(f).toMatchObject({ mayHaveSent: true, sequenceMayHaveSent: true });
    broken = false;
    const id = f.sequenceId as Hex;
    expect(await w.reconcileSequence(id)).toMatchObject({ state: "COMPLETE", committed: 3 });
    expect([batching.batches, batching.sends]).toEqual([1, 0]);
  });

  it("a local account aborted after its write-ahead record: the fault says it may have gone out", async () => {
    const ctl = new AbortController();
    const inner = memoryJournal();
    // The caller aborts the moment the write-ahead record is down, just before the SDK broadcasts.
    const journal: Journal = {
      durable: inner.durable,
      put: async (r) => {
        await inner.put(r);
        if (r.stage === "SUBMISSION_POSSIBLE") ctl.abort();
      },
      get: (id) => inner.get(id),
      unresolved: (l) => inner.unresolved(l),
      putSequence: (r) => inner.putSequence(r),
      getSequence: (id) => inner.getSequence(id),
      openSequences: (l) => inner.openSequences(l),
      withLock: (l, wait, fn) => inner.withLock(l, wait, fn),
    };
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: dave },
      journal,
    });
    const fault = await w
      .runSequence(parts(w.principal, "seq-local-abort", 1), { signal: ctl.signal })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(fault).toBeInstanceOf(EfsFault);
    const f = fault as EfsFault;
    expect(f.code).toBe("ABORTED");
    expect(f).toMatchObject({ mayHaveSent: true, sequenceMayHaveSent: true });
    // Whether or not it reached the node, the save is never listed as unsent: it is settled from the ledger.
    const settled = await w.reconcileSequence(f.sequenceId as Hex);
    expect(["IN_FLIGHT", "COMPLETE"]).toContain(settled.state);
  });

  it("a batch the wallet did not process (4900) is NOT_SENT: the save is NOT_STARTED, never held as in flight", async () => {
    const journal = memoryJournal();
    const offline = wallet(ERIN, { atomic5792: true, batchFailWith: 4900 });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: offline, account: ERIN },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-batch-offline"));
    expect(r).toMatchObject({
      state: "NOT_STARTED",
      committed: 0,
      mode: "batch",
      reason: { code: "WALLET_DISCONNECTED", retry: "transient" },
    });
    expect(offline.sends).toBe(0);
    const back = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(ERIN, { atomic5792: true }),
        account: ERIN,
      },
      journal,
    });
    expect(await back.resume(r.sequenceId, { pollMs: 50 })).toMatchObject({ state: "COMPLETE" });
  });

  it("a part sent and never committed, proven so past its deadline, says EXPIRED; it is never re-sent by itself", async () => {
    const journal = memoryJournal();
    const slow = wallet(ERIN, { holdFirst: true }); // signed, its hash returned, never broadcast
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: slow, account: ERIN },
      journal,
    });
    const [recipe] = parts(w.principal, "seq-expired", 1);
    if (!recipe) throw new Error("no part");
    const r = await w.runSequence([{ ...recipe, deadlineSeconds: 5 }], {
      settleMs: 200,
      pollMs: 50,
    });
    expect(r).toMatchObject({ state: "IN_FLIGHT", committed: 0 });
    await rpc("evm_increaseTime", [60]);
    await rpc("anvil_mine", ["0x50"]); // anvil finalizes 64 blocks behind: a finalized block past the deadline
    const expired = {
      state: "NOT_STARTED",
      committed: 0,
      reason: { code: "EXPIRED", retry: "transient" },
    };
    expect(await w.reconcileSequence(r.sequenceId)).toMatchObject(expired); // not "not sent"
    expect(await w.pendingSequences()).toMatchObject([expired]);
    expect(slow.sends).toBe(1);
    // A declined Send again is about the new attempt (never sent): no stale EXPIRED afterwards.
    const declining = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(ERIN, { refuseSend: 1 }),
        account: ERIN,
      },
      journal,
    });
    expect(await declining.resume(r.sequenceId)).toMatchObject({
      state: "NOT_STARTED",
      reason: { code: "USER_REJECTED" },
    });
    const [listed] = await w.pendingSequences();
    expect(listed).toMatchObject({ state: "NOT_STARTED", committed: 0 });
    expect(listed?.reason).toBeUndefined();
    // Send again is the person's click: a new plan, and the reason clears.
    const again = await w.resume(r.sequenceId, { pollMs: 50 });
    expect(again).toMatchObject({ state: "COMPLETE", committed: 1 });
    expect(again.reason).toBeUndefined();
    expect(slow.sends).toBe(2);
  });

  it("settling and listing never touch the wallet", async () => {
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(ERIN, { refuseSend: 1 }) },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-quiet", 2));
    expect(r.state).toBe("NOT_STARTED");
    const dead = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(ERIN, { dead: true }),
        account: ERIN,
      },
      journal,
    });
    expect((await dead.reconcileSequence(r.sequenceId)).state).toBe("NOT_STARTED");
    expect((await dead.pendingSequences()).length).toBe(1);
    const gone = await dead.abandon(r.sequenceId);
    expect(gone.state).toBe("ABANDONED");
    expect(await dead.pendingSequences()).toEqual([]);
    expect((await dead.resume(r.sequenceId)).state).toBe("ABANDONED");
  });

  it("an atomic EIP-5792 wallet takes every part under one approval", async () => {
    const batching = wallet(ERIN, { atomic5792: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: batching },
      journal: memoryJournal(),
    });
    const r = await w.runSequence(parts(w.principal, "seq-batch"), { pollMs: 50 });
    expect(r).toMatchObject({ state: "COMPLETE", committed: 3, mode: "batch" });
    expect([batching.batches, batching.sends]).toEqual([1, 0]); // one approval, no per-part prompts
  });

  it("a refused batch sends nothing; the same save can then go part by part", async () => {
    const journal = memoryJournal();
    const refusing = wallet(FRANK, { atomic5792: true, refuseBatch: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: refusing },
      journal,
    });
    const r = await w.runSequence(parts(w.principal, "seq-batch-no"));
    expect(r).toMatchObject({
      state: "NOT_STARTED",
      committed: 0,
      mode: "batch",
      reason: { code: "USER_REJECTED" },
    });
    const plain = wallet(FRANK);
    const w2 = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: plain },
      journal,
    });
    expect(await w2.resume(r.sequenceId, { batch: "never" })).toMatchObject({
      state: "COMPLETE",
      mode: "sequential",
    });
  });
});
