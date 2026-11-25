// SPDX-License-Identifier: MIT
// EFS SDK v0.1, getting started: pin a deployment, open and read a file, edit it (plan → review → send), and recover
// a save whose wallet answer was lost. It runs against a local fixture chain (`anvil` on PATH) and asserts every
// step, so CI fails if the guide stops being true. Each outcome is printed through the copy rules in copy.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureChain } from "@efs/fixture";
import { createEfs } from "@efs/sdk";
import { createWriter, openJournal } from "@efs/sdk/actions";
import { openFile, planEditFile, readBytes } from "@efs/sdk/files";
import { fileJournal } from "@efs/sdk/node";
import { describeOpen, describePin, describeSave, describeThrow } from "./copy.mjs";

const say = (step, text) => console.log(`${step.padEnd(8)} ${text}`);
const text = (s) => new TextEncoder().encode(s);

const chain = await startFixtureChain({ ttlSeconds: 600 });
const storage = mkdtempSync(join(tmpdir(), "efs-getting-started-"));
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
  /** Stands in for the person's wallet (EIP-1193). Knobs: decline the next send; lose the next answer. */
  const wallet = {
    decline: false,
    loseAnswer: false,
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [me];
      if (method === "eth_sendTransaction" && this.decline) {
        this.decline = false;
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }
      const result = await rpc(method, params ?? []);
      if (method === "eth_sendTransaction" && this.loseAnswer) {
        this.loseAnswer = false;
        throw new Error("the connection dropped"); // it was sent; the answer never arrived
      }
      return result;
    },
  };

  // 1. Pin: check that this RPC really serves the EFS deployment you ship, before showing anything from it.
  const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
  const pin = await efs.at("latest");
  say("pin", describePin(pin));
  assert.equal(pin.status, "VERIFIED");

  // 2. Open and read: a file by its link (subject id), its bytes verified against their sha256.
  const readme = chain.seed.files.find((f) => f.name === "readme.txt");
  const file = { kind: "file", subject: readme.subjectId };
  const opened = await openFile(efs, file);
  say("open", describeOpen(opened));
  assert.equal(opened.status, "PRESENT");
  const read = await readBytes(efs, opened.file);
  assert.equal(read.grade, "VERIFIED");
  say("read", JSON.stringify(new TextDecoder().decode(read.bytes)));

  // 3. Edit: plan (no wallet), show the review, then send. Every send can prompt; a decline is NOT_SENT.
  const journal = fileJournal(join(storage, "journal")); // in a browser: indexedDbJournal() from @efs/sdk/web/journal
  const writer = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: wallet, account: me },
    journal,
  });
  const edit = await planEditFile(efs, writer, {
    file,
    base: { kind: "revision", recordId: opened.file.revision },
    content: text("Hello from the getting-started guide.\n"),
  });
  assert.equal(edit.status, "PLANNED"); // or BASE_CHANGED (reopen), TOO_LARGE, UNKNOWN (try again)
  const r = edit.review;
  say(
    "review",
    `${r.prompts.sequential} approval, ${r.size} bytes, ${r.visibleInLens ? "shows in this view" : "will NOT show in this view"}`,
  );
  const onProgress = (p, e) => {
    if (e.kind === "wallet-request") say("wallet", `approve part ${e.parts[0] + 1} of ${p.total}`);
  };
  wallet.decline = true;
  const declined = await writer.runSequence(edit.parts, { onProgress });
  say("save", describeSave(declined));
  assert.equal(declined.state, "NOT_STARTED");
  assert.equal(declined.reason?.code, "USER_REJECTED");
  const saved = await writer.resume(declined.sequenceId, { onProgress }); // "Try again" is the person's click
  say("save", describeSave(saved));
  assert.equal(saved.state, "COMPLETE");
  const after = await openFile(efs, file);
  assert.equal(after.status, "PRESENT");
  assert.equal(after.file.revision, r.revision);

  // 4. Recover: the wallet sends, its answer is lost, and the page reloads before the transaction is mined.
  await rpc("evm_setAutomine", [false]);
  const again = await planEditFile(efs, writer, {
    file,
    base: { kind: "revision", recordId: after.file.revision },
    content: text("Saved even though the wallet's answer was lost.\n"),
  });
  assert.equal(again.status, "PLANNED");
  wallet.loseAnswer = true;
  const lost = await writer.runSequence(again.parts, { settleMs: 1000, pollMs: 200 }); // a short wait, for the demo
  say("save", describeSave(lost));
  assert.equal(lost.state, "IN_FLIGHT"); // it may have gone out: never "not sent"
  // The reload: a new journal handle on the same storage. Listing and settling open saves needs no wallet, so an app
  // does this on every start. The first edit is still listed too: "Saved · confirming" until it is final.
  const view = openJournal(efs, { journal: fileJournal(join(storage, "journal")) });
  const listed = await view.pendingSequences();
  for (const p of listed) say("reload", describeSave(p));
  assert.equal(listed.find((p) => p.sequenceId === lost.sequenceId)?.state, "IN_FLIGHT");
  await rpc("evm_mine"); // the network includes it
  const settled = await view.reconcileSequence(lost.sequenceId);
  say("settle", describeSave(settled)); // committed, not yet final
  assert.equal(settled.state, "COMPLETE");
  await rpc("evm_setAutomine", [true]);
  await rpc("anvil_mine", ["0x50"]); // anvil finalizes 64 blocks behind the head
  for (const p of await view.pendingSequences()) {
    const done = await view.reconcileSequence(p.sequenceId);
    say("final", describeSave(done));
    assert.equal(done.final, true);
  }
  assert.deepEqual(await view.pendingSequences(), []); // nothing left open; each save was sent exactly once
  assert.equal(
    new TextDecoder().decode((await readBytes(efs, (await openFile(efs, file)).file)).bytes),
    "Saved even though the wallet's answer was lost.\n",
  );

  // 5. A throw says whether anything may have gone out; here it provably did not.
  const thrown = await writer.runSequence([]).catch((e) => e);
  say("throw", describeThrow(thrown));
  assert.equal(thrown.sequenceMayHaveSent, false);
} finally {
  await chain.stop();
  rmSync(storage, { recursive: true, force: true });
}
