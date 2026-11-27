// SPDX-License-Identifier: MIT
// Reply validation on the write path (the write-path audit, 2026-11-26): a reply that a sound endpoint can't give is
// never planned on. The ledger's CAS binds a head's revision only, never its state, so a head reported UNSET at its
// true revision would let a planner's "first statement" land over a live entry: every write planner's head read
// refuses a state its revision contradicts (UNSET exactly at revision 0) and fails over (with one endpoint, UNKNOWN).
// Account 47 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { CLOCK_SKEW_SECONDS, planPublication } from "../../src/actions/plan.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, RecordId, SubjectId } from "../../src/core/hex.ts";
import { utf8Encode } from "../../src/core/platform.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { planCreateFile } from "../../src/files/entries.ts";
import { ingressAbi, ledgerAbi, ledgerReadsAbi, ledgerViewsAbi } from "../../src/generated/abis.ts";
import { planLabel, planTag } from "../../src/tags/index.ts";
import { planHeadNo } from "../../src/testing/index.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 47,
});
const home = { kind: "home" as const, address: me.address.toLowerCase() as Address };
const topic = [`wr${Date.now().toString(36)}`];
const target = `0x${"d7".repeat(20)}` as Address;
let w: Awaited<ReturnType<typeof createWriter>>;
let file: SubjectId;
let revision: RecordId;

type Row = Record<string, unknown>;
/** Every head row rewritten: UNSET at its own revision, or (`stated`) BOUND at revision 0. */
const contradict = (h: Row, stated = false): Row =>
  stated ? { ...h, state: 1, revision: 0n } : { ...h, state: 0 };
const lying = (abi: readonly unknown[], fn: string, edit: (outs: unknown[]) => unknown[]) =>
  lyingEfs(fixture.rpcUrl, deployment, abi, fn, edit);
/** heads(): [rows, basis]. */
const headsLie = (stated = false) =>
  lying(ledgerViewsAbi, "heads", ([rows, b]) => [
    (rows as Row[]).map((h) => contradict(h, stated)),
    b,
  ]);
/** headsAt(): [status, selected, selectedIndex, all, basis]; every author's head, the selected one too. */
const headsAtLie = (stated = false) =>
  lying(ledgerViewsAbi, "headsAt", ([st, sel, i, all, b]) => [
    st,
    contradict(sel as Row, stated),
    i,
    (all as Row[]).map((h) => contradict(h, stated)),
    b,
  ]);

const run = async (p: Promise<unknown>) => {
  const r = (await p) as { status: string; parts?: unknown[]; review?: unknown };
  if (r.status !== "PLANNED") throw new Error(`not planned: ${r.status}`);
  expect((await w.runSequence(r.parts as never)).state).toBe("COMPLETE");
  return r;
};

beforeAll(async () => {
  await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [me.address, "0x56bc75e2d63100000"],
    }),
  });
  w = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: me },
    journal: memoryJournal(),
  });
  const made = (await run(
    planCreateFile(efs, w, { folder: home, name: "wr.txt", content: utf8Encode("w\n") }),
  )) as { review: { file: { subject: SubjectId }; revision: RecordId } };
  file = made.review.file.subject;
  revision = made.review.revision;
  await run(planTag(efs, w, { topic, targets: [{ kind: "address", address: target }] }));
  await run(planLabel(efs, w, { topic, lang: "en", text: "write replies" }));
}, 240_000);

