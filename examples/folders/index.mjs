// SPDX-License-Identifier: MIT
// EFS SDK v0.1, folders: create a folder and a file under a parent, list it, rename the file, remove it and restore
// it, on a local fixture chain (`anvil` on PATH). Every step is asserted, so CI fails if this stops being true. The
// Realm's shared root is only a stand-in parent here: real folders will live under an address once homes land.
import assert from "node:assert/strict";
import { startFixtureChain } from "@efs/fixture";
import { createEfs } from "@efs/sdk";
import { createWriter, memoryJournal } from "@efs/sdk/actions";
import {
  listFolder,
  lookupEntry,
  planCreateFile,
  planCreateFolder,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
  resolvePath,
} from "@efs/sdk/files";

const say = (step, text) => console.log(`${step.padEnd(8)} ${text}`);
const text = (s) => new TextEncoder().encode(s);

const chain = await startFixtureChain({ ttlSeconds: 600 });
try {
  const rpc = async (method, params = []) => {
    const res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
    return j.result;
  };
  const me = chain.accounts.fixture.address;
  /** Stands in for the person's wallet (EIP-1193): the fixture chain signs for its unlocked account. */
  const wallet = {
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [me];
      return rpc(method, params ?? []);
    },
  };
  const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
  const writer = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: wallet, account: me },
    journal: memoryJournal(),
  });
  const lens = efs.lens.mineFirst(me);
  const save = async (plan) => {
    assert.equal(
      plan.status,
      "PLANNED",
      JSON.stringify(plan.refused ?? plan.reason ?? plan.status),
    );
    const done = await writer.runSequence(plan.parts);
    assert.equal(done.state, "COMPLETE");
    return plan.review;
  };
  const root = { kind: "folder", directory: chain.deployment.root.directoryRecordId }; // a stand-in parent

  // 1. A folder, then a file in it. The parent is always named: there is no default root.
  const made = await save(
    await planCreateFolder(efs, writer, { folder: root, name: "notes", lens }),
  );
  const notes = made.created;
  say("folder", `created "notes" (${made.parts} approval)`);
  const file = await save(
    await planCreateFile(efs, writer, {
      folder: notes,
      name: "todo.txt",
      content: text("buy milk\n"),
      lens,
    }),
  );
  say("file", `created "todo.txt" (${file.layout}, ${file.size} bytes)`);

  // 2. List it: COMPLETE means the whole folder was read; PARTIAL never means "nothing else".
  const page = await listFolder(efs, notes, { lens, withSize: true });
  assert.equal(page.status, "PRESENT");
  assert.deepEqual(page.coverage, { state: "COMPLETE" });
  assert.deepEqual(
    page.rows.map((r) => [r.name, r.kind, r.size]),
    [["todo.txt", "file", 9n]],
  );
  say("list", page.rows.map((r) => `${r.name} (${r.kind}, ${r.size} bytes)`).join(", "));

  // 3. Rename: one atomic step. The file's link keeps working; a path through the old name no longer finds it.
  await save(
    await planMoveEntries(efs, writer, {
      moves: [{ from: { folder: notes, name: "todo.txt" }, to: { name: "done.txt" } }],
      lens,
    }),
  );
  const moved = await resolvePath(efs, { from: notes, segments: ["done.txt"] }, { lens });
  assert.equal(moved.status, "PRESENT");
  assert.deepEqual(moved.target, file.file);
  assert.equal(
    (await resolvePath(efs, { from: notes, segments: ["todo.txt"] }, { lens })).status,
    "ABSENT_PROVEN",
  );
  say("rename", "todo.txt → done.txt; the file's link still opens it");

  // 4. Remove, then restore. Removing releases your entry (the next author's would show); nothing is destroyed.
  const rm = await save(
    await planRemoveEntries(efs, writer, { entries: [{ folder: notes, name: "done.txt" }], lens }),
  );
  assert.equal(rm.entries[0].shownAfter, null); // nobody else in this Lens has a done.txt here
  assert.equal(
    (await lookupEntry(efs, { folder: notes, name: "done.txt" }, { lens })).status,
    "ABSENT_PROVEN",
  );
  say("remove", "done.txt removed from notes");
  await save(
    await planRestoreEntries(efs, writer, { entries: [{ folder: notes, name: "done.txt" }], lens }),
  );
  const back = await lookupEntry(efs, { folder: notes, name: "done.txt" }, { lens });
  assert.equal(back.status, "PRESENT");
  assert.deepEqual(back.selected.target, file.file);
  say("restore", "done.txt is back, pointing at the same file");
} finally {
  await chain.stop();
}
