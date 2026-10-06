// SPDX-License-Identifier: MIT
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PACKS = join(ROOT, ".packs");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".packs",
  ".git",
  "out",
  "cache",
  "dependencies",
]);

/** Recursively list files under dir (relative to ROOT), skipping build and vendor dirs. */
export function walk(dir, { skip = SKIP_DIRS } = {}) {
  const out = [];
  const visit = (abs) => {
    for (const entry of readdirSync(abs)) {
      const p = join(abs, entry);
      if (statSync(p).isDirectory()) {
        if (!skip.has(entry)) visit(p);
      } else {
        out.push(relative(ROOT, p).split("\\").join("/"));
      }
    }
  };
  visit(join(ROOT, dir));
  return out.sort();
}

/** Run a command, inheriting stdio unless capture is set. Throws on failure unless allowFail. */
export function run(cmd, args, { cwd = ROOT, capture = false, allowFail = false, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.error) throw result.error;
  if (!allowFail && result.status !== 0) {
    const detail = capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}${detail}`);
  }
  return result;
}

export function fail(message) {
  console.error(`✖ ${message}`);
  process.exitCode = 1;
}

export function ok(message) {
  console.log(`✓ ${message}`);
}
