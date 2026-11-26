// SPDX-License-Identifier: MIT
// Later statements on the fixture, priced by the list release's rows (contracts 04526b1 item 57; gas/model.json
// laterRows): the planners choose each later BIND's row from the head they already read, and the splitter corrects it
// for the statement's own position by the binding's history word, both ways, from its expected revision:
//   - a yes after a lone no: bindTagAfterNo (the kernel's fresh target slot and the history word are in the row);
//   - a no, its release, then a yes: the same row less the history word (revision 2 opens none);
//   - a restore that is the binding's 6th statement (revision 5): restoreTag plus the history word; as the 5th, the row;
//   - a "same as" restored as the 11th statement: the history word, against the 9th;
//   - a folder placed at a lone-hidden name (bindFolderAfterNo) against one placed where your entry was removed
//     (restoreFolder, measured placing a new target: the kernel's rewrite is in the row);
//   - a label set again after its removal: restoreProperty (a later statement), never the re-bind row;
//   - an edit where your own HEAD is a lone "not this" (bindHeadAfterNo), or a version you released (restoreHead),
//     against an edit of a file you never stated (bindHeadFresh): the only SDK flow that binds a HEAD that is neither
//     UNSET nor BOUND.
// Each is compared with a control at a head that bound before and opens no history word, so the plans differ only by
// the row and the position. A part's planned gas is intrinsic + calldata + max(E, V), and for a single later statement
// V is above E, so on the real model only K's difference shows. Each case is planned twice: with the vendored model (what
// an app gets) and with the same model whose kernel constants are zero (floorMismatch compares the work model and limits,
// not these), where V is E plus a constant and E's difference shows. Every planned yes is then sent: the kernel admits
// it at the planned gas. Account 34 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { type GasConstants, type GasModel, gasPlanFor } from "../../src/actions/split.ts";
import { createEfs } from "../../src/client.ts";
import type { Address, Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { openFile } from "../../src/files/bytes.ts";
import { planEditFile } from "../../src/files/edit.ts";
import { planCreateFolder, planRemoveEntries } from "../../src/files/entries.ts";
import type { FolderRef } from "../../src/files/folders.ts";
import { ACTION, PURPOSES } from "../../src/generated/constants.ts";
import { planDeny, planLabel, planSame, planTag, planUntag } from "../../src/tags/index.ts";
import { planLoneHide } from "../../src/testing/index.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  root: { directoryRecordId: RecordId };
  seed: { files: { name: string; subjectId: SubjectId }[] };
};
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const root: FolderRef = { kind: "folder", directory: deployment.root.directoryRecordId };
const me = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 34,
});
let w: Awaited<ReturnType<typeof createWriter>>;
let E: GasConstants; // the fixture's E constants (prague: all gas)
let K: GasConstants; // the kernel's shares

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
const send = async (r: Planned) =>
  expect((await w.runSequence(r.parts as never)).state).toBe("COMPLETE");
const run = async (p: Promise<unknown>) => send(await planned(p));
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
const topic = ["later-rows-tags"];
const on = (n: number, number?: number) => ({
  topic,
  targets: [{ kind: "address" as const, address: addr(n) }],
  ...(number !== undefined ? { number } : {}),
});
/** A yes at a head that bound before and opens no history word (a yes, a mask, restored: revision 2), both ways. */
let control = { real: 0, e: 0 };
/** A planned yes's gas both ways, less the control's; then it is sent. */
const yesExtra = async (n: number) => {
  const real = await planned(planTag(efs, w, on(n)));
  const e = gasOf(await planned(planTag(efs, w, on(n), { gasModel: eVisible() })));
  const out = { real: gasOf(real) - control.real, e: e - control.e };
  await send(real);
  return out;
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
  const g = gasPlanFor(efs.deployment);
  if (!g.ok) throw new Error(g.reason.code);
  E = g.model;
  K = (g.model.floor as NonNullable<GasModel["floor"]>).kernel;
  await run(planTag(efs, w, on(100)));
  await run(planDeny(efs, w, on(100)));
  control = {
    real: gasOf(await planned(planTag(efs, w, on(100)))),
    e: gasOf(await planned(planTag(efs, w, on(100), { gasModel: eVisible() }))),
  };
});

