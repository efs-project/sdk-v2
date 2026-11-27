// SPDX-License-Identifier: MIT
// The read-set guard on the send path, on the fixture (its Realm has the guard on, capability b0): the snapshot hash is
// the chain's own; a guarded save signs it and lands, "never" signs none and "always" one; an app's own guard
// (planActions) is checked for its grid and limits, signed as given, and enforced by the chain (a wrong expected value
// is STALE, E_READSET_STALE); a stored plan whose guard was altered is RECORD_DAMAGED; a guard the ledger refuses for its
// shape is the SDK's own error (INVARIANT), before any wallet request. Accounts 56 and 57 of anvil's public development
// mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { encodeGuard, headSnapshotHash, type PartGuardHead } from "../../src/actions/guard.ts";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { actionsHash } from "../../src/actions/plan.ts";
import type { ActionData, Plan } from "../../src/actions/types.ts";
import { createEfs } from "../../src/client.ts";
import { type Address, type Hex, lower, type PrincipalId, ZERO_WORD } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planCreateFolder,
  planRemoveEntries,
  planRestoreEntries,
} from "../../src/files/entries.ts";
import { ingressAbi, ledgerAbi, ledgerViewsAbi } from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { bindingKey, nativeIntentDigest, positionKey } from "../../src/protocol/keys.ts";
import { lyingEfs } from "./lying.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const d = efs.deployment;
const MNEMONIC = "test test test test test test test test test test test junk";
const A = mnemonicToAccount(MNEMONIC, { addressIndex: 56 });
const B = mnemonicToAccount(MNEMONIC, { addressIndex: 57 });
const home = (a: { address: string }) => ({
  kind: "home" as const,
  address: a.address.toLowerCase() as Address,
});
const tag = `gs${Date.now().toString(36)}`;
let wa: Awaited<ReturnType<typeof createWriter>>;

const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
const call = (to: Hex, data: Hex) => rpc("eth_call", [{ to, data }, "latest"]) as Promise<Hex>;
type Head = { state: number; revision: bigint; admission: bigint; targetKind: number; target: Hex };
const headOf = async (principal: PrincipalId, position: Hex): Promise<Head> => {
  const out = await call(
    d.readers.ledgerViews,
    encodeFunctionData({
      abi: ledgerViewsAbi,
      functionName: "heads",
      args: [d.ledger, [bindingKey(principal, position)]],
    }),
  );
  const [[h]] = decodeFunctionResult({
    abi: ledgerViewsAbi,
    functionName: "heads",
    data: out,
  }) as unknown as [[Head]];
  return h;
};
/** A new folder entry of A's in A's home: its FOLDER position and the part that bound it. */
const folderOf = async (name: string) => {
  const r = await planCreateFolder(efs, wa, { folder: home(A), name });
  if (r.status !== "PLANNED") throw new Error(r.status);
  const bind = r.parts[0]?.actions.find((a) => a.kind === ACTION.BIND) as ActionData;
  return { plan: r, position: lower(positionKey(bind.purpose, bind.subject, bind.role)), bind };
};

beforeAll(async () => {
  for (const a of [A, B]) await rpc("anvil_setBalance", [a.address, "0x56bc75e2d63100000"]);
  wa = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: A },
    journal: memoryJournal(),
  });
}, 60_000);

