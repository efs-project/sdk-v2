// SPDX-License-Identifier: MIT
// Release DRY RUN. Nothing is published. Two modes:
//   --compare <dir>   compare the unpacked contents of .packs/ with another build's packs dir
//                     (repeatability within our pipeline; NOT independent reproduction)
//   (default)         write .packs/release-manifest.draft.json from .packs/pack.json
// Options: --repeated-build match|mismatch|not-run (recorded in the draft manifest)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readTar, sha256 } from "./lib/tar.mjs";
import { fail, ok, PACKS, ROOT, run } from "./lib/util.mjs";

const { values } = parseArgs({
  options: {
    compare: { type: "string" },
    "repeated-build": { type: "string", default: "not-run" },
  },
});

const pack = JSON.parse(readFileSync(join(PACKS, "pack.json"), "utf8"));

if (values.compare) {
  const other = JSON.parse(readFileSync(join(values.compare, "pack.json"), "utf8"));
  let differences = 0;
  for (const a of pack.artifacts) {
    const b = other.artifacts.find((x) => x.name === a.name);
    if (!b) {
      fail(`${a.name}: missing from ${values.compare}`);
      differences++;
      continue;
    }
    const left = readTar(readFileSync(join(PACKS, a.file)));
    const right = readTar(readFileSync(join(values.compare, b.file)));
    const paths = new Set([...left.keys(), ...right.keys()]);
    const diff = [...paths].filter(
      (p) =>
        sha256(left.get(p) ?? Buffer.alloc(0)) !== sha256(right.get(p) ?? Buffer.alloc(0)) ||
        !left.has(p) ||
        !right.has(p),
    );
    if (diff.length) {
      fail(`${a.name}: unpacked files differ: ${diff.join(", ")}`);
      differences++;
    } else {
      ok(
        `${a.name}: ${paths.size} unpacked files identical${a.sha256 === b.sha256 ? " (container bytes identical too)" : ""}`,
      );
    }
  }
  console.log(differences ? "repeated-build=mismatch" : "repeated-build=match");
} else {
  const git = (...args) => run("git", args, { capture: true }).stdout.trim();
  const version = (cmd, args) => {
    const r = run(cmd, args, { capture: true, allowFail: true });
    return r.status === 0 ? r.stdout.split("\n")[0].trim() : null;
  };
  const foundryToml = readFileSync(join(ROOT, "packages/solidity/foundry.toml"), "utf8");
  const tsVersion = JSON.parse(
    readFileSync(join(ROOT, "node_modules/typescript/package.json"), "utf8"),
  ).version;
  const status = run("pnpm", ["exec", "changeset", "status"], { capture: true, allowFail: true });
  const limitations = readFileSync(join(ROOT, "LIMITATIONS.md"));
  const manifest = {
    schema: "efs-sdk-release/draft-0",
    dryRun: true,
    published: false,
    source: {
      repo: git("config", "--get", "remote.origin.url"),
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      dirty: git("status", "--porcelain").length > 0,
    },
    toolchain: {
      node: process.versions.node,
      pnpm: version("pnpm", ["--version"]),
      typescript: tsVersion,
      forge: version("forge", ["--version"]),
      solc: /solc_version\s*=\s*"([^"]+)"/.exec(foundryToml)?.[1] ?? null,
      evmVersion: /evm_version\s*=\s*"([^"]+)"/.exec(foundryToml)?.[1] ?? null,
      commands: ["pnpm install --frozen-lockfile", "pnpm build", "node tools/pack.mjs"],
    },
    artifacts: pack.artifacts,
    evidence: {
      repeatedBuild: values["repeated-build"],
      independentReproduction: null,
      changesetStatus:
        status.status === 0 ? "ok" : "no changesets (not required before publishing)",
    },
    limitations: { file: "LIMITATIONS.md", sha256: sha256(limitations) },
    notDoneYet: [
      "protocol inputs",
      "compatibility matrix",
      "conformance evidence",
      "provenance",
      "publishing",
    ],
  };
  const out = join(PACKS, "release-manifest.draft.json");
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(out, text);
  ok(`wrote .packs/release-manifest.draft.json (sha256 ${sha256(Buffer.from(text))})`);
}
