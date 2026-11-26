// SPDX-License-Identifier: MIT
// INTERIM pricing of fresh slots a later yes writes beyond its row (src/actions/split.ts interimNeverBoundBind and
// interimHistoryWord), on the fixture: the tag and folder planners pass each later BIND's head facts (whether it never
// bound, from the head's stored targetKind, and its revision) from the read they already make. Each case is compared
// with the same plan at a head that bound before and opens no history word, so the parts differ only by the facts:
//   - a yes after a lone no (never bound, revision 1): the kernel's slot (E and K) and a history word (E);
//   - a no, its release, then a yes (never bound, revision 2): the kernel's slot only, so exactly one slot more;
//   - a restore that is the binding's 6th statement (revision 5): a history word only (E).
// A part's planned gas is intrinsic + calldata + max(E, V), and V ≥ E plus the kernel's reserve; for a single later
// statement K + the floor's prefix need is above E too, so on the real model only K's slot shows. Each case is planned
// twice: with the vendored model (what an app gets), and with the same model whose kernel constants are zero
// (floorMismatch compares the work model and limits, not these), where V is E plus a constant and E's slots show.
// Account 34 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { type GasModel, gasPlanFor } from "../../src/actions/split.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, RecordId } from "../../src/core/hex.ts";
import { planCreateFolder, planRemoveEntries } from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { planDeny, planSame, planTag, planUntag } from "../../src/tags/index.ts";
import { planLoneHide } from "../../src/testing/index.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 34,
});
const SLOT = 22_100; // the prague fixture's fresh slot (test/vectors/gas-schedules.json)
let w: Awaited<ReturnType<typeof createWriter>>;

type Planned = {
  status: string;
  parts?: { gas?: number }[];
  review?: { created?: FolderRef };
};
const planned = async (p: Promise<unknown>) => {
  const r = (await p) as Planned;
  if (r.status !== "PLANNED") throw new Error(`not planned: ${r.status}`);
  return r;
};
const run = async (p: Promise<unknown>) => {
  const r = await planned(p);
  expect((await w.runSequence(r.parts as never)).state).toBe("COMPLETE");
  return r;
};
/** The vendored model with a kernel that costs nothing, so a part's planned gas moves with E alone. */
const eVisible = (): GasModel => {
  const g = gasPlanFor(efs.deployment);
  if (!g.ok) throw new Error(g.reason.code);
  const zero = (o: unknown): unknown =>
    typeof o === "number"
      ? 0
      : o && typeof o === "object"
        ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, zero(v)]))
        : o;
  const f = g.model.floor as NonNullable<GasModel["floor"]>;
  return { ...g.model, floor: { ...f, kernel: zero(f.kernel) as typeof f.kernel } };
};
/** The single part's planned gas. */
const gasOf = (r: Planned) => {
  expect(r.parts).toHaveLength(1);
  return r.parts?.[0]?.gas as number;
};
const addr = (n: number) => `0x${"b7".repeat(18)}${n.toString(16).padStart(4, "0")}` as Address;
const topic = ["never-bound-tags"];
const on = (n: number, number?: number) => ({
  topic,
  targets: [{ kind: "address" as const, address: addr(n) }],
  ...(number !== undefined ? { number } : {}),
});
/** A yes at a head that bound before and opens no history word (a yes, a mask, restored: revision 2), both ways. */
let control = { real: 0, e: 0 };
/** A planned yes's gas both ways, less the control's. */
const yesExtra = async (n: number) => {
  const real = gasOf(await planned(planTag(efs, w, on(n))));
  const e = gasOf(await planned(planTag(efs, w, on(n), { gasModel: eVisible() })));
  return { real: real - control.real, e: e - control.e };
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
  await run(planTag(efs, w, on(100)));
  await run(planDeny(efs, w, on(100)));
  control = {
    real: gasOf(await planned(planTag(efs, w, on(100)))),
    e: gasOf(await planned(planTag(efs, w, on(100), { gasModel: eVisible() }))),
  };
});

