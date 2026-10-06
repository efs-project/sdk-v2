// SPDX-License-Identifier: MIT
// S0 placeholder example: imports the packed tarball's entry points under Node.
import assert from "node:assert/strict";
import { smoke } from "@efs/sdk";
import { smoke as nodeSmoke } from "@efs/sdk/node";
import { smoke as webSmoke } from "@efs/sdk/web";

assert.equal(smoke, "efs-sdk smoke placeholder");
assert.equal(webSmoke, "efs-sdk/web smoke placeholder");
assert.equal(nodeSmoke, "efs-sdk/node smoke placeholder");
console.log("smoke-node: ok");
