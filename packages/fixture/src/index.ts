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
  /**
   * The chain id (a positive safe integer). Default 31337. The deployment plan is built for this chain, so the
   * returned `deployment` carries the ids and addresses for it. A sticky id per worktree keeps wallets apart.
   */
  chainId?: number;
  /**
   * The lease name (the registry's rule: a letter or digit, then letters, digits, `.`, `_` or `-`; at most 64).
   * Default: a unique name for this process. Reusing a name whose anvil is still running fails as already leased.
   */
  name?: string;
}

/** The fixture registry's instance-name rule. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  /** The lease name (StartFixtureOptions.name, or the generated one). */
  name: string;
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

/** `down --purge` one named instance in `home`. NO_INSTANCE (nothing leased under that name) is not an error. */
async function downInstance(
  name: string,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<{ existed: boolean; wasLive: boolean }> {
  const r = await runCli(["down", "--name", name, "--home", home, "--purge", "--json"], env);
  let out: { ok?: boolean; wasLive?: boolean; error?: { code?: string } } | undefined;
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    // no JSON: parseResult below reports the failure
  }
  if (out?.ok === false && out.error?.code === "NO_INSTANCE")
    return { existed: false, wasLive: false };
  const done = parseResult("down", r) as { wasLive?: boolean };
  return { existed: true, wasLive: done.wasLive === true };
}

export interface StopFixtureOptions {
  /** The lease name the chain was started with (StartFixtureOptions.name). */
  name: string;
  /** The registry home it was started with (StartFixtureOptions.home). Required: only that registry is touched. */
  home: string;
}

/**
 * Stop the fixture chain leased as `name` in `home` and remove its state, e.g. after the process that started it
 * died without stop() (kill -9), so the next start does not fail as already leased. A no-op when no such instance
 * exists. It signals only the anvil whose pid, start time and command match the lease, never another process.
 */
export async function stopFixtureChain(
  o: StopFixtureOptions,
): Promise<{ existed: boolean; wasLive: boolean }> {
  if (!NAME.test(o.name))
    throw new Error(
      `name ${JSON.stringify(o.name)} must match ${NAME} (letters, digits, . _ -; at most 64)`,
    );
  if (typeof o.home !== "string" || o.home === "") throw new Error("home is required");
  return downInstance(o.name, resolve(o.home), { ...process.env });
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
  if (o.chainId !== undefined && !(Number.isSafeInteger(o.chainId) && o.chainId > 0))
    throw new Error(`chainId must be a positive safe integer (got ${String(o.chainId)})`);
  if (o.name !== undefined && !NAME.test(o.name))
    throw new Error(
      `name ${JSON.stringify(o.name)} must match ${NAME} (letters, digits, . _ -; at most 64)`,
    );
  const ownHome = o.home === undefined;
  const home = o.home === undefined ? mkdtempSync(join(tmpdir(), "efs-fixture-")) : resolve(o.home);
  const name = o.name ?? `efs-fixture-${process.pid}-${randomBytes(3).toString("hex")}`;
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
  if (o.chainId !== undefined) args.push("--chain-id", String(o.chainId));

  /**
   * `down` (already gone, e.g. stopped by stopFixtureChain, counts as stopped), then, only once anvil is known to be
   * stopped, the temporary home with its lease registry.
   */
  const down = async (): Promise<void> => {
    await downInstance(name, home, env);
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
      name,
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