describe("INTERIM: fresh slots a later yes writes beyond its row (fixture)", () => {
  it("a yes after a lone no: the kernel's slot (E and K) and a history word (E)", async () => {
    await run(planDeny(efs, w, on(1)));
    expect(await yesExtra(1)).toEqual({ real: SLOT, e: 2 * SLOT });
  });

  it("a no, its release, then a yes: the kernel's slot only", async () => {
    await run(planDeny(efs, w, on(2)));
    await run(planUntag(efs, w, on(2)));
    expect(await yesExtra(2)).toEqual({ real: SLOT, e: SLOT });
  });

  it("a restore that is the binding's 6th statement: a history word, in E only; as the 5th, nothing", async () => {
    await run(planTag(efs, w, on(3))); // 1
    await run(planDeny(efs, w, on(3))); // 2
    await run(planTag(efs, w, on(3))); // 3: a restore
    await run(planTag(efs, w, on(3, 7))); // 4: a number change
    await run(planDeny(efs, w, on(3))); // 5: a mask
    expect(await yesExtra(3)).toEqual({ real: 0, e: SLOT });
    await run(planTag(efs, w, on(4))); // 1
    await run(planDeny(efs, w, on(4))); // 2
    await run(planTag(efs, w, on(4))); // 3
    await run(planDeny(efs, w, on(4))); // 4
    expect(await yesExtra(4)).toEqual({ real: 0, e: 0 });
  });

  it('topic statements: a "same as" restored as the binding\'s 11th statement pays a history word; as the 9th, nothing', async () => {
    const same = (topic: string[], other: string[], remove = false, gasModel?: GasModel) =>
      planSame(
        efs,
        w,
        { topic, other, ...(remove ? { remove: true } : {}) },
        gasModel ? { gasModel } : {},
      );
    /** State `n` statements (a same, then removals and restores in turn), then plan the restore both ways. */
    const restoreAfter = async (topic: string[], other: string[], n: number) => {
      for (let i = 0; i < n; i++) await run(same(topic, other, i % 2 === 1));
      return {
        real: gasOf(await planned(same(topic, other))),
        e: gasOf(await planned(same(topic, other, false, eVisible()))),
      };
    };
    const ninth = await restoreAfter(["nb-same-a"], ["nb-same-b"], 8);
    const eleventh = await restoreAfter(["nb-same-c"], ["nb-same-d"], 10);
    expect({ real: eleventh.real - ninth.real, e: eleventh.e - ninth.e }).toEqual({
      real: 0,
      e: SLOT,
    });
  }, 240_000);

  it("folders: a folder placed at a lone-hidden name, against one placed where your entry was removed", async () => {
    const made = await planned(
      planCreateFolder(efs, w, { folder: root, name: "never-bound-test" }),
    );
    expect((await w.runSequence(made.parts as never)).state).toBe("COMPLETE");
    const here = made.review?.created as FolderRef;
    const lone = await planLoneHide(efs, w, { folder: here, name: "lone" });
    if (lone.status !== "PLANNED") throw new Error(lone.status);
    expect((await w.runSequence(lone.parts)).state).toBe("COMPLETE"); // never bound, revision 1
    await run(planCreateFolder(efs, w, { folder: here, name: "gone" }));
    await run(planRemoveEntries(efs, w, { entries: [{ folder: here, name: "gone" }] })); // bound, revision 2
    const both = async (name: string) => ({
      real: gasOf(await planned(planCreateFolder(efs, w, { folder: here, name }))),
      e: gasOf(
        await planned(planCreateFolder(efs, w, { folder: here, name }, { gasModel: eVisible() })),
      ),
    });
    const atLone = await both("lone");
    const atGone = await both("gone");
    expect({ real: atLone.real - atGone.real, e: atLone.e - atGone.e }).toEqual({
      real: SLOT,
      e: 2 * SLOT,
    });
  });
});
