// SPDX-License-Identifier: MIT
// The guard's acceptance test (S5): the write-path audit's GAP S and GAP T rows, each a lie told consistently in every
// read of one head (LedgerViews.heads, headsAt, headSnapshots, and a restore's history), so it passes every check the
// SDK can make on one endpoint and reaches the chain. Unguarded, each lands a save the person did NOT review; guarded,
// the chain refuses it (E_READSET_STALE) and nothing changes:
//   - create over your own bound entry (reported RELEASED at its true revision): the create rebinds it;
//   - unhide (your bound entry reported MASKED): the RELEASE removes your live entry;
//   - hide (your bound entry reported RELEASED, so another author's shows): the UNBIND masks your own;
//   - move (your entry's target reported as another file): the move places the other file;
//   - restore (the stored target and the history name another file): the restore places the other file.
// Accounts 62 and 63 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { type GuardMode, headSnapshotHash } from "../../src/actions/guard.ts";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs, type Efs } from "../../src/client.ts";
import { type Address, type Hex, lower, type PrincipalId, ZERO_WORD } from "../../src/core/hex.ts";
import {
  planCreateFile,
  planHideEntries,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
  planUnhideEntries,
} from "../../src/files/entries.ts";
import { ledgerViewsAbi } from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { bindingKey, positionKey } from "../../src/protocol/keys.ts";
import { planOtherEntry } from "../../src/testing/index.ts";
import { sel, tamperedCalls } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const d = efs.deployment;
const MNEMONIC = "test test test test test test test test test test test junk";
const A = mnemonicToAccount(MNEMONIC, { addressIndex: 62 });
const B = mnemonicToAccount(MNEMONIC, { addressIndex: 63 });
type W = Awaited<ReturnType<typeof createWriter>>;
let wa: W;
let wb: W;
const homeA = { kind: "home" as const, address: A.address.toLowerCase() as Address };
const text = (s: string) => new TextEncoder().encode(s);
const tag = `gl${Date.now().toString(36)}`;

type Head = { state: number; revision: bigint; admission: bigint; targetKind: number; target: Hex };
type Row = Record<string, unknown>;
const STATE = { BOUND: 1, MASKED: 2, RELEASED: 3 } as const;

const call = async (to: Hex, data: Hex): Promise<Hex> => {
  const r = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  return ((await r.json()) as { result: Hex }).result;
};
/** A head as the honest node holds it now (reads serve the canonical target: 0 unless BOUND). */
const headNow = async (principal: PrincipalId, position: Hex): Promise<Head> => {
  const [[h]] = decodeFunctionResult({
    abi: ledgerViewsAbi,
    functionName: "heads",
    data: await call(
      d.readers.ledgerViews,
      encodeFunctionData({
        abi: ledgerViewsAbi,
        functionName: "heads",
        args: [d.ledger, [bindingKey(principal, position)]],
      }),
    ),
  }) as unknown as [[Head]];
  return {
    state: Number(h.state),
    revision: BigInt(h.revision),
    admission: BigInt(h.admission),
    targetKind: Number(h.targetKind),
    target: lower(h.target),
  };
};
const SEL_HEADS = sel(ledgerViewsAbi, "heads");
const SEL_HEADS_AT = sel(ledgerViewsAbi, "headsAt");
const SEL_SNAPSHOTS = sel(ledgerViewsAbi, "headSnapshots");
const SEL_HISTORY = sel(ledgerViewsAbi, "historyAt");

/**
 * An endpoint that tells one lie about `principal`'s head at `position`, consistently in every read of it: the head
 * (`lie` over the honest row), its snapshot (the lied head hashed over `stored`, the target word it claims to keep, as
 * the ledger hashes it) and its stored target, and with `history`, the target the binding's last bound version had.
 */
