// SPDX-License-Identifier: MIT
// planEditFile's read-set guard (G6, the tag PM's refinement): an edit guards your HEAD and the HEAD of every Lens
// author up to and including the one whose version is its base, read in one heads() call and checked against the Lens
// reader's selection. A statement by an author AFTER that one can't change the base and doesn't stop the edit; one by
// an author BEFORE it does (E_READSET_STALE). A Lens head that contradicts the selection fails over. Accounts 58 to 61
// of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { type GuardMode, headSnapshotHash } from "../../src/actions/guard.ts";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, PrincipalId, RecordId, SubjectId } from "../../src/core/hex.ts";
import { lower, ZERO_WORD } from "../../src/core/hex.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { planCreateFile } from "../../src/files/entries.ts";
import { ledgerViewsAbi } from "../../src/generated/abis.ts";
import { bindingKey } from "../../src/protocol/keys.ts";
import { sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
// A edits; B ranks before the base's author C; D ranks after C.
type Acct = ReturnType<typeof acct>;
const [A, B, C, D] = [58, 59, 60, 61].map(acct) as [Acct, Acct, Acct, Acct];
type W = Awaited<ReturnType<typeof createWriter>>;
const writers = new Map<string, W>();
const w = (a: { address: string }) => writers.get(a.address) as W;
const text = (s: string) => new TextEncoder().encode(s);
const tag = `eg${Date.now().toString(36)}`;
let file: SubjectId;
let base: RecordId;
let lens: { principals: PrincipalId[] };

/** A head as the honest node holds it now. */
const ledgerHead = async (principal: PrincipalId, position: Hex) => {
  const r = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: deployment.readers.ledgerViews,
          data: encodeFunctionData({
            abi: ledgerViewsAbi,
            functionName: "heads",
            args: [deployment.ledger, [bindingKey(principal, position)]],
          }),
        },
        "latest",
      ],
    }),
  });
  const [[h]] = decodeFunctionResult({
    abi: ledgerViewsAbi,
    functionName: "heads",
    data: ((await r.json()) as { result: Hex }).result,
  }) as unknown as [
    [{ state: number; revision: bigint; admission: bigint; targetKind: number; target: Hex }],
  ];
  return {
    state: Number(h.state),
    revision: BigInt(h.revision),
    admission: BigInt(h.admission),
    targetKind: Number(h.targetKind),
    target: h.target,
  };
};

const run = async (who: W, planned: Promise<unknown>) => {
  const p = (await planned) as { status: string; parts?: unknown[] };
  if (p.status !== "PLANNED") throw new Error(`not planned: ${p.status}`);
  return who.runSequence(p.parts as never);
};
/** An edit by `who` of the file, from `from`, under the Lens of C only (so the base is C's version). */
const editAs = (who: typeof A, from: RecordId, body: string) =>
  run(
    w(who),
    planEditFile(efs, w(who), {
      file: { kind: "file", subject: file },
      base: { kind: "revision", recordId: from },
      content: text(body),
      lens: { principals: [w(C).principal] },
    }),
  );

beforeAll(async () => {
  for (const a of [A, B, C, D]) {
    await fetch(fixture.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [a.address, "0x56bc75e2d63100000"],
      }),
    });
    writers.set(
      a.address,
      await createWriter(efs, {
        authorizer: { kind: "local", profile: "direct", account: a },
        journal: memoryJournal(),
      }),
    );
  }
  // C's file, in C's home: C's version is the base everyone edits from.
  const made = (await planCreateFile(efs, w(C), {
    folder: { kind: "home", address: C.address.toLowerCase() as Address },
    name: `${tag}.txt`,
    content: text("C's version"),
  })) as {
    status: string;
    parts: unknown[];
    review: { file: { subject: SubjectId }; revision: RecordId };
  };
  if (made.status !== "PLANNED") throw new Error(made.status);
  expect((await w(C).runSequence(made.parts as never)).state).toBe("COMPLETE");
  file = made.review.file.subject;
  base = made.review.revision;
  lens = { principals: [w(B).principal, w(C).principal, w(D).principal, w(A).principal] };
}, 120_000);

const plan = (writer: { principal: PrincipalId; guard?: GuardMode }, body: string) =>
  planEditFile(efs, writer, {
    file: { kind: "file", subject: file },
    base: { kind: "revision", recordId: base },
    content: text(body),
    lens,
  });

