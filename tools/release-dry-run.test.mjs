// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { changesetStatus } from "./lib/changeset-status.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const benign = [
  "🦋 changeset v3.0.3",
  "Some packages have been changed but no changesets were found. Run changeset add to resolve this error.",
  "If this change doesn't need a release, run changeset add --empty.",
  "🦋 Exited with code 1",
].join("\n");
const result = (status, stdout = "", stderr = "", signal = null) => ({
  status,
  stdout,
  stderr,
  signal,
});

test("a normally completed Changesets command is ok, including an empty plan", () => {
  assert.equal(changesetStatus(result(0, "Packages to be bumped:\n")), "ok");
});

test("only the complete pinned missing-changeset diagnostic is optional at S0", () => {
  assert.equal(changesetStatus(result(1, benign)), "missing changeset (optional during S0)");
  const ansi = benign
    .split("\n")
    .map((line) => `\u001b[31m${line}\u001b[0m`)
    .join("\n");
  assert.equal(changesetStatus(result(1, ansi)), "missing changeset (optional during S0)");
});

for (const [name, value] of [
  ["missing base ref", result(1, "Error: Failed to find where HEAD diverged from missing-ref")],
  ["invalid config", result(1, "Error: Invalid config access")],
  ["another exit", result(2, benign)],
  ["signal termination", result(null, benign, "", "SIGTERM")],
  ["mixed stdout", result(1, `${benign}\nError: invalid config`)],
  ["mixed stderr", result(1, benign, "warning: unexpected configuration")],
  ["partial marker", result(1, "no changesets")],
]) {
  test(`rejects ${name} and preserves useful process diagnostics`, () => {
    assert.throws(() => changesetStatus(value), /Changesets status failed/);
  });
}

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "efs-changesets-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const env = { ...process.env, CHANGESETS_OUTPUT: "", FORCE_COLOR: "0", NO_COLOR: "1" };
  const command = (cmd, args, extraEnv = {}) => {
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
    if (r.error) throw r.error;
    return r;
  };
  const git = (...args) => {
    const r = command("git", args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
  };
  put("package.json", JSON.stringify({ name: "fixture-package", version: "1.0.0", private: true }));
  put(".gitignore", "node_modules/\n.packs/\nbin/\n");
  put(".changeset/config.json", readFileSync(join(root, ".changeset/config.json"), "utf8"));
  put("README.md", "base\n");
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", "https://example.invalid/fixture.git");
  commit();
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "dir");
  const cli = (...args) =>
    command(process.execPath, [
      join(root, "node_modules/@changesets/cli/dist/index.mjs"),
      "status",
      ...args,
    ]);
  return { cwd, put, env, command, git, commit, base, cli };
}

test("real pinned CLI distinguishes empty success, optional absence, and genuine Git/config errors", (t) => {
  assert.equal(
    process.versions.node,
    "24.21.0",
    "real-CLI evidence uses the pinned release runtime",
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, "node_modules/@changesets/cli/package.json"))).version,
    "3.0.3",
  );
  const f = fixture(t);
  const empty = f.cli("--since", "origin/main");
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.equal(changesetStatus(empty), "ok");
  f.put("README.md", "changed package without a changeset\n");
  f.commit();
  const absent = f.cli("--since", "origin/main");
  t.diagnostic(`node=${process.versions.node}; changesets=3.0.3; origin/main=${f.base}`);
  t.diagnostic(
    `benign exit=${absent.status}; stdout=${JSON.stringify(absent.stdout)}; stderr=${JSON.stringify(absent.stderr)}`,
  );
  assert.equal(absent.status, 1);
  assert.equal(changesetStatus(absent), "missing changeset (optional during S0)");
  const colored = f.command(
    process.execPath,
    [join(root, "node_modules/@changesets/cli/dist/index.mjs"), "status", "--since", "origin/main"],
    { FORCE_COLOR: "1", NO_COLOR: undefined },
  );
  assert.equal(colored.status, 1);
  assert.equal(changesetStatus(colored), "missing changeset (optional during S0)");
  const missing = f.cli("--since", "missing-ref");
  assert.equal(missing.status, 1);
  assert.throws(() => changesetStatus(missing), /Changesets status failed/);
  f.put(".changeset/config.json", '{"access":"invalid"}\n');
  const config = f.cli("--since", "origin/main");
  assert.equal(config.status, 1);
  assert.throws(() => changesetStatus(config), /Changesets status failed/);
});

test("the wired release writer fails before creating or updating a success manifest", (t) => {
  const f = fixture(t);
  for (const path of [
    "tools/release-dry-run.mjs",
    "tools/lib/util.mjs",
    "tools/lib/tar.mjs",
    "tools/lib/changeset-status.mjs",
  ]) {
    mkdirSync(dirname(join(f.cwd, path)), { recursive: true });
    copyFileSync(join(root, path), join(f.cwd, path));
  }
  f.put(".packs/pack.json", '{"artifacts":[]}\n');
  f.put("LIMITATIONS.md", "fixture only\n");
  f.put("packages/solidity/foundry.toml", 'solc_version="0.8.37"\nevm_version="prague"\n');
  f.put(".changeset/config.json", '{"access":"invalid"}\n');
  f.put("bin/forge", '#!/bin/sh\nprintf "forge fixture (test only)\\n"\n');
  // The fake version command prevents a missing host Forge from masking the red regression.
  const forge = join(f.cwd, "bin/forge");
  const chmod = f.command("chmod", ["755", forge]);
  assert.equal(chmod.status, 0);
  const pathEnv = {
    PATH: `${join(f.cwd, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
  };
  const manifest = join(f.cwd, ".packs/release-manifest.draft.json");
  const runWriter = () => f.command(process.execPath, ["tools/release-dry-run.mjs"], pathEnv);
  const absent = runWriter();
  assert.notEqual(absent.status, 0, absent.stdout + absent.stderr);
  assert.match(absent.stdout + absent.stderr, /Changesets status failed/);
  assert.equal(existsSync(manifest), false);
  f.put(".packs/release-manifest.draft.json", "previous draft sentinel\n");
  const retained = runWriter();
  assert.notEqual(retained.status, 0);
  assert.equal(readFileSync(manifest, "utf8"), "previous draft sentinel\n");
  f.git("update-ref", "-d", "refs/remotes/origin/main");
  const noBase = runWriter();
  assert.notEqual(noBase.status, 0);
  assert.match(noBase.stdout + noBase.stderr, /origin\/main/);
  assert.equal(readFileSync(manifest, "utf8"), "previous draft sentinel\n");
});
