// SPDX-License-Identifier: MIT
// The write lifecycle against a real fixture: plan → review → send → journal → reconcile, exactly once.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, type Journal, memoryJournal } from "../../src/actions/index.ts";
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
  knobs: { loseResponse?: boolean; refuse?: boolean; chainId?: string } = {},
): Eip1193Like & { sent: number } {
  const w = {
    sent: 0,
    async request({ method, params }: { method: string; params?: unknown }) {
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return knobs.chainId ?? (await rpc("eth_chainId"));
      if (method === "eth_sendTransaction") {
        if (knobs.refuse)
          throw Object.assign(new Error("User rejected the request."), { code: 4001 });
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
    expect(await after.pending()).toEqual([]);
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

  it("a wallet refusal is NOT_SENT; a wallet on the wrong chain or account is STALE", async () => {
    const refusing = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(BOB, { refuse: true }) },
      journal: memoryJournal(),
    });
    const r1 = putInline(efs, refusing.principal, docs, "no.txt", new Uint8Array([1]), salt("no"));
    const p1 = await refusing.planActions(r1);
    if (p1.status !== "PLANNED") throw new Error(p1.status);
    expect((await refusing.send(p1.plan)).status).toBe("NOT_SENT");
    const wrongChain = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet(BOB, { chainId: "0x1" }) },
      journal: memoryJournal(),
    });
    expect((await wrongChain.send(p1.plan)).status).toBe("STALE");
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
    expect(await restarted.pending()).toEqual([]);
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
    expect(r.status).toBe("STALE");
    expect(r.status === "STALE" && r.reasons.join(" ")).toMatch(
      /over the per-transaction cap of 16777216/,
    );
    expect(w0.sent).toBe(0);
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
    async put(record) {
      n++;
      if (fail.includes(n))
        throw new EfsFault("JOURNAL_UNAVAILABLE", `injected failure on put #${n}`);
      return inner.put(record);
    },
  };
}