describe("the read-set guard on the fixture (its Realm has the guard)", () => {
  it("the deployment says so, and the snapshot hash is the chain's own", async () => {
    expect(d.nativeGuard).toBe(true);
    const cases: [number, bigint, bigint, Hex][] = [
      [0, 0n, 0n, ZERO_WORD],
      [1, 1n, 7n, `0x${"ab".repeat(32)}` as Hex],
      [2, 5n, 900n, `0x${"cd".repeat(32)}` as Hex],
      [3, 2n ** 63n, 2n ** 64n - 1n, `0x${"01".repeat(32)}` as Hex],
    ];
    for (const [state, revision, admission, target] of cases) {
      const out = await call(
        d.ingress,
        encodeFunctionData({
          abi: ingressAbi,
          functionName: "headSnapshotHash",
          args: [state, revision, admission, target],
        }),
      );
      expect(headSnapshotHash(state, revision, admission, target)).toBe(lower(out));
    }
  });

  it('a save by an "auto" writer is guarded and lands; "never" plans none, "always" one', async () => {
    const f = await folderOf(`${tag}-auto`);
    const at = f.plan.parts[0]?.actions.findIndex((a) => a.kind === ACTION.BIND);
    expect(f.plan.parts[0]?.guard).toMatchObject([
      { principal: wa.principal, position: f.position, action: at, term: "written" },
    ]);
    expect((await wa.runSequence(f.plan.parts)).state).toBe("COMPLETE");
    const never = await planCreateFolder(
      efs,
      { principal: wa.principal, guard: "never" },
      { folder: home(A), name: `${tag}-never` },
    );
    expect(never.status === "PLANNED" && never.parts[0]?.guard).toBeUndefined();
    const always = await planCreateFolder(
      efs,
      { principal: wa.principal, guard: "always" },
      { folder: home(A), name: `${tag}-always` },
    );
    expect(always.status === "PLANNED" && always.parts[0]?.guard?.length).toBe(1);
  });

  it("an app's own guard (planActions) is checked for its grid, signed as given, and enforced by the chain", async () => {
    const f = await folderOf(`${tag}-own`);
    expect((await wa.runSequence(f.plan.parts)).state).toBe("COMPLETE");
    const h = await headOf(wa.principal, f.position);
    expect(Number(h.state)).toBe(1);
    const unbind: ActionData = {
      ...f.bind,
      kind: ACTION.UNBIND,
      target: ZERO_WORD,
      expectedRevision: BigInt(h.revision),
    };
    const head = (expected: Hex, action = 0): PartGuardHead => ({
      principal: wa.principal,
      position: f.position,
      expected,
      term: "written",
      action,
    });
    const truth = headSnapshotHash(1, BigInt(h.revision), BigInt(h.admission), lower(h.target));
    const plan = (guard: PartGuardHead[]) =>
      wa.planActions({ actions: [unbind], bodies: ["0x"], effects: [], guard });
    // refused before any read: an action it doesn't have, no grid, over the limits
    expect(await plan([head(truth, 1)])).toMatchObject({
      status: "REFUSED",
      reason: { code: "INVALID" },
    });
    const elsewhere = {
      ...head(truth),
      principal: keyOf(B.address),
      position: `0x${"11".repeat(32)}` as Hex,
    };
    expect(await plan([head(truth), elsewhere])).toMatchObject({
      status: "REFUSED",
      reason: { code: "INVALID" },
    });
    const many = Array.from({ length: 129 }, (_, i) => ({
      ...head(truth),
      position: `0x${(0x9000 + i).toString(16).padStart(64, "0")}` as Hex,
    }));
    expect(await plan(many)).toMatchObject({
      status: "REFUSED",
      reason: { code: "LIMIT_EXCEEDED" },
    });
    // a wrong expected value (the head claimed MASKED at its true revision): the chain refuses it, STALE
    const wrong = headSnapshotHash(2, BigInt(h.revision), BigInt(h.admission), lower(h.target));
    const lie = await plan([head(wrong)]);
    if (lie.status !== "PLANNED") throw new Error(lie.status);
    // signed exactly as given: the app owns its expected values
    expect(lie.plan.guard).toBe(encodeGuard([head(wrong)]));
    const stale = await wa.send(lie.plan);
    expect(stale).toMatchObject({ status: "STALE", revert: { error: "E_READSET_STALE" } });
    // the truth lands
    const ok = await plan([head(truth)]);
    if (ok.status !== "PLANNED") throw new Error(ok.status);
    const sent = await wa.run(ok.plan);
    expect(sent.reconcile?.outcome).toBe("COMMITTED");
    expect(Number((await headOf(wa.principal, f.position)).state)).toBe(2);
  }, 120_000);

  it("a stored plan with an altered guard is RECORD_DAMAGED; one the ledger refuses for its shape is INVARIANT, unsent", async () => {
    const f = await folderOf(`${tag}-forged`);
    const planned = await wa.planActions({
      actions: f.plan.parts[0]?.actions as ActionData[],
      bodies: f.plan.parts[0]?.bodies as Hex[],
      effects: [],
      guard: f.plan.parts[0]?.guard as PartGuardHead[],
    });
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const p = planned.plan;
    expect(p.guard).toBeDefined();
    // another guard, the calldata and digest left as signed: not the publication it names
    const other = encodeGuard([
      {
        ...(f.plan.parts[0]?.guard?.[0] as PartGuardHead),
        expected: `0x${"77".repeat(32)}` as Hex,
      },
    ]);
    await expect(wa.send({ ...p, guard: other })).rejects.toMatchObject({ code: "RECORD_DAMAGED" });
    // a guard whose expected heads are not n·m long (E_READSET_SHAPE 3), the plan re-derived so it is self-consistent
    const bad = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "principals", type: "bytes32[]" },
            { name: "positions", type: "bytes32[]" },
            { name: "expectedHeads", type: "bytes32[]" },
          ],
        },
      ],
      [
        {
          principals: [wa.principal],
          positions: [f.position, `0x${"12".repeat(32)}`],
          expectedHeads: [ZERO_WORD],
        },
      ],
    );
    const forged = rebuilt(p, bad);
    await expect(wa.send(forged)).rejects.toMatchObject({
      code: "INVARIANT",
      details: { revert: { error: "E_READSET_SHAPE" } },
    });
    expect(await wa.pending()).not.toContainEqual(expect.objectContaining({ stage: "SUBMITTED" }));
  });
});

