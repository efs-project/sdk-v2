// SPDX-License-Identifier: MIT
// Write packages/sdk/protocol-inputs.json (shipped in the package) from protocol-inputs/lock.json: which contracts
// commit, and later which release digest, this SDK build was generated from. The client's `doctor` compares it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/util.mjs";

const lock = JSON.parse(readFileSync(join(ROOT, "protocol-inputs/lock.json"), "utf8"));
const out = {
  schema: "efs-sdk-protocol-inputs/1",
  contracts: {
    repo: lock.contracts.repo,
    commit: lock.contracts.commit,
    releaseDigest: lock.contracts.releaseDigest,
  },
};
writeFileSync(join(ROOT, "packages/sdk/protocol-inputs.json"), `${JSON.stringify(out, null, 2)}\n`);
