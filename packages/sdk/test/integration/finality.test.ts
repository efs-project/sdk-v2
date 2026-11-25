// SPDX-License-Identifier: MIT
// Finality: a COMMITTED that is not yet final stays open and is re-checked until it is; a reorg that drops it moves
// it back to SUBMISSION_POSSIBLE (re-sending is the user's choice, never automatic); sequences say "Saved ·
// confirming" until final; and a wallet-free journal view settles and lists them before anyone connects.
// The chain's view is steered through an endpoint wrapper (finalized → genesis, a publication "forgotten"), so the
// shared fixture chain is never rewound.
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal, openJournal } from "../../src/actions/index.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import { type Hex, ZERO_WORD } from "../../src/core/hex.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";
import { putInline } from "./recipes.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex } };
};
const docs = deployment.seed.folder.directoryRecordId;
const heidi = privateKeyToAccount(
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
); // anvil #7
const ivan = privateKeyToAccount(
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
); // anvil #8

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result?: unknown }).result;
}

/**
 * An endpoint whose view can be steered: no finality yet, publications forgotten (a reorg), or no ledger at the
 * finalized block (`finalUnknown`: publicationAt there answers UNKNOWN, as the readers do where the ledger has no
 * code).
 */
function steered() {
  const knobs = { noFinality: true, forget: false, finalUnknown: false };
  let finalHash: string | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    type Req = { id: number; method: string; params: unknown[] };
    const body = JSON.parse(init.body ?? "null") as Req | Req[];
    const reqs = (Array.isArray(body) ? body : [body]).map((r) =>
      knobs.noFinality && r.method === "eth_getBlockByNumber" && r.params[0] === "finalized"
        ? { ...r, params: ["earliest", ...r.params.slice(1)] }
        : r,
    );
    const res = await fetch(url, {
      ...init,
      body: JSON.stringify(Array.isArray(body) ? reqs : reqs[0]),
    } as RequestInit);
    let text = await res.text();
    const items = (t: string) => {
      const parsed = JSON.parse(t) as
        | { id: number; result?: { hash?: string } | string }[]
        | { id: number; result?: { hash?: string } | string };
      return { parsed, list: Array.isArray(parsed) ? parsed : [parsed] };
    };
    for (const item of items(text).list) {
      const req = reqs.find((r) => r.id === item.id);
      if (
        req?.method === "eth_getBlockByNumber" &&
        req.params[0] === "finalized" &&
        typeof item.result === "object"
      )
        finalHash = item.result?.hash;
    }
    if (knobs.finalUnknown && finalHash) {
      const atFinal = new Set(
        reqs
          .filter(
            (r) =>
              r.method === "eth_call" &&
              JSON.stringify(r.params[1] ?? null).includes(finalHash as string) &&
              (() => {
                try {
                  return (
                    decodeFunctionData({
                      abi: ledgerReadsAbi,
                      data: (r.params[0] as { data: Hex }).data,
                    }).functionName === "publicationAt"
                  );
                } catch {
                  return false;
                }
              })(),
          )
          .map((r) => r.id),
      );
      const unknown = encodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "publicationAt",
        result: [1, 0n, ZERO_WORD],
      });
      const { parsed, list } = items(text);
      for (const item of list) if (atFinal.has(item.id)) item.result = unknown;
      text = JSON.stringify(parsed);
    }
    if (knobs.forget) {
      const ids = new Set(
        reqs
          .filter((r) => {
            if (r.method !== "eth_call") return false;
            try {
              const f = decodeFunctionData({
                abi: ledgerReadsAbi,
                data: (r.params[0] as { data: Hex }).data,
              });
              return f.functionName === "publicationAt";
            } catch {
              return false;
            }
          })
          .map((r) => r.id),
      );
      const absent = encodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "publicationAt",
        result: [3, 0n, ZERO_WORD],
      });
      const parsed = JSON.parse(text) as
        | { id: number; result?: string }[]
        | { id: number; result?: string };
      for (const item of Array.isArray(parsed) ? parsed : [parsed])
        if (ids.has(item.id)) item.result = absent;
      text = JSON.stringify(parsed);
    }
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return { knobs, efs: createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: fetchImpl }) };
}

const salt = (s: string) => keccak256(toHex(s));

