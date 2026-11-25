// SPDX-License-Identifier: MIT
// Protocol inputs: copy the contracts release snapshot the SDK is generated from into protocol-inputs/contracts/
// and record its provenance in protocol-inputs/lock.json. The SDK never reads a sibling checkout at build or test time.
//
//   node tools/inputs.mjs sync --from ../contracts-v2 [--ref <commit>]
//                                                         copy the snapshot files AT A COMMIT (git archive; default
//                                                         HEAD) and update lock.json. Working-tree edits are ignored.
//   node tools/inputs.mjs verify                          check every vendored file against lock.json
//
// James (2026-11-24): release digest pinning waits until the MVP works, so the lock records the contracts
// commit plus per-file sha256. The digest slot (`releaseDigest`) is filled once release pinning starts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, ok, ROOT, run, walk } from "./lib/util.mjs";

const DEST = join(ROOT, "protocol-inputs/contracts");
const LOCK = join(ROOT, "protocol-inputs/lock.json");
/** What the SDK consumes. Directories are copied whole. Everything else in the contracts repo is out of scope. */
const SNAPSHOT = [
  "release/release.json",
  "release/errors.json",
  "release/efs-deployment.json",
  "release/expected.json",
  "deploy/plan.json",
  "artifacts",
  "vectors/layout.json",
  "test/vectors/ids.json",
  // Media types (contracts C4): the encodings and the accepted/refused strings, the authority for the SDK codec.
  "test/vectors/media.json",
  // The contracts-owned fixture (a library and CLI). Vendored so SDK integration tests start their own chains from
  // this snapshot (`up --artifacts protocol-inputs/contracts`) without a contracts checkout.
  "tools/efs-fixture.mjs",
  "tools/fixture-registry.mjs",
  "tools/deploy-plan.mjs",
  "schemas",
  // The Solidity consumer closure, re-exported by @efs/solidity (tools/solidity.mjs): interfaces outside
  // internal/ and the compile-in libraries. The closure probe is vendored as the reference for what it must cover.
  "src/interfaces",
  "src/lib/Keys.sol",
  "src/lib/EfsNative.sol",
  "src/lib/EfsFiles.sol",
  "test/closure",
  "LICENSE",
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, ref: { type: "string", default: "HEAD" } },
});
const cmd = positionals[0];

if (cmd === "sync") {
  if (!values.from) throw new Error("sync needs --from <contracts checkout>");
  const from = resolve(values.from);
  const git = (...a) => run("git", ["-C", from, ...a], { capture: true }).stdout.trim();
  const commit = git("rev-parse", `${values.ref}^{commit}`);
  const present = SNAPSHOT.filter((p) => git("ls-tree", "--name-only", commit, "--", p).length > 0);
  for (const p of SNAPSHOT.filter((x) => !present.includes(x)))
    console.warn(`! ${p} is absent at ${commit.slice(0, 12)}; skipped`);
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  // git archive gives exactly the committed bytes, never the (possibly mid-edit) working tree.
  const archive = spawnSync(
    "git",
    ["-C", from, "archive", "--format=tar", commit, "--", ...present],
    { maxBuffer: 1 << 30 },
  );
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x", "-C", DEST], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar -x failed: ${untar.stderr}`);
  const files = Object.fromEntries(
    walk("protocol-inputs/contracts").map((f) => [
      f.slice("protocol-inputs/contracts/".length),
      sha(readFileSync(join(ROOT, f))),
    ]),
  );
  const lock = {
    schema: "efs-sdk-protocol-inputs/1",
    contracts: {
      repo: "https://github.com/efs-project/contracts-v2",
      commit,
      releaseDigest: null,
      files,
    },
  };
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  ok(`synced ${Object.keys(files).length} files from contracts ${commit.slice(0, 12)}`);
} else if (cmd === "verify") {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const want = lock.contracts.files;
  const have = Object.fromEntries(
    walk("protocol-inputs/contracts").map((f) => [
      f.slice("protocol-inputs/contracts/".length),
      sha(readFileSync(join(ROOT, f))),
    ]),
  );
  let bad = 0;
  for (const [p, h] of Object.entries(want))
    if (have[p] !== h) {
      fail(`${p}: ${have[p] ? "modified" : "missing"}`);
      bad++;
    }
  for (const p of Object.keys(have))
    if (!(p in want)) {
      fail(`${p}: not in lock.json`);
      bad++;
    }
  if (!bad)
    ok(
      `protocol inputs match lock.json (contracts ${lock.contracts.commit.slice(0, 12)}, ${Object.keys(want).length} files)`,
    );
} else {
  throw new Error("usage: node tools/inputs.mjs sync --from <dir> | verify");
}