describe("later statements priced by the list release's rows (fixture)", () => {
  it("the fixture's history word: 17,100 in E, none in K", () => {
    expect([E.historyWordOpen, K.historyWordOpen]).toEqual([17_100, 0]);
  });

  it("a yes after a lone no: bindTagAfterNo, against a restore", async () => {
    await run(planDeny(efs, w, on(1)));
    expect(await yesExtra(1)).toEqual({
      real: K.bindTagAfterNoLongNewPlace - K.restoreTagLongNewPlace,
      e: E.bindTagAfterNoLongNewPlace - E.restoreTagLongNewPlace,
    });
  });

  it("a no, its release, then a yes: the same row less the history word (revision 2 opens none)", async () => {
    await run(planDeny(efs, w, on(2)));
    await run(planUntag(efs, w, on(2)));
    expect(await yesExtra(2)).toEqual({
      real: K.bindTagAfterNoLongNewPlace - K.restoreTagLongNewPlace,
      e: E.bindTagAfterNoLongNewPlace - E.historyWordOpen - E.restoreTagLongNewPlace,
    });
  });

  it("a restore that is the binding's 6th statement: the history word, in E only; as the 5th, nothing", async () => {
    await run(planTag(efs, w, on(3))); // 1
    await run(planDeny(efs, w, on(3))); // 2
    await run(planTag(efs, w, on(3))); // 3: a restore
    await run(planTag(efs, w, on(3, 7))); // 4: a number change
    await run(planDeny(efs, w, on(3))); // 5: a mask
    expect(await yesExtra(3)).toEqual({ real: 0, e: E.historyWordOpen });
    await run(planTag(efs, w, on(4))); // 1
    await run(planDeny(efs, w, on(4))); // 2
    await run(planTag(efs, w, on(4))); // 3
    await run(planDeny(efs, w, on(4))); // 4
    expect(await yesExtra(4)).toEqual({ real: 0, e: 0 });
  });

  it('topic statements: a "same as" restored as the binding\'s 11th statement pays the history word; as the 9th, nothing', async () => {
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
      const real = await planned(same(topic, other));
      const out = {
        real: gasOf(real),
        e: gasOf(await planned(same(topic, other, false, eVisible()))),
      };
      await send(real);
      return out;
    };
    const ninth = await restoreAfter(["lr-same-a"], ["lr-same-b"], 8);
    const eleventh = await restoreAfter(["lr-same-c"], ["lr-same-d"], 10);
    expect({ real: eleventh.real - ninth.real, e: eleventh.e - ninth.e }).toEqual({
      real: 0,
      e: E.historyWordOpen,
    });
  }, 240_000);

  it("a label set again after its removal is a restore (restoreProperty), never the re-bind row", async () => {
    const label = (text?: string, gasModel?: GasModel) =>
      planLabel(
        efs,
        w,
        { topic: ["lr-label"], lang: "en", ...(text ? { text } : { remove: true }) },
        gasModel ? { gasModel } : {},
      );
    await run(label("first"));
    const rebind = gasOf(await planned(label("second", eVisible())));
    await run(label()); // removed (a RELEASE): revision 2
    const restore = await planned(label("second"));
    const restoreE = gasOf(await planned(label("second", eVisible())));
    // the same text record either way (published by neither plan: "second" is new to both, so both publish it)
    expect(restoreE - rebind).toBe(E.restorePropertyLongNewPlace - E.bindPropertyRebind);
    await send(restore);
  });

  it("edits: your HEAD after a lone no is bindHeadAfterNo, after a release restoreHead, against a fresh HEAD", async () => {
    const ZERO = `0x${"0".repeat(64)}` as Hex;
    /** A HEAD statement the SDK's planners never make: your "not this" (UNBIND) or a release of your version. */
    const headStatement = async (kind: number, subject: SubjectId, expectedRevision: bigint) => {
      const raw = await w.planActions({
        actions: [
          {
            kind,
            typeId: ZERO,
            bodyHashOrRecordId: ZERO,
            purpose: PURPOSES.head,
            subject,
            role: ZERO,
            target: ZERO,
            expectedRevision,
            saltOrStrength: ZERO,
          },
        ],
        bodies: ["0x"],
        effects: [{ code: "test.head", args: {} }],
      });
      if (raw.status !== "PLANNED") throw new Error(raw.status);
      expect((await w.run(raw.plan)).reconcile?.outcome).toBe("COMMITTED");
    };
    /** An edit of a seeded file (the default Lens shows the seeder's version): its gas with E visible. */
    const edit = async (subject: SubjectId, content: string, gasModel?: GasModel) => {
      const o = await openFile(efs, { kind: "file", subject });
      if (o.status !== "PRESENT") throw new Error(o.status);
      return planned(
        planEditFile(
          efs,
          w,
          {
            file: { kind: "file", subject },
            base: { kind: "revision", recordId: o.file.revision },
            content: new TextEncoder().encode(content),
            mediaType: "",
          },
          gasModel ? { gasModel } : {},
        ),
      );
    };
    // One file throughout, so every plan publishes a record of the same length: the rows alone differ.
    const a = deployment.seed.files.find((f) => f.name === "readme.txt")?.subjectId as SubjectId;
    const fresh = gasOf(await edit(a, "lr-edit", eVisible())); // you never stated its HEAD: bindHeadFresh
    await headStatement(ACTION.UNBIND, a, 0n); // a lone "not this": MASKED, never bound, revision 1
    const afterNo = await edit(a, "lr-edit");
    expect(gasOf(await edit(a, "lr-edit", eVisible())) - fresh).toBe(
      E.bindHeadAfterNo - E.bindHeadFresh,
    );
    await send(afterNo); // the validator and the kernel admit a yes after a lone no on HEAD
    await headStatement(ACTION.RELEASE, a, 2n); // your version released: RELEASED, it bound, revision 3
    const restore = await edit(a, "lr-edi2"); // a new revision of the same length
    expect(gasOf(await edit(a, "lr-edi2", eVisible())) - fresh).toBe(
      E.restoreHead - E.bindHeadFresh,
    );
    await send(restore);
  });

  it("folders: a folder placed at a lone-hidden name (bindFolderAfterNo), against one placed where your entry was removed (restoreFolder)", async () => {
    const made = await planned(planCreateFolder(efs, w, { folder: root, name: "later-rows-test" }));
    await send(made);
    const here = made.review?.created as FolderRef;
    const lone = await planLoneHide(efs, w, { folder: here, name: "lone" });
    if (lone.status !== "PLANNED") throw new Error(lone.status);
    expect((await w.runSequence(lone.parts)).state).toBe("COMPLETE"); // never bound, revision 1
    await run(planCreateFolder(efs, w, { folder: here, name: "gone" }));
    await run(planRemoveEntries(efs, w, { entries: [{ folder: here, name: "gone" }] })); // bound, revision 2
    const both = async (name: string) => {
      const real = await planned(planCreateFolder(efs, w, { folder: here, name }));
      const out = {
        real: gasOf(real),
        e: gasOf(
          await planned(planCreateFolder(efs, w, { folder: here, name }, { gasModel: eVisible() })),
        ),
      };
      await send(real);
      return out;
    };
    const atLone = await both("lone");
    const atGone = await both("gone");
    expect({ real: atLone.real - atGone.real, e: atLone.e - atGone.e }).toEqual({
      real: K.bindFolderAfterNoLongNewPlace - K.restoreFolderLongNewPlace,
      e: E.bindFolderAfterNoLongNewPlace - E.restoreFolderLongNewPlace,
    });
  });
});
