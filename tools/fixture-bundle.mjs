// SPDX-License-Identifier: MIT
// Copy the vendored contracts snapshot into packages/fixture/contracts, byte for byte: every file protocol-inputs/
// lock.json pins, each checked against its sha256 (so the fixture package can only carry the snapshot this SDK was
// generated from), plus PROVENANCE.json naming the contracts commit. Nothing else is copied.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./lib/util.mjs";

const lock = JSON.parse(readFileSync(join(ROOT, "protocol-inputs/lock.json"), "utf8"));
const FROM = join(ROOT, "protocol-inputs/contracts");
const TO = join(ROOT, "packages/fixture/contracts");
const sha = (b) => createHash("sha256").update(b).digest("hex");

rmSync(TO, { recursive: true, force: true });
const files = Object.entries(lock.contracts.files);
for (const [path, want] of files) {
  if (path.includes("..") || path.startsWith("/"))
    throw new Error(`fixture-bundle: bad path in lock.json: ${path}`);
  const bytes = readFileSync(join(FROM, path));
  if (sha(bytes) !== want)
    throw new Error(
      `fixture-bundle: ${path} differs from lock.json (run node tools/inputs.mjs verify)`,
    );
  mkdirSync(dirname(join(TO, path)), { recursive: true });
  writeFileSync(join(TO, path), bytes);
}
const provenance = {
  schema: "efs-fixture-provenance/1",
  contracts: {
    repo: lock.contracts.repo,
    commit: lock.contracts.commit,
    releaseDigest: lock.contracts.releaseDigest,
    files: lock.contracts.files,
  },
};
writeFileSync(join(TO, "PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(
  `fixture-bundle: ${files.length} files from contracts ${lock.contracts.commit.slice(0, 7)} → packages/fixture/contracts`,
);
