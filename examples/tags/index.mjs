// SPDX-License-Identifier: MIT
// EFS SDK v0.1, homes, tags and names: put a file in your home (your address), tag it into a topic, name the topic,
// and read it all back the way a person sees it, on a local fixture chain (`anvil` on PATH). Every step is asserted,
// so CI fails if this stops being true.
import assert from "node:assert/strict";
import { startFixtureChain } from "@efs/fixture";
import { createEfs } from "@efs/sdk";
import { createWriter, memoryJournal } from "@efs/sdk/actions";
import { listFolder, openHome, planCreateFile } from "@efs/sdk/files";
import {
  fileNames,
  lensTagsOf,
  planLabel,
  planTag,
  topicItems,
  topicName,
  wordPage,
} from "@efs/sdk/tags";

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
  const save = async (plan) => {
    assert.equal(
      plan.status,
      "PLANNED",
      JSON.stringify(plan.refused ?? plan.reason ?? plan.code ?? plan.status),
    );
    const done = await writer.runSequence(plan.parts);
    assert.equal(done.state, "COMPLETE");
    return { review: plan.review, effect: done.effect };
  };

  // 1. Your home: your address as a folder parent. Anyone may attach entries to anyone's address; it opens under the
  //    reader, then the address's own identity (its owner, true only as of this read: never cache it).
  const home = await openHome(efs, me, { reader: me });
  assert.equal(home.status, "PRESENT");
  const lens = home.lens;
  const made = await save(
    await planCreateFile(efs, writer, {
      folder: home.home,
      name: "hello.txt",
      content: text("hi\n"),
      lens,
    }),
  );
  const file = made.review.file;
  const listed = await listFolder(efs, home.home, { lens });
  assert.equal(listed.status, "PRESENT");
  assert.deepEqual(
    listed.rows.map((r) => [r.name, r.author]),
    [["hello.txt", writer.principal]],
  );
  say("home", `hello.txt in ${me.slice(0, 8)}…'s home`);

  // 2. Tag it into a topic. Words are checked against the chain's grammar as given until the fold rule is ruled:
  //    "Notes" (uppercase) is refused before anything is read, so fold what people type first.
  await assert.rejects(
    planTag(efs, writer, { topic: ["Notes"], targets: [file] }),
    /not a word the chain admits/,
  );
  const tagged = await save(await planTag(efs, writer, { topic: ["notes"], targets: [file] }));
  assert.deepEqual(
    tagged.review.newTopics.map((t) => t.words),
    [["notes"]],
  ); // registered in the same save
  assert.equal(tagged.effect.kind, "tags.tag"); // the save names what it touched
  say("tag", `hello.txt filed in /notes (the topic registered in the same save)`);

  // 3. Read the topic. `finished` is true only when the chain said the list ended: a short or empty page with
  //    `finished: false` means "read on" with `next`, never "that's all".
  const items = await topicItems(efs, ["notes"], { view: "mine", lens });
  assert.equal(items.status, "PRESENT");
  assert.equal(items.finished, true);
  assert.deepEqual(
    items.rows.map((r) => [r.thing, r.decider.kind]),
    [[file.subject, "lens"]],
  );
  // Each row says what it is. A created subject is "subject" (a file, or another app's subject) until you ask for the
  // exact tier (its HEAD read too); `kinds: ["file"]` turns it on, so "Files only" never lets another app's subject in.
  assert.equal(items.rows[0].kind, "subject");
  const onlyFiles = await topicItems(efs, ["notes"], { view: "mine", lens, kinds: ["file"] });
  assert.equal(onlyFiles.status, "PRESENT");
  assert.deepEqual(
    onlyFiles.rows.map((r) => r.kind),
    ["file"],
  );
  // And the other way round: this file's tags, as this Lens sees them (tagsOf is the unfiltered list).
  const tags = await lensTagsOf(efs, file.subject, { lens });
  assert.equal(tags.status, "PRESENT");
  assert.deepEqual(
    tags.rows.map((r) => r.topic),
    [items.place],
  );
  say("read", "/notes lists hello.txt, and hello.txt's tags list /notes");

  // 4. Names. A topic's name is a label (per language, lowercased BCP 47) from the Lens, else the word itself; a file
  //    shown in a topic takes its tagger's own name for it, then its creator's. A failed read is UNKNOWN, never "no
  //    name".
  await save(await planLabel(efs, writer, { topic: ["notes"], lang: "en", text: "Notes" }));
  const name = await topicName(efs, ["notes"], { lens, langs: ["en"] });
  assert.equal(name.status, "PRESENT");
  assert.deepEqual(
    name.segments.map((s) => [s.name, s.source]),
    [["Notes", "word"]],
  );
  const names = await fileNames(efs, [{ file: file.subject, tagger: writer.principal }], { lens });
  assert.equal(names.status, "PRESENT");
  assert.deepEqual([names.rows[0].name.text, names.rows[0].name.why], ["hello.txt", "tagger"]);
  // An author as a person should see them: the address, checksummed, never the padded principal id.
  const shown = efs.lens.displayOf(writer.principal);
  assert.equal(shown.kind, "address");
  assert.equal(shown.address.toLowerCase(), me.toLowerCase());
  say("names", `/notes is "Notes"; the file is "hello.txt" by ${shown.address.slice(0, 6)}…`);

  // 5. A word nobody has used is proven absent: never an error, and never "can't be read".
  assert.equal((await wordPage(efs, "never-used")).status, "ABSENT_PROVEN");
  assert.equal((await wordPage(efs, "notes")).status, "PRESENT");
  say("words", "never-used: proven absent; notes: its page lists /notes");
} finally {
  await chain.stop();
}