describe("planEditFile's guard: your HEAD and the Lens up to the base's author", () => {
  it("guards B (no head: one word), C (the base: two words) and you (written); not D, after C", async () => {
    const p = await plan(w(A), "A's edit");
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(p.review).toMatchObject({ guard: "lens", chainChecked: true });
    const g = p.parts.at(-1)?.guard ?? [];
    expect(g.map((h) => [lower(h.principal), h.term])).toEqual([
      [lower(w(B).principal), "oneWord"],
      [lower(w(C).principal), "twoWords"],
      [lower(w(A).principal), "written"],
    ]);
    expect(new Set(g.map((h) => h.position)).size).toBe(1);
    // unguarded: no guard, and the review says the chain doesn't check the base
    const never = await plan({ principal: w(A).principal, guard: "never" }, "A's unguarded edit");
    expect(never.status === "PLANNED" && never.review.chainChecked).toBe(false);
    expect(never.status === "PLANNED" && never.parts.at(-1)?.guard).toBeUndefined();
  });

  it("a statement by D (after the base's author) doesn't stop the edit; it lands", async () => {
    const p = await plan(w(A), "A's edit, D moved");
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await editAs(D, base, "D's version")).state).toBe("COMPLETE");
    expect((await w(A).runSequence(p.parts)).state).toBe("COMPLETE");
  }, 120_000);

  it("a statement by B (before the base's author) does: the chain refuses the edit (E_READSET_STALE)", async () => {
    // A's own version (the last case) ranks after C, so C's version is still the base under this Lens. Plan, then B
    // binds a HEAD: B ranks first, so the base the edit was planned on is no longer what this Lens shows.
    const p = await plan(w(A), "A's second edit");
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await editAs(B, base, "B's version")).state).toBe("COMPLETE");
    const out = await w(A).runSequence(p.parts);
    expect(out.state).not.toBe("COMPLETE");
    expect(out.reason).toMatchObject({ code: "STALE", revert: { error: "E_READSET_STALE" } });
  }, 120_000);
});

describe("planEditFile's guard: a Lens head that contradicts the selection fails over", () => {
  it("an author before the base's reported BOUND, or the base's author reported at another target: UNKNOWN", async () => {
    // a fresh file of C's, so nobody stated before C there
    const made = (await planCreateFile(efs, w(C), {
      folder: { kind: "home", address: C.address.toLowerCase() as Address },
      name: `${tag}-2.txt`,
      content: text("C again"),
    })) as {
      status: string;
      parts: unknown[];
      review: { file: { subject: SubjectId }; revision: RecordId };
    };
    if (made.status !== "PLANNED") throw new Error(made.status);
    expect((await w(C).runSequence(made.parts as never)).state).toBe("COMPLETE");
    const input = {
      file: { kind: "file" as const, subject: made.review.file.subject },
      base: { kind: "revision" as const, recordId: made.review.revision },
      content: text("A's"),
      lens: { principals: [w(B).principal, w(C).principal, w(A).principal] },
    };
    expect((await planEditFile(efs, w(A), input)).status).toBe("PLANNED");
    // Each lie told consistently in heads() and headSnapshots (so the snapshot consistency check passes): only the
    // edit's own checks against the Lens selection can refuse it, before any review.
    const real = await planEditFile(efs, w(A), input);
    if (real.status !== "PLANNED") throw new Error(real.status);
    type Row = Record<string, unknown>;
    type Lie = {
      state: number;
      revision: bigint;
      admission: bigint;
      targetKind: number;
      target: Hex;
    };
    const consistent = (index: number, lie: Lie) =>
      createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch: tampered({
          [sel(ledgerViewsAbi, "heads")]: (result) => {
            const [rows, b] = decodeFunctionResult({
              abi: ledgerViewsAbi,
              functionName: "heads",
              data: result,
            }) as unknown as [Row[], unknown];
            const edited = rows.map((r, k) => (k === index ? { ...r, ...lie } : r));
            return encodeFunctionResult({
              abi: ledgerViewsAbi,
              functionName: "heads",
              result: [edited, b] as never,
            }) as Hex;
          },
          [sel(ledgerViewsAbi, "headSnapshots")]: (result) => {
            const [snaps, targets] = decodeFunctionResult({
              abi: ledgerViewsAbi,
              functionName: "headSnapshots",
              data: result,
            }) as unknown as [Hex[], Hex[]];
            const hash = headSnapshotHash(lie.state, lie.revision, lie.admission, lie.target);
            return encodeFunctionResult({
              abi: ledgerViewsAbi,
              functionName: "headSnapshots",
              result: [
                snaps.map((x, k) => (k === index ? hash : x)),
                targets.map((x, k) => (k === index ? lie.target : x)),
              ] as never,
            }) as Hex;
          },
        }),
      });
    const T = `0x${"3c".repeat(32)}` as Hex;
    // B, before the base's author, reported BOUND (it would have decided)
    expect(
      await planEditFile(
        consistent(0, { state: 1, revision: 1n, admission: 5n, targetKind: 2, target: T }),
        w(A),
        input,
      ),
    ).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
    // B reported MASKED (it would have hidden the file under this Lens)
    expect(
      await planEditFile(
        consistent(0, { state: 2, revision: 1n, admission: 5n, targetKind: 0, target: ZERO_WORD }),
        w(A),
        input,
      ),
    ).toMatchObject({ status: "UNKNOWN", reason: { code: "RPC_ERROR" } });
    // C, the base's author, reported at another target, or not BOUND
    const c = real.parts.at(-1)?.guard?.[1];
    if (!c) throw new Error("no guarded head for C");
    const head = await ledgerHead(w(C).principal, c.position);
    expect(await planEditFile(consistent(1, { ...head, target: T }), w(A), input)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
    expect(await planEditFile(consistent(1, { ...head, state: 3 }), w(A), input)).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
  }, 120_000);
});