async function lyingAbout(
  principal: PrincipalId,
  position: Hex,
  lie: Partial<Head>,
  stored: Hex,
  history?: Hex,
): Promise<Efs> {
  const key = lower(bindingKey(principal, position));
  const me = lower(principal);
  const pos = lower(position);
  const lied = { ...(await headNow(principal, position)), ...lie };
  const snapshot = headSnapshotHash(lied.state, lied.revision, lied.admission, stored);
  const fetch = tamperedCalls((data, result) => {
    const selector = data.slice(0, 10);
    if (selector === SEL_HEADS) {
      const { args } = decodeFunctionData({ abi: ledgerViewsAbi, data });
      const keys = (args as unknown as [Hex, Hex[]])[1].map((k) => lower(k));
      if (!keys.includes(key)) return null;
      const [rows, b] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "heads",
        data: result,
      }) as unknown as [Row[], unknown];
      return encodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "heads",
        result: [rows.map((r, i) => (keys[i] === key ? { ...r, ...lie } : r)), b] as never,
      }) as Hex;
    }
    if (selector === SEL_HEADS_AT) {
      const { args } = decodeFunctionData({ abi: ledgerViewsAbi, data });
      const [, principals, p] = args as unknown as [Hex, Hex[], Hex];
      const i = principals.map((x) => lower(x)).indexOf(me);
      if (lower(p) !== pos || i < 0) return null;
      const [st, selected, idx, all, b] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        data: result,
      }) as unknown as [number, Row, number, Row[], unknown];
      return encodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headsAt",
        result: [
          st,
          selected,
          idx,
          all.map((r, k) => (k === i ? { ...r, ...lie } : r)),
          b,
        ] as never,
      }) as Hex;
    }
    if (selector === SEL_SNAPSHOTS) {
      const { args } = decodeFunctionData({ abi: ledgerViewsAbi, data });
      const [, principals, positions] = args as unknown as [Hex, Hex[], Hex[]];
      const i = principals.map((x) => lower(x)).indexOf(me);
      const j = positions.map((x) => lower(x)).indexOf(pos);
      if (i < 0 || j < 0) return null;
      const k = j * principals.length + i;
      const [snaps, targets] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headSnapshots",
        data: result,
      }) as unknown as [Hex[], Hex[]];
      return encodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "headSnapshots",
        result: [
          snaps.map((x, n) => (n === k ? snapshot : x)),
          targets.map((x, n) => (n === k ? stored : x)),
        ] as never,
      }) as Hex;
    }
    if (history && selector === SEL_HISTORY) {
      const { args } = decodeFunctionData({ abi: ledgerViewsAbi, data });
      if (lower((args as unknown as [Hex, Hex])[1]) !== key) return null;
      const [found, h] = decodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "historyAt",
        data: result,
      }) as unknown as [number, Row];
      if (Number(h["state"]) !== STATE.BOUND) return null;
      return encodeFunctionResult({
        abi: ledgerViewsAbi,
        functionName: "historyAt",
        result: [found, { ...h, target: history }] as never,
      }) as Hex;
    }
    return null;
  });
  return createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch });
}

/** A writer of A's with the given guard mode (the planners read it; the send is the same writer's). */
const as = (guard: GuardMode) => ({ principal: wa.principal, guard });
const planned = async <T extends { status: string }>(p: Promise<T>) => {
  const r = await p;
  if (r.status !== "PLANNED") throw new Error(`not planned: ${JSON.stringify(r)}`);
  return r as T & { parts: Parameters<W["runSequence"]>[0] };
};
const run = (p: { parts: Parameters<W["runSequence"]>[0] }) => wa.runSequence(p.parts);
/** A new file of A's at `name` in A's home: its FOLDER position and its subject. */
async function fileAt(name: string): Promise<{ position: Hex; file: Hex }> {
  const p = await planned(planCreateFile(efs, wa, { folder: homeA, name, content: text(name) }));
  expect((await run(p)).state).toBe("COMPLETE");
  const bind = p.parts.at(-1)?.actions.find((a) => a.purpose === PURPOSES.folder);
  if (!bind) throw new Error("no folder bind");
  return {
    position: lower(positionKey(bind.purpose, bind.subject, bind.role)),
    file: lower(bind.target),
  };
}
const refusedByTheGuard = async (p: { parts: Parameters<W["runSequence"]>[0] }) => {
  const out = await run(p);
  expect(out.state).not.toBe("COMPLETE");
  expect(out.reason).toMatchObject({ code: "STALE", revert: { error: "E_READSET_STALE" } });
};

beforeAll(async () => {
  for (const a of [A, B])
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
  wa = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: A },
    journal: memoryJournal(),
  });
  wb = await createWriter(efs, {
    authorizer: { kind: "local", profile: "direct", account: B },
    journal: memoryJournal(),
  });
}, 60_000);

