// SPDX-License-Identifier: MIT
// Packed-consumer check: the tarball's entry points import and work under Node (ESM).
import assert from "node:assert/strict";
import { checkName, createEfs, PROTOCOL_INPUTS, wireSegment } from "@efs/sdk";
import { openFile } from "@efs/sdk/files";
import { smoke as nodeSmoke } from "@efs/sdk/node";
import { smoke as webSmoke } from "@efs/sdk/web";

assert.equal(checkName("readme.txt").status, "VALID");
assert.equal(wireSegment(new TextEncoder().encode("a b")), "a%20b");
assert.equal(typeof createEfs, "function");
assert.equal(typeof openFile, "function");
assert.match(PROTOCOL_INPUTS.contractsCommit, /^[0-9a-f]{40}$/);
assert.equal(webSmoke, "efs-sdk/web smoke placeholder");
assert.equal(nodeSmoke, "efs-sdk/node smoke placeholder");
console.log("smoke-node: ok");
