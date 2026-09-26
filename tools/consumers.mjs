// SPDX-License-Identifier: MIT
// Install the exact packed artifacts into fresh copies of examples/* (outside the workspace)
// and run them. Usage: node tools/consumers.mjs [--only node,ts,browser,foundry] [--ts 7.0.2] [--keep]
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readTar } from "./lib/tar.mjs";
import { fail, ok, PACKS, ROOT, run } from "./lib/util.mjs";

const { values } = parseArgs({
  options: { only: { type: "string" }, ts: { type: "string" }, keep: { type: "boolean" } },
});
const only = new Set((values.only ?? "node,ts,browser").split(","));
const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
const tsVersion = values.ts ?? /typescript:\s*([\w.-]+)/.exec(workspace)?.[1];
const pack = JSON.parse(readFileSync(join(PACKS, "pack.json"), "utf8"));
const artifact = (name) => {
  const a = pack.artifacts.find((x) => x.name === name);
  if (!a) throw new Error(`${name} not in .packs/pack.json; run tools/pack.mjs first`);
  return a;
};

function freshCopy(example) {
  const dir = mkdtempSync(join(tmpdir(), `efs-${example}-`));
  cpSync(join(ROOT, "examples", example), dir, { recursive: true });
  return dir;
}

function npmConsumer(example, extraDevDeps = {}) {
  const dir = freshCopy(example);
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies["@efs/sdk"] = `file:${join(PACKS, artifact("@efs/sdk").file)}`;
  pkg.devDependencies = { ...pkg.devDependencies, ...extraDevDeps };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  // npm, not pnpm: a plain consumer, no workspace, no lifecycle scripts.
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--loglevel=error",
    ],
    { cwd: dir },
  );
  run("npm", ["run", "-s", "smoke"], { cwd: dir });
  return dir;
}

const dirs = [];
try {
  if (only.has("node")) {
    dirs.push(npmConsumer("smoke-node"));
    ok("smoke-node");
  }
  if (only.has("ts")) {
    dirs.push(npmConsumer("smoke-ts-strict", { typescript: tsVersion }));
    ok(`smoke-ts-strict (TypeScript ${tsVersion})`);
  }
  if (only.has("browser")) {
    dirs.push(npmConsumer("smoke-browser"));
    ok("smoke-browser");
  }
  if (only.has("foundry")) {
    const dir = freshCopy("smoke-foundry");
    dirs.push(dir);
    const archive = artifact("efs-solidity-archive");
    const files = readTar(readFileSync(join(PACKS, archive.file)));
    for (const [path, data] of files) {
      const target = join(dir, "lib", path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, data);
    }
    const base = `efs-solidity-${archive.version}`;
    // Use the archive's own documented remapping, verbatim.
    writeFileSync(join(dir, "remappings.txt"), files.get(`${base}/remappings.example.txt`));
    run("forge", ["build", "--root", dir]);
    ok(`smoke-foundry (archive ${archive.file})`);
  }
} catch (error) {
  fail(error.message);
} finally {
  if (!values.keep) for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
