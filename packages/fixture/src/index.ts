// SPDX-License-Identifier: MIT
// @efs/fixture: start a local EFS chain for live-chain tests. It runs the contracts' own fixture tool from the snapshot
// this package was built with (contracts/, pinned in contracts/PROVENANCE.json): anvil on a free loopback port, the
// genesis deployment, the ten Files Types and the seed (the root, docs/ and three files), all signed locally by the
// fixture key. anvil's ten default accounts stay unlocked, so a test wallet can forward eth_sendTransaction to it.
// Node only. Needs `anvil` (Foundry) and `perl` (the watchdog that stops anvil after `ttlSeconds`).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Hex = `0x${string}`;

const CONTRACTS = fileURLToPath(new URL("../contracts/", import.meta.url));
const CLI = join(CONTRACTS, "tools", "efs-fixture.mjs");

export interface StartFixtureOptions {
  /** The anvil binary (its file name must be `anvil`). Default: `anvil` on PATH. */
  anvilPath?: string;
  /** A fixed loopback port. Default: a free port from the fixture's range. */
  port?: number;
  /** anvil stops itself after this many seconds even if stop() never runs. Default 900; 0 = never. */
  ttlSeconds?: number;
  /** The lease registry and state directory. Default: a new temporary directory, removed by stop(). */
  home?: string;
}

export interface FixtureAccount {
  address: Hex;
  /** anvil's well-known development key: public, for tests only. */
  privateKey: Hex;
}

export interface FixtureSeedFile {
  name: string;
  subjectId: Hex;
  headRecordId: Hex;
  headRevision: number;
  form: number;
  length: number;
  sha256: Hex;
  [key: string]: unknown;
}

export interface FixtureSeed {
  root: { directoryRecordId: Hex; subjectId: Hex; principalId: Hex };
  folder: { name: string; directoryRecordId: Hex; subjectId: Hex };
  /** readme.txt (inline), big.bin (a span tree) and remote.txt (an external locator), owned by the fixture principal. */
  files: readonly FixtureSeedFile[];
  [key: string]: unknown;
}

export interface FixtureChain {
  rpcUrl: string;
  chainId: number;
  /** The efs-deployment document: pass it to createEfs({ rpcs: [rpcUrl], deployment }). */
  deployment: Record<string, unknown>;
  deploymentPath: string;
  accounts: {
    /** anvil account #0: the deployer and the seed's author (the default Lens's principal). */
    fixture: FixtureAccount;
    /** All ten default accounts, unlocked: eth_sendTransaction from any of them is signed by anvil. */
    unlocked: readonly Hex[];
  };
  seed: FixtureSeed;
  /** The contracts commit the snapshot is from. */
  contracts: { repo: string; commit: string };
  /**
   * Stop anvil, then remove the state this call created. Concurrent calls share one stop; after a failed stop the
   * state is kept (anvil may still be running) and stop() can be called again.
   */
  stop(): Promise<void>;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: CONTRACTS,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseResult(command: string, r: Ran): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  try {
    out = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    // fall through: no JSON means the tool failed before it could report
  }
  if (r.code === 0 && out?.["ok"] !== false && out) return out;
  const err = out?.["error"] as { code?: string; message?: string } | undefined;
  const why = err ? `${err.code}: ${err.message}` : r.stderr.trim() || `exit ${r.code}`;
  throw new Error(`efs-fixture ${command} failed: ${why}`);
}

/** Start a fresh fixture chain. Resolves once the deployment and the seed are in place and verified. */
export async function startFixtureChain(o: StartFixtureOptions = {}): Promise<FixtureChain> {
  const env = { ...process.env };
  if (o.anvilPath) {
    // Resolved against the caller's directory (the CLI runs with cwd contracts/, where a relative path means nothing).
    const bin = resolve(o.anvilPath);
    const file = basename(bin);
    if (file !== "anvil" && file !== "anvil.exe")
      throw new Error(`anvilPath must name an anvil binary (got ${file})`);
    if (dirname(bin).includes(delimiter))
      throw new Error(`anvilPath's directory must not contain "${delimiter}"`);
    env["PATH"] = `${dirname(bin)}${delimiter}${env["PATH"] ?? ""}`;
  }
  const ownHome = o.home === undefined;
  const home = o.home ?? mkdtempSync(join(tmpdir(), "efs-fixture-"));
  const name = `efs-fixture-${process.pid}-${randomBytes(3).toString("hex")}`;
  const args = [
    "up",
    "--name",
    name,
    "--home",
    home,
    "--artifacts",
    join(CONTRACTS, "artifacts"),
    "--ttl",
    String(o.ttlSeconds ?? 900),
    "--json",
  ];
  if (o.port !== undefined) args.push("--port", String(o.port));

  /** `down`, then (only once anvil is known to be stopped) the temporary home with its lease registry. */
  const down = async (): Promise<void> => {
    parseResult(
      "down",
      await runCli(["down", "--name", name, "--home", home, "--purge", "--json"], env),
    );
    if (ownHome) rmSync(home, { recursive: true, force: true });
  };

  let ready: Record<string, unknown>;
  try {
    ready = parseResult("up", await runCli(args, env));
  } catch (e) {
    // A failed `up` stops the anvil it started and frees its lease itself.
    if (ownHome) rmSync(home, { recursive: true, force: true });
    throw e;
  }
  try {
    const { DEFAULT_ACCOUNTS } = (await import(pathToFileURL(CLI).href)) as {
      DEFAULT_ACCOUNTS: readonly Hex[];
    };
    const { FIXTURE_KEY } = (await import(
      pathToFileURL(join(CONTRACTS, "tools", "deploy-plan.mjs")).href
    )) as { FIXTURE_KEY: Hex };
    const provenance = JSON.parse(readFileSync(join(CONTRACTS, "PROVENANCE.json"), "utf8")) as {
      contracts: { repo: string; commit: string };
    };
    const deploymentPath = String(ready["deployment"]);
    const deployment = JSON.parse(readFileSync(deploymentPath, "utf8")) as Record<string, unknown>;
    // One stop at a time; a failed stop can be retried, and keeps the home (anvil may still be running).
    let stopping: Promise<void> | undefined;
    let stopped = false;
    return {
      rpcUrl: String(ready["rpcUrl"]),
      chainId: Number(ready["chainId"]),
      deployment,
      deploymentPath,
      accounts: {
        fixture: { address: DEFAULT_ACCOUNTS[0] as Hex, privateKey: FIXTURE_KEY },
        unlocked: [...DEFAULT_ACCOUNTS],
      },
      seed: deployment["seed"] as FixtureSeed,
      contracts: { repo: provenance.contracts.repo, commit: provenance.contracts.commit },
      stop(): Promise<void> {
        if (stopped) return Promise.resolve();
        stopping ??= down().then(
          () => {
            stopped = true;
          },
          (e: unknown) => {
            stopping = undefined;
            throw e;
          },
        );
        return stopping;
      },
    };
  } catch (e) {
    // Anvil is up but the chain cannot be handed back: stop it rather than leak it.
    await down().catch(() => {});
    throw e;
  }
}
