// SPDX-License-Identifier: MIT
// Pack once: @efs/sdk and @efs/solidity tarballs plus the deterministic Solidity source
// archive, with a file-list check, SHA256SUMS and .packs/pack.json. Packages stay private;
// packing is not publishing. Usage: node tools/pack.mjs [--only sdk|solidity]
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { npmIntegrity, readTar, sha256, writeTar } from "./lib/tar.mjs";
import { fail, ok, PACKS, ROOT, run, walk } from "./lib/util.mjs";

const { values } = parseArgs({ options: { only: { type: "string" } } });
const only = values.only ? new Set(values.only.split(",")) : new Set(["sdk", "solidity"]);

const PACKAGES = {
  sdk: {
    dir: "packages/sdk",
    allowed: (p) =>
      /^(package\.json|README\.md|LICENSE|dist\/.+|src\/.+\.ts)$/.test(p) &&
      !p.endsWith(".test.ts"),
  },
  solidity: {
    dir: "packages/solidity/src",
    allowed: (p) => /^(package\.json|README\.md|LICENSE|.+\.sol)$/.test(p),
  },
};

mkdirSync(PACKS, { recursive: true });
const artifacts = [];

for (const key of only) {
  const spec = PACKAGES[key];
  if (!spec) throw new Error(`unknown package: ${key}`);
  const pkg = JSON.parse(readFileSync(join(ROOT, spec.dir, "package.json"), "utf8"));
  const expected = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
  rmSync(join(PACKS, expected), { force: true });
  run("pnpm", ["pack", "--pack-destination", PACKS], { cwd: join(ROOT, spec.dir), capture: true });
  const file = readdirSync(PACKS).find((f) => f === expected);
  if (!file) throw new Error(`pnpm pack did not produce ${expected} for ${pkg.name}`);
  const data = readFileSync(join(PACKS, file));
  const entries = [...readTar(data).keys()].map((p) => p.replace(/^package\//, ""));
  const unexpected = entries.filter((p) => !spec.allowed(p));
  if (unexpected.length) fail(`${pkg.name}: unexpected files in tarball: ${unexpected.join(", ")}`);
  else ok(`${pkg.name}@${pkg.version}: ${entries.length} files, file list allowed`);
  artifacts.push({
    name: pkg.name,
    version: pkg.version,
    file,
    sha256: sha256(data),
    integrity: npmIntegrity(data),
  });

  if (key === "solidity") {
    // Build the standalone archive from the source directory (not from the tarball), then
    // prove both carry the same files byte for byte.
    const base = `efs-solidity-${pkg.version}`;
    const srcFiles = walk(spec.dir)
      .map((p) => p.slice(spec.dir.length + 1))
      .filter((p) => spec.allowed(p));
    const packed = readTar(data);
    // package.json is taken from the tarball because pnpm normalizes it while packing;
    // every other file must be byte-identical to the source.
    const tarEntries = srcFiles.map((p) => ({
      path: `${base}/src/${p}`,
      data:
        p === "package.json"
          ? packed.get("package/package.json")
          : readFileSync(join(ROOT, spec.dir, p)),
    }));
    tarEntries.push({
      path: `${base}/remappings.example.txt`,
      data: Buffer.from(`@efs/solidity/=lib/${base}/src/\n`),
    });
    const archive = writeTar(tarEntries);
    const archiveFile = `${base}.tar`;
    writeFileSync(join(PACKS, archiveFile), archive);
    const mismatch = srcFiles
      .filter((p) => p !== "package.json")
      .filter(
        (p) =>
          sha256(packed.get(`package/${p}`) ?? Buffer.alloc(0)) !==
          sha256(readFileSync(join(ROOT, spec.dir, p))),
      );
    const extra = [...packed.keys()]
      .map((p) => p.replace(/^package\//, ""))
      .filter((p) => !srcFiles.includes(p));
    if (mismatch.length || extra.length)
      fail(`archive and tarball differ: ${[...mismatch, ...extra].join(", ")}`);
    else ok(`${archiveFile}: same ${srcFiles.length} files as the npm tarball`);
    artifacts.push({
      name: "efs-solidity-archive",
      version: pkg.version,
      file: archiveFile,
      sha256: sha256(archive),
    });
  }
}

writeFileSync(join(PACKS, "SHA256SUMS"), artifacts.map((a) => `${a.sha256}  ${a.file}\n`).join(""));
writeFileSync(join(PACKS, "pack.json"), `${JSON.stringify({ artifacts }, null, 2)}\n`);
ok(`wrote ${artifacts.length} artifacts to .packs/`);
