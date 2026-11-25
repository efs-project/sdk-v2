// SPDX-License-Identifier: MIT
// Packed-consumer check for the client's live-chain job: the two tarballs, installed as a plain npm consumer, start
// a fixture chain, pin it, edit the seeded readme.txt through an unlocked-account EIP-1193 wallet, read the edit
// back under the default Lens, and stop. Needs `anvil` on PATH.
import assert from "node:assert/strict";
import { startFixtureChain } from "@efs/fixture";
import { createEfs } from "@efs/sdk";
import { createWriter, memoryJournal } from "@efs/sdk/actions";
import { openFile, planEditFile, readBytes } from "@efs/sdk/files";

const chain = await startFixtureChain({ ttlSeconds: 300 });
try {
  const rpc = async (method, params = []) => {
    const res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
  assert.equal((await efs.at("latest")).status, "VERIFIED");
  const me = chain.accounts.fixture.address;
  const wallet = {
    async request({ method, params }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [me];
      return rpc(method, params ?? []);
    },
  };
  const writer = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
    journal: memoryJournal(),
  });
  const readme = chain.seed.files.find((f) => f.name === "readme.txt");
  const file = { kind: "file", subject: readme.subjectId };
  const opened = await openFile(efs, file);
  assert.equal(opened.status, "PRESENT");
  const edit = await planEditFile(efs, writer, {
    file,
    base: { kind: "revision", recordId: opened.file.revision },
    content: new TextEncoder().encode("edited by a packed consumer\n"),
  });
  assert.equal(edit.status, "PLANNED");
  assert.equal((await writer.runSequence(edit.parts)).state, "COMPLETE");
  const after = await openFile(efs, file);
  assert.equal(after.status, "PRESENT");
  assert.equal(
    new TextDecoder().decode((await readBytes(efs, after.file)).bytes),
    "edited by a packed consumer\n",
  );
} finally {
  await chain.stop();
}