describe("each GAP S and GAP T lie: unguarded it lands the save not reviewed; guarded the chain refuses it", () => {
  it("create over your own bound entry, reported RELEASED", async () => {
    for (const mode of ["auto", "never"] as const) {
      const name = `${tag}-create-${mode}.txt`;
      const { position, file } = await fileAt(name);
      const lying = await lyingAbout(
        wa.principal,
        position,
        { state: STATE.RELEASED, target: ZERO_WORD },
        file,
      );
      const p = await planned(
        planCreateFile(lying, as(mode), { folder: homeA, name, content: text("a new file") }),
      );
      if (mode === "auto") {
        await refusedByTheGuard(p);
        expect((await headNow(wa.principal, position)).target).toBe(file); // your entry is untouched
      } else {
        expect((await run(p)).state).toBe("COMPLETE");
        expect((await headNow(wa.principal, position)).target).not.toBe(file); // rebound over your entry
      }
    }
  }, 240_000);

  it("unhide of your bound entry, reported MASKED", async () => {
    for (const mode of ["auto", "never"] as const) {
      const name = `${tag}-unhide-${mode}.txt`;
      const { position, file } = await fileAt(name);
      const lying = await lyingAbout(
        wa.principal,
        position,
        { state: STATE.MASKED, target: ZERO_WORD },
        file,
      );
      const p = await planned(
        planUnhideEntries(lying, as(mode), { entries: [{ folder: homeA, name }] }),
      );
      if (mode === "auto") {
        await refusedByTheGuard(p);
        expect((await headNow(wa.principal, position)).state).toBe(STATE.BOUND);
      } else {
        expect((await run(p)).state).toBe("COMPLETE");
        expect((await headNow(wa.principal, position)).state).toBe(STATE.RELEASED); // your live entry, removed
      }
    }
  }, 240_000);

  it("hide of another author's entry, your own bound one reported RELEASED", async () => {
    for (const mode of ["auto", "never"] as const) {
      const name = `${tag}-hide-${mode}.txt`;
      const { position, file } = await fileAt(name);
      // B's entry at the same name in A's home, which a Lens [A, B] shows once A's is (falsely) gone
      const other = await planned(planOtherEntry(efs, wb, { folder: homeA, name }));
      expect((await wb.runSequence(other.parts)).state).toBe("COMPLETE");
      const lying = await lyingAbout(
        wa.principal,
        position,
        { state: STATE.RELEASED, target: ZERO_WORD },
        file,
      );
      const p = await planned(
        planHideEntries(lying, as(mode), {
          entries: [{ folder: homeA, name }],
          lens: { principals: [wa.principal, wb.principal] },
        }),
      );
      if (mode === "auto") {
        await refusedByTheGuard(p);
        expect((await headNow(wa.principal, position)).state).toBe(STATE.BOUND);
      } else {
        expect((await run(p)).state).toBe("COMPLETE");
        expect((await headNow(wa.principal, position)).state).toBe(STATE.MASKED); // your own entry, masked
      }
    }
  }, 240_000);

  it("move of your entry, its target reported as another file", async () => {
    for (const mode of ["auto", "never"] as const) {
      const name = `${tag}-move-${mode}.txt`;
      const { position, file } = await fileAt(name);
      const decoy = (await fileAt(`${tag}-decoy-${mode}.txt`)).file;
      const lying = await lyingAbout(wa.principal, position, { target: decoy }, decoy);
      const to = `${tag}-moved-${mode}.txt`;
      const p = await planned(
        planMoveEntries(lying, as(mode), {
          moves: [{ from: { folder: homeA, name }, to: { name: to } }],
        }),
      );
      if (mode === "auto") {
        await refusedByTheGuard(p);
        expect((await headNow(wa.principal, position)).target).toBe(file);
      } else {
        expect((await run(p)).state).toBe("COMPLETE");
        const moved = p.parts.at(-1)?.actions.find((a) => a.kind === ACTION.BIND);
        expect(lower(moved?.target as Hex)).toBe(decoy); // the other file is what was placed
        expect((await headNow(wa.principal, position)).state).toBe(STATE.RELEASED);
      }
    }
  }, 240_000);

  it("restore of your removed entry, its stored target and history reported as another file", async () => {
    for (const mode of ["auto", "never"] as const) {
      const name = `${tag}-restore-${mode}.txt`;
      const { position, file } = await fileAt(name);
      const rm = await planned(planRemoveEntries(efs, wa, { entries: [{ folder: homeA, name }] }));
      expect((await run(rm)).state).toBe("COMPLETE");
      const decoy = (await fileAt(`${tag}-rdecoy-${mode}.txt`)).file;
      const lying = await lyingAbout(wa.principal, position, {}, decoy, decoy);
      const p = await planned(
        planRestoreEntries(lying, as(mode), { entries: [{ folder: homeA, name }] }),
      );
      expect(lower(p.parts[0]?.actions[0]?.target as Hex)).toBe(decoy);
      if (mode === "auto") {
        await refusedByTheGuard(p);
        expect((await headNow(wa.principal, position)).state).toBe(STATE.RELEASED);
      } else {
        expect((await run(p)).state).toBe("COMPLETE");
        const now = await headNow(wa.principal, position);
        expect([now.state, now.target]).toEqual([STATE.BOUND, decoy]); // the other file, restored
        expect(now.target).not.toBe(file);
      }
    }
  }, 240_000);
});