describe("finality (fixture)", () => {
  it("a COMMITTED that is not final stays pending until it is; then it is settled", async () => {
    const { knobs, efs } = steered();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: heidi },
      journal: memoryJournal(),
    });
    const p = await w.planActions(
      putInline(efs, w.principal, docs, "fin.txt", new Uint8Array([1]), salt("fin")),
    );
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await w.run(p.plan)).reconcile).toMatchObject({ outcome: "COMMITTED", final: false });
    expect((await w.pending()).map((a) => [a.stage, a.final])).toEqual([["COMMITTED", false]]);
    knobs.noFinality = false;
    await rpc("anvil_mine", ["0x50"]);
    expect(await w.reconcile(p.plan.id)).toMatchObject({ outcome: "COMMITTED", final: true });
    expect(await w.pending()).toEqual([]);
  });

  it("a reorg that drops a COMMITTED moves it back; re-sending is never automatic", async () => {
    const { knobs, efs } = steered();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: heidi },
      journal: memoryJournal(),
    });
    const p = await w.planActions(
      putInline(efs, w.principal, docs, "reorg.txt", new Uint8Array([2]), salt("reorg")),
    );
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await w.run(p.plan)).reconcile?.outcome).toBe("COMMITTED");
    knobs.forget = true; // the latest block no longer shows the admission
    const r = await w.reconcile(p.plan.id);
    expect(r).toMatchObject({ outcome: "UNKNOWN", reason: { code: "REORGED" } });
    const [a] = await w.pending();
    expect(a?.stage).toBe("SUBMISSION_POSSIBLE");
    expect(a?.history.at(-1)?.detail).toMatch(/reorged out/);
    expect((await w.send(p.plan)).status).toBe("AMBIGUOUS"); // never re-sent on its own
    knobs.forget = false; // the publication is back (re-included)
    expect((await w.reconcile(p.plan.id)).outcome).toBe("COMMITTED");
  });

  it("sequences: COMPLETE but not final stays pending ('Saved · confirming'); a wallet-free view settles it", async () => {
    const { knobs, efs } = steered();
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: heidi },
      journal,
    });
    const parts = [0, 1].map((i) =>
      putInline(
        efs,
        w.principal,
        docs,
        `finseq-${i}.txt`,
        new Uint8Array([i]),
        salt(`finseq-${i}`),
      ),
    );
    const done = await w.runSequence(parts);
    expect(done).toMatchObject({ state: "COMPLETE", final: false, committed: 2 });
    const view = openJournal(efs, { journal }); // no wallet, no account
    const [open] = await view.pendingSequences();
    expect(open).toMatchObject({
      sequenceId: done.sequenceId,
      state: "COMPLETE",
      final: false,
      account: heidi.address.toLowerCase(),
    });
    expect(await view.pendingSequences({ account: ivan.address })).toEqual([]);
    knobs.noFinality = false;
    await rpc("anvil_mine", ["0x50"]);
    expect(await view.reconcileSequence(done.sequenceId)).toMatchObject({
      state: "COMPLETE",
      final: true,
    });
    expect(await view.pendingSequences()).toEqual([]);
    await expect(view.reconcileSequence(`0x${"ab".repeat(32)}`)).rejects.toThrow(/no sequence/);
  });

  it("a reorged part makes a COMPLETE sequence IN_FLIGHT again; another account cannot resume it", async () => {
    const { knobs, efs } = steered();
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: heidi },
      journal,
    });
    const parts = [0, 1].map((i) =>
      putInline(efs, w.principal, docs, `reseq-${i}.txt`, new Uint8Array([i]), salt(`reseq-${i}`)),
    );
    const done = await w.runSequence(parts);
    expect(done.state).toBe("COMPLETE");
    knobs.forget = true;
    expect(await openJournal(efs, { journal }).reconcileSequence(done.sequenceId)).toMatchObject({
      state: "IN_FLIGHT",
      final: false,
    });
    const other = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: ivan },
      journal,
    });
    await expect(other.resume(done.sequenceId)).rejects.toThrow(/another account/);
    knobs.forget = false;
    expect(await openJournal(efs, { journal }).reconcileSequence(done.sequenceId)).toMatchObject({
      state: "COMPLETE",
    });
  });

  it("an UNKNOWN at the finalized block (no ledger there) is never evidence that a plan missed its deadline", async () => {
    const { knobs, efs } = steered();
    knobs.noFinality = false;
    knobs.finalUnknown = true;
    const journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: ivan },
      journal,
    });
    const recipe = putInline(
      efs,
      w.principal,
      docs,
      "never-sent.txt",
      new TextEncoder().encode("never sent"),
      salt("final-unknown"),
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
    await rpc("evm_increaseTime", [60]);
    await rpc("anvil_mine", ["0x50"]); // a finalized block past the deadline
    // UNKNOWN there is "no ledger at that block", not "nonce unused": nothing is proven.
    expect((await w.reconcile(planned.plan.id)).outcome).toBe("UNKNOWN");
    // An ABSENT_PROVEN from the live ledger at that finalized block is the proof.
    knobs.finalUnknown = false;
    expect(await w.reconcile(planned.plan.id)).toMatchObject({
      outcome: "NOT_COMMITTED_PROVEN",
      final: true,
    });
  });
});
