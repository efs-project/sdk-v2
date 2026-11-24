// SPDX-License-Identifier: MIT
// Start and stop contracts fixtures for SDK integration tests, from the vendored snapshot in protocol-inputs/contracts
// (no contracts checkout). Each instance is named, owns its state directory, and is stopped by name only.
//   node tools/fixture.mjs up <name>     prints the ready object (JSON)
//   node tools/fixture.mjs down <name>
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib/util.mjs";

const VENDOR = join(ROOT, "protocol-inputs/contracts");
const CLI = join(VENDOR, "tools/efs-fixture.mjs");
/** The SDK's own lease registry, so its instances never mix with a developer's or the client's. */
export const FIXTURE_HOME = process.env.EFS_SDK_FIXTURE_HOME ?? join(tmpdir(), "efs-sdk-fixtures");

function cli(args, timeoutMs) {
  mkdirSync(FIXTURE_HOME, { recursive: true });
  const r = spawnSync(process.execPath, [CLI, ...args, "--home", FIXTURE_HOME], {
    cwd: VENDOR,
    // deploy-plan.mjs selects its artifact source at import time; point it at the committed release layout.
    env: { ...process.env, EFS_ARTIFACTS_DIR: "artifacts" },
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return r;
}

export function up(name, { ttlSeconds = 900 } = {}) {
  const stateDir = join(FIXTURE_HOME, "state", name);
  const r = cli(
    [
      "up",
      "--name",
      name,
      "--artifacts",
      join(VENDOR, "artifacts"),
      "--state-dir",
      stateDir,
      "--ttl",
      String(ttlSeconds),
      "--json",
    ],
    120_000,
  );
  let ready;
  try {
    ready = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `fixture ${name} did not print a ready object (exit ${r.status}):\n${r.stderr}`,
    );
  }
  if (!ready.ok) throw new Error(`fixture ${name} failed: ${JSON.stringify(ready.error)}`);
  return ready;
}

export function down(name) {
  const r = cli(["down", "--name", name], 60_000);
  return r.status === 0 || r.status === 4; // 4 = not found / already dead
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === "up" && name) console.log(JSON.stringify(up(name), null, 2));
  else if (cmd === "down" && name) process.exit(down(name) ? 0 : 1);
  else {
    console.error("usage: node tools/fixture.mjs up|down <name>");
    process.exit(2);
  }
}