describe("a head whose state its revision contradicts is never planned on", () => {
  it("planCreateFile: your own entry reported UNSET at its revision (or BOUND at 0) fails over", async () => {
    const honest = await planCreateFile(efs, w, {
      folder: home,
      name: "wr.txt",
      content: utf8Encode("x"),
    });
    expect(honest).toMatchObject({ status: "REFUSED" }); // NAME_TAKEN_MINE
    // Your head in heads(), and in headsAt's Lens rows (a Lens that names you).
    const lies = {
      heads: headsLie(),
      headsStated: headsLie(true),
      headsAt: headsAtLie(),
      headsAtStated: headsAtLie(true),
    };
    for (const [which, lie] of Object.entries(lies)) {
      const r = await planCreateFile(lie, w, {
        folder: home,
        name: "wr.txt",
        content: utf8Encode("x"),
        lens: { principals: [w.principal] },
      });
      expect(r, which).toMatchObject({ status: "UNKNOWN", reason: { retry: "transient" } });
    }
  });

  it("planTag and planLabel: your statement reported UNSET at its revision fails over", async () => {
    for (const lie of [headsAtLie(), headsAtLie(true)]) {
      expect(
        await planTag(lie, w, {
          topic,
          targets: [{ kind: "address", address: target }],
          number: 2,
        }),
      ).toMatchObject({ status: "UNKNOWN" });
      expect(await planLabel(lie, w, { topic, lang: "en", text: "again" })).toMatchObject({
        status: "UNKNOWN",
      });
    }
  });

  it("planEditFile: your HEAD reported UNSET at its revision (or bound at 0) fails over", async () => {
    const input = {
      file: { kind: "file" as const, subject: file },
      base: { kind: "revision" as const, recordId: revision },
      content: utf8Encode("edited\n"),
      lens: { principals: [w.principal] },
    };
    expect(await planEditFile(efs, w, input)).toMatchObject({ status: "PLANNED" });
    for (const stated of [false, true]) {
      const lie = lying(ledgerReadsAbi, "head", ([st, h]) => [st, contradict(h as Row, stated)]);
      expect(await planEditFile(lie, w, input)).toMatchObject({ status: "UNKNOWN" });
    }
  });

  it("planHeadNo: your HEAD reported UNSET at its revision fails over", async () => {
    expect(await planHeadNo(efs, w, { file: { kind: "file", subject: file } })).toMatchObject({
      status: "PLANNED",
    });
    for (const lie of [headsAtLie(), headsAtLie(true)])
      expect(await planHeadNo(lie, w, { file: { kind: "file", subject: file } })).toMatchObject({
        status: "UNKNOWN",
      });
  });
});

describe("every signed value an endpoint supplies is checked before it is signed (planPublication)", () => {
  /** One publication to plan: a fresh tag statement (any planner's part would do). */
  const part = async () => {
    const t = await planTag(efs, w, {
      topic: [`${topic[0]}-pub`],
      targets: [{ kind: "address", address: target }],
    });
    if (t.status !== "PLANNED") throw new Error(t.status);
    return { ...(t.parts[0] as (typeof t.parts)[number]), account: me.address };
  };

  it("the execution set signed is the deployment document's, and only while the chain's is the same", async () => {
    const input = await part();
    const honest = await planPublication(efs, input);
    if (honest.status !== "PLANNED") throw new Error(honest.status);
    expect(honest.plan.executionSet).toBe(efs.deployment.executionSet.toLowerCase());
    for (const word of [`0x${"0".repeat(64)}`, `0x${"ab".repeat(32)}`]) {
      const lie = lying(ledgerAbi, "executionSet", () => [word]);
      expect(await planPublication(lie, input), word).toMatchObject({
        status: "UNKNOWN",
        reason: { code: "NOT_VERIFIED_DEPLOYMENT", retry: "transient" },
      });
    }
  });

  it("an acceptance profile of 0 (which would waive the ledger's check) is never signed", async () => {
    const lie = lying(ingressAbi, "acceptanceProfileOf", () => [`0x${"0".repeat(64)}`]);
    expect(await planPublication(lie, await part())).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR", retry: "transient" },
    });
  });

  it("a basis block far ahead of this device's clock fails over; the deadline is the basis block's + the window", async () => {
    const input = await part();
    const honest = await planPublication(efs, { ...input, deadlineSeconds: 120 });
    if (honest.status !== "PLANNED") throw new Error(honest.status);
    const block = (await (
      await fetch(fixture.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByHash",
          params: [honest.plan.basis.blockHash, false],
        }),
      })
    ).json()) as { result: { timestamp: string } };
    expect(honest.plan.deadline).toBe(BigInt(block.result.timestamp) + 120n);
    // The endpoint says the block is from the future: the deadline would outlive the window.
    const ahead = BigInt(Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS + 600);
    const future: FetchLike = async (url, init) => {
      const res = await fetch(url, init as RequestInit);
      const body = JSON.parse(init.body ?? "null");
      const reqs = (Array.isArray(body) ? body : [body]) as { id: number; method: string }[];
      const json = await res.json();
      for (const o of (Array.isArray(json) ? json : [json]) as {
        id: number;
        result?: { timestamp?: string };
      }[])
        if (reqs.find((r) => r.id === o.id)?.method === "eth_getBlockByHash" && o.result)
          o.result.timestamp = `0x${ahead.toString(16)}`;
      return new Response(JSON.stringify(json), { status: 200 }) as never;
    };
    const lie = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: future });
    expect(await planPublication(lie, input)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR", retry: "transient" },
    });
  });
});