describe("the guard's consistency check: an endpoint's snapshots are compared, never copied", () => {
  const snapshotsLie = (edit: (snaps: Hex[], targets: Hex[]) => [Hex[], Hex[]]) =>
    lyingEfs(fixture.rpcUrl, deployment, ledgerViewsAbi, "headSnapshots", ([snaps, targets]) =>
      edit(snaps as Hex[], targets as Hex[]),
    );
  it("a snapshot that is not the hash of the endpoint's own head read fails over: no review is shown", async () => {
    const lying = snapshotsLie((snaps, targets) => [
      snaps.map(() => `0x${"99".repeat(32)}` as Hex),
      targets,
    ]);
    expect(await planCreateFolder(lying, wa, { folder: home(A), name: `${tag}-c1` })).toMatchObject(
      {
        status: "UNKNOWN",
        reason: { code: "RPC_ERROR", retry: "transient" },
      },
    );
    // unguarded, the snapshots are never read
    expect(
      (
        await planCreateFolder(
          lying,
          { principal: wa.principal, guard: "never" },
          { folder: home(A), name: `${tag}-c2` },
        )
      ).status,
    ).toBe("PLANNED");
  });

  it("a restore's target: a lied stored target fails the check; one lied consistently is planned, and the chain refuses it", async () => {
    const name = `${tag}-r.txt`;
    const made = await planCreateFile(efs, wa, {
      folder: home(A),
      name,
      content: new TextEncoder().encode("restore me"),
    });
    if (made.status !== "PLANNED") throw new Error(made.status);
    expect((await wa.runSequence(made.parts)).state).toBe("COMPLETE");
    const rm = await planRemoveEntries(efs, wa, { entries: [{ folder: home(A), name }] });
    if (rm.status !== "PLANNED") throw new Error(rm.status);
    expect((await wa.runSequence(rm.parts)).state).toBe("COMPLETE");
    const forged = `0x${"5e".repeat(32)}` as Hex;
    // the stored target alone replaced: the endpoint's own snapshot (over the true target) disagrees
    const alone = snapshotsLie((snaps, targets) => [snaps, targets.map(() => forged)]);
    expect(
      await planRestoreEntries(alone, wa, { entries: [{ folder: home(A), name }] }),
    ).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
    // both replaced, consistently: the plan restores to the forged target and guards it, and the chain refuses it
    const last = made.parts.at(-1);
    const position = (last?.guard ?? []).find(
      (g) => last?.actions[g.action]?.purpose === PURPOSES.folder,
    )?.position as Hex;
    const h = await headOf(wa.principal, position);
    const consistent = snapshotsLie((snaps, targets) => [
      snaps.map(() =>
        headSnapshotHash(Number(h.state), BigInt(h.revision), BigInt(h.admission), forged),
      ),
      targets.map(() => forged),
    ]);
    const lied = await planRestoreEntries(consistent, wa, { entries: [{ folder: home(A), name }] });
    if (lied.status !== "PLANNED") throw new Error(lied.status);
    expect(lied.parts[0]?.actions[0]?.target).toBe(forged);
    const p = await wa.planSequence(lied.parts);
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(await wa.send(p.plans[0] as Plan)).toMatchObject({
      status: "STALE",
      revert: { error: "E_READSET_STALE" },
    });
    // the honest restore lands, to the file it had
    const honest = await planRestoreEntries(efs, wa, { entries: [{ folder: home(A), name }] });
    if (honest.status !== "PLANNED") throw new Error(honest.status);
    expect(honest.parts[0]?.actions[0]?.target).not.toBe(forged);
    expect((await wa.runSequence(honest.parts)).state).toBe("COMPLETE");
  }, 120_000);
});

const keyOf = (a: string) => `0x${"00".repeat(12)}${a.slice(2).toLowerCase()}` as PrincipalId;
/** A plan re-derived with another guard: the calldata, digest and id are its own, so only the ledger can refuse it. */
function rebuilt(p: Plan, guard: Hex): Plan {
  const ctx = {
    nonce: p.nonce,
    deadline: p.deadline,
    expectedExecutionSet: p.executionSet,
    expectedAcceptanceProfile: p.acceptanceProfile,
  };
  const digest = nativeIntentDigest({
    realmId: p.realmId,
    principal: p.principal,
    nonce: p.nonce,
    deadline: p.deadline,
    expectedExecutionSet: p.executionSet,
    expectedAcceptanceProfile: p.acceptanceProfile,
    guardHash: keccak256(guard),
    actionsHash: actionsHash(p.actions),
  });
  return {
    ...p,
    guard,
    id: digest,
    digest,
    calldata: encodeFunctionData({
      abi: ledgerAbi,
      functionName: "execute",
      args: [p.actions as never, p.bodies, ctx, guard],
    }),
  };
}
