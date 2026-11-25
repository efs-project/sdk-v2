// SPDX-License-Identifier: MIT
// The write lifecycle against a real fixture: plan → review → send → journal → reconcile, exactly once.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import {
  ACTION,
  createWriter,
  type Journal,
  memoryJournal,
  type Plan,
} from "../../src/actions/index.ts";
import type { Eip1193Like } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { EfsFault } from "../../src/core/errors.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { openFile, readBytes } from "../../src/files/bytes.ts";
import { fileJournal } from "../../src/node/journal.ts";
import { putInline } from "./recipes.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex } };
};
const docs = deployment.seed.folder.directoryRecordId;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
// anvil's well-known development accounts #1 and #2 (public test keys; never use them with value)
const alice = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const BOB = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Hex;

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
/** A wallet backed by anvil's unlocked account, with knobs to drop responses or refuse. */
function wallet(
  account: Hex,
  knobs: { loseResponse?: boolean; refuse?: boolean; chainId?: string; failWith?: number } = {},
): Eip1193Like & { sent: number } {
  const w = {
    sent: 0,
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return knobs.chainId ?? (await rpc("eth_chainId"));
      if (method === "eth_sendTransaction") {
        if (knobs.refuse)
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        if (knobs.failWith !== undefined)
          throw Object.assign(new Error(`wallet error ${knobs.failWith}`), {
            code: knobs.failWith,
          });
        w.sent++;
        const hash = await rpc(method, params as unknown[]);
        if (knobs.loseResponse) throw new Error("network connection lost");
        return hash;
      }
      return rpc(method, (params as unknown[]) ?? []);
    },
  };
  return w;
}
const salt = (s: string): Hex => keccak256(toHex(s));
const lensFor = (account: Hex) => efs.lens.mineFirst(account);

