// SPDX-License-Identifier: MIT
// Packed-consumer check: the tarball's entry points import and work under Node (ESM).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkName, createEfs, PROTOCOL_INPUTS, wireSegment } from "@efs/sdk";
import { createWriter, memoryJournal } from "@efs/sdk/actions";
import { openFile } from "@efs/sdk/files";
import { fileJournal } from "@efs/sdk/node";
import { indexedDbJournal } from "@efs/sdk/web/journal";

assert.equal(checkName("readme.txt").status, "VALID");
assert.equal(wireSegment(new TextEncoder().encode("a b")), "a%20b");
assert.equal(typeof createEfs, "function");
assert.equal(typeof openFile, "function");
assert.equal(typeof createWriter, "function");
assert.equal(memoryJournal().durable, false);
assert.match(PROTOCOL_INPUTS.contractsCommit, /^[0-9a-f]{40}$/);
assert.equal(typeof indexedDbJournal, "function"); // importable under Node; needs IndexedDB only when used
const journal = fileJournal(mkdtempSync(join(tmpdir(), "efs-smoke-")));
assert.equal(journal.durable, true);
assert.equal(await journal.withLock("efs:smoke", false, async () => "locked"), "locked");
console.log("smoke-node: ok");