describe("write lifecycle (fixture)", () => {
  it("local account: plan → review → run reaches COMMITTED, and the file reads back", async () => {
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: alice },
      journal: memoryJournal(),
    });
    const recipe = putInline(
      efs,
      w.principal,
      docs,
      "hello.txt",
      new TextEncoder().encode("hello, EFS\n"),
      salt("hello"),
    );
    const planned = await w.planActions(recipe);
    expect(planned.status).toBe("PLANNED");
    if (planned.status !== "PLANNED") return;
    const review = await w.review(planned.plan);
    expect(review.wouldRevert).toBeNull();
    expect(review.prompts).toBe(1);
    const run = await w.run(planned.plan);
    expect(run.send.status).toBe("SUBMITTED");
    expect(run.reconcile?.outcome).toBe("COMMITTED");
    const opened = await openFile(
      efs,
      { kind: "file", subject: recipe.file },
      { lens: lensFor(alice.address) },
    );
    expect(opened.status).toBe("PRESENT");
    if (opened.status !== "PRESENT") return;
    expect(opened.file.author).toBe(w.principal);
    expect(new TextDecoder().decode((await readBytes(efs, opened.file)).bytes)).toBe(
      "hello, EFS\n",
    );
  });

  it("wallet: a lost response is AMBIGUOUS, reconciles to COMMITTED, and is never sent twice", async () => {
    const journal = memoryJournal();
    const lossy = wallet(BOB, { loseResponse: true });
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: lossy },
      journal,
    });
    const recipe = putInline(
      efs,
      w.principal,
      docs,
      "lost.txt",
      new TextEncoder().encode("did it land?"),
      salt("lost"),
    );
    const planned = await w.planActions(recipe);
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const sent = await w.send(planned.plan);
    expect(sent.status).toBe("AMBIGUOUS");
    expect((await journal.get(planned.plan.id))?.stage).toBe("SUBMISSION_POSSIBLE");
    expect((await w.pending()).map((a) => a.planId)).toEqual([planned.plan.id]);
    await rpc("evm_mine");
    // "Reload": a fresh writer on the same journal reconciles without the wallet.
    const after = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(BOB) },
      journal,
    });
    const rec = await after.reconcile(planned.plan.id);
    expect(rec.outcome).toBe("COMMITTED");
    expect((await journal.get(planned.plan.id))?.stage).toBe("COMMITTED");
    // Committed but not final yet: still pending (reconcile keeps checking until a finalized block confirms it).
    expect((await after.pending()).map((a) => [a.stage, a.final])).toEqual([["COMMITTED", false]]);
    // Sending the same plan again is refused by the journal: exactly one wallet broadcast happened.
    const again = await after.send(planned.plan);
    expect(again.status).toBe("AMBIGUOUS");
    expect(lossy.sent).toBe(1);
  });

  it("an unsent plan past its deadline reconciles to NOT_COMMITTED_PROVEN", async () => {
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: alice },
      journal,
    });
    const recipe = putInline(
      efs,
      w.principal,
      docs,
      "late.txt",
      new TextEncoder().encode("too late"),
      salt("late"),
    );
    const planned = await w.planActions({ ...recipe, deadlineSeconds: 5 });
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    await journal.put({
      schema: "efs-sdk-attempt/1",
      planId: planned.plan.id,
      plan: planned.plan,
      stage: "SUBMISSION_POSSIBLE",
      history: [],
    });
    expect((await w.reconcile(planned.plan.id)).outcome).toBe("UNKNOWN");
    await rpc("evm_increaseTime", [60]);
    await rpc("evm_mine");
    // Past the deadline at the latest block is not enough: the proof needs a FINALIZED block past it.
    expect((await w.reconcile(planned.plan.id)).outcome).toBe("UNKNOWN");
    await rpc("anvil_mine", ["0x50"]); // anvil finalizes 64 blocks behind the head
    const done = await w.reconcile(planned.plan.id);
    expect(done.outcome).toBe("NOT_COMMITTED_PROVEN");
    expect(done.final).toBe(true);
  });

  it("a wallet refusal is NOT_SENT; a wallet on the wrong chain or account is NOT_SENT WALLET_MISMATCH", async () => {
    const refusing = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(BOB, { refuse: true }) },
      journal: memoryJournal(),
    });
    const r1 = putInline(efs, refusing.principal, docs, "no.txt", new Uint8Array([1]), salt("no"));
    const p1 = await refusing.planActions(r1);
    if (p1.status !== "PLANNED") throw new Error(p1.status);
    expect((await refusing.send(p1.plan)).status).toBe("NOT_SENT");
    const onMainnet = wallet(BOB, { chainId: "0x1" });
    const wrongChain = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: onMainnet },
      journal: memoryJournal(),
    });
    // Nothing is sent and the reason says exactly what to switch back to: the same plan can go once it is.
    expect(await wrongChain.send(p1.plan)).toMatchObject({
      status: "NOT_SENT",
      reason: {
        code: "WALLET_MISMATCH",
        retry: "transient",
        wallet: {
          expected: { chainId: 31337, account: BOB },
          actual: { chainId: 1, account: BOB },
        },
      },
    });
    const ALICE_ADDR = alice.address.toLowerCase() as Hex;
    const otherAccount = wallet(ALICE_ADDR);
    const wrongAccount = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: otherAccount, account: BOB },
      journal: memoryJournal(),
    });
    expect(await wrongAccount.send(p1.plan)).toMatchObject({
      status: "NOT_SENT",
      reason: {
        code: "WALLET_MISMATCH",
        wallet: {
          expected: { chainId: 31337, account: BOB },
          actual: { chainId: 31337, account: ALICE_ADDR },
        },
      },
    });
    expect([onMainnet.sent, otherAccount.sent]).toEqual([0, 0]);
  });

  it("wallet errors that mean 'not processed' are NOT_SENT with a named reason; any other code stays AMBIGUOUS", async () => {
    const planner = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(BOB) },
      journal: memoryJournal(),
    });
    const r1 = putInline(
      efs,
      planner.principal,
      docs,
      "codes.txt",
      new Uint8Array([7]),
      salt("codes"),
    );
    const p1 = await planner.planActions(r1);
    if (p1.status !== "PLANNED") throw new Error(p1.status);
    const cases: [number, string, string][] = [
      [4100, "WALLET_UNAUTHORIZED", "transient"],
      [4200, "WALLET_UNSUPPORTED", "never"],
      [4900, "WALLET_DISCONNECTED", "transient"],
      [4901, "WALLET_CHAIN_DISCONNECTED", "transient"],
      [-32602, "WALLET_INVALID_PARAMS", "never"],
    ];
    for (const [code, name, retry] of cases) {
      const journal = memoryJournal();
      const w = await createWriter(efs, {
        authorizer: {
          kind: "eip1193",
          profile: "direct",
          provider: wallet(BOB, { failWith: code }),
        },
        journal,
      });
      expect(await w.send(p1.plan), String(code)).toMatchObject({
        status: "NOT_SENT",
        reason: { code: name, retry },
      });
      // Stamped NOT_SENT: settling never waits on it, and the plan can be sent again.
      expect((await journal.get(p1.plan.id))?.stage, String(code)).toBe("NOT_SENT");
    }
    const unknown = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: {
        kind: "eip1193",
        profile: "direct",
        provider: wallet(BOB, { failWith: -32000 }),
      },
      journal: unknown,
    });
    expect(await w.send(p1.plan)).toMatchObject({ status: "AMBIGUOUS" });
    expect((await unknown.get(p1.plan.id))?.stage).toBe("SUBMISSION_POSSIBLE"); // may have gone out: reconcile decides
  });

  it("two concurrent sends for one account: the second is BUSY", async () => {
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: alice },
      journal,
    });
    const a = await w.planActions(
      putInline(efs, w.principal, docs, "a.txt", new Uint8Array([1]), salt("a")),
    );
    const b = await w.planActions(
      putInline(efs, w.principal, docs, "b.txt", new Uint8Array([2]), salt("b")),
    );
    if (a.status !== "PLANNED" || b.status !== "PLANNED") throw new Error("plan");
    const [ra, rb] = await Promise.all([w.send(a.plan), w.send(b.plan)]);
    expect([ra.status, rb.status].sort()).toEqual(["BUSY", "SUBMITTED"]);
  });

  it("a journal that fails before broadcast is NOT_SENT, and nothing reaches the wallet", async () => {
    const w0 = wallet(BOB);
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: w0 },
      journal: failingPuts(memoryJournal(), [1]),
    });
    const p = await w.planActions(
      putInline(efs, w.principal, docs, "jfail.txt", new Uint8Array([7]), salt("jfail")),
    );
    if (p.status !== "PLANNED") throw new Error(p.status);
    const r = await w.send(p.plan);
    expect(r.status).toBe("NOT_SENT");
    expect(r.status === "NOT_SENT" && r.reason.code).toBe("JOURNAL_UNAVAILABLE");
    expect(w0.sent).toBe(0);
  });

  it("a journal that fails after broadcast still reports SUBMITTED; a fresh writer over the same files never re-sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "efs-writes-"));
    const w0 = wallet(BOB);
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: w0 },
      journal: failingPuts(fileJournal(dir), [2]), // put #1 = write-ahead (ok), put #2 = SUBMITTED (fails)
    });
    const p = await w.planActions(
      putInline(efs, w.principal, docs, "jlate.txt", new Uint8Array([8]), salt("jlate")),
    );
    if (p.status !== "PLANNED") throw new Error(p.status);
    const r = await w.send(p.plan);
    expect(r.status).toBe("SUBMITTED");
    expect(w0.sent).toBe(1);
    // "Restart": a new writer over the same directory sees the attempt as still possibly submitted.
    const restarted = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: w0 },
      journal: fileJournal(dir),
    });
    expect((await restarted.pending()).map((x) => x.stage)).toEqual(["SUBMISSION_POSSIBLE"]);
    expect((await restarted.send(p.plan)).status).toBe("AMBIGUOUS");
    expect(w0.sent).toBe(1);
    await rpc("evm_mine");
    const rec = await restarted.reconcile(p.plan.id);
    expect(rec.outcome).toBe("COMMITTED");
    expect((await restarted.pending()).map((a) => [a.stage, a.final])).toEqual([
      ["COMMITTED", false],
    ]);
  });

  it("a publication over the per-transaction gas cap is refused before it is sent (tested against the number)", async () => {
    // The contracts' reference: 64 files-bytes/1 records of 256-byte bodies, inside every Realm limit, ~28M gas.
    // The fixture's prague anvil would accept it (no EIP-7825 there), so the SDK's refusal is the only guard.
    const t = efs.deployment.typeIds as Record<string, Hex>;
    const bodies = Array.from({ length: 64 }, (_, i) =>
      encode.chunk(new Uint8Array(224).fill(i + 1)),
    );
    const actions = bodies.map((b) => ({
      kind: ACTION.PUBLISH,
      typeId: t["files-bytes/1"] as Hex,
      bodyHashOrRecordId: keccak256(b),
      purpose: ZERO_WORD,
      subject: ZERO_WORD,
      role: ZERO_WORD,
      target: ZERO_WORD,
      expectedRevision: 0n,
      salt: ZERO_WORD,
    }));
    const w0 = wallet(BOB);
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: w0 },
      journal: memoryJournal(),
    });
    const p = await w.planActions({
      actions,
      bodies: bodies.map((b) => `0x${Buffer.from(b).toString("hex")}` as Hex),
      effects: [{ code: "test.bulk", args: {} }],
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    const r = await w.send(p.plan);
    // NOT_SENT with a stable code: "too big for one transaction, split it", never "your plan is stale".
    expect(r.status).toBe("NOT_SENT");
    if (r.status !== "NOT_SENT") return;
    expect(r.reason).toMatchObject({ code: "OVER_TX_GAS_CAP", retry: "after-replan" });
    expect(r.gas?.cap).toBe(16_777_216n);
    expect(r.gas && r.gas.estimate > r.gas.cap).toBe(true);
    expect(r.gas?.suggestedParts).toBeGreaterThanOrEqual(2);
    expect(w0.sent).toBe(0);
  });

  it("planSequence: the parts of one save take consecutive nonces and commit in order", async () => {
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: alice },
      journal: memoryJournal(),
    });
    const part = (name: string) =>
      putInline(efs, w.principal, docs, name, new TextEncoder().encode(name), salt(`seq-${name}`));
    const seq = await w.planSequence([part("one.txt"), part("two.txt"), part("three.txt")]);
    if (seq.status !== "PLANNED") throw new Error(seq.status);
    const [a, b, c] = seq.plans as [Plan, Plan, Plan];
    expect([b.nonce - a.nonce, c.nonce - a.nonce]).toEqual([1n, 2n]);
    expect(new Set(seq.plans.map((p) => p.id)).size).toBe(3); // three exactly-once identities
    for (const p of seq.plans) expect((await w.run(p)).reconcile?.outcome).toBe("COMMITTED");
  });

  it("reconcile still finds COMMITTED when the finalized-block read fails (an endpoint without 'finalized')", async () => {
    // Some endpoints do not serve the "finalized" tag, and a finalized block inside the deployment window makes the
    // reader revert. Neither may block COMMITTED at the latest block; only `final` is then unknown.
    const noFinal: Eip1193Like = {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_getBlockByNumber" && (params as unknown[])[0] === "finalized")
          throw Object.assign(new Error("finalized not supported"), { code: -32601 });
        return rpc(method, (params as unknown[]) ?? []);
      },
    };
    const lens = createEfs({
      rpcs: [{ provider: noFinal, label: "no finalized tag" }],
      deployment,
    });
    const w = await createWriter(lens, {
      authorizer: { kind: "local", profile: "direct", account: alice },
      journal: memoryJournal(),
    });
    const p = await w.planActions(
      putInline(lens, w.principal, docs, "nofinal.txt", new Uint8Array([9]), salt("nofinal")),
    );
    if (p.status !== "PLANNED") throw new Error(p.status);
    const run = await w.run(p.plan);
    expect(run.reconcile).toMatchObject({ outcome: "COMMITTED", final: false });
  });
});

/** Wrap a journal so the listed put calls (1-based) fail as an unavailable store would. */
function failingPuts(inner: Journal, fail: number[]): Journal {
  let n = 0;
  return {
    durable: inner.durable,
    get: (id) => inner.get(id),
    unresolved: (lock) => inner.unresolved(lock),
    withLock: (lock, wait, fn) => inner.withLock(lock, wait, fn),
    putSequence: (r) => inner.putSequence(r),
    getSequence: (id) => inner.getSequence(id),
    openSequences: (lock?: string) => inner.openSequences(lock),
    async put(record) {
      n++;
      if (fail.includes(n))
        throw new EfsFault("JOURNAL_UNAVAILABLE", `injected failure on put #${n}`);
      return inner.put(record);
    },
  };
}
