// SPDX-License-Identifier: MIT
// Repository hygiene checks. Usage: node tools/checks.mjs <all|spdx|licenses|placeholders|negative|compat|solidity|package>
// "all" runs everything that needs no build output. "solidity" needs `forge build` output;
// "package" needs .packs/ from tools/pack.mjs.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, PACKS, ROOT, run, walk } from "./lib/util.mjs";

const PERMISSIVE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD"]);
const CODE = /\.(ts|mjs|js|sol)$/;

const checks = {
  spdx() {
    const files = [...walk("packages"), ...walk("tools"), ...walk("examples")].filter((f) =>
      CODE.test(f),
    );
    const missing = files.filter(
      (f) =>
        !readFileSync(join(ROOT, f), "utf8")
          .split("\n")
          .slice(0, 3)
          .some((l) => l.includes("SPDX-License-Identifier: MIT")),
    );
    if (missing.length) fail(`SPDX header missing: ${missing.join(", ")}`);
    else ok(`SPDX headers present in ${files.length} source files`);
  },

  licenses() {
    const root = readFileSync(join(ROOT, "LICENSE"), "utf8");
    for (const copy of ["packages/sdk/LICENSE", "packages/solidity/src/LICENSE"]) {
      if (readFileSync(join(ROOT, copy), "utf8") !== root)
        fail(`${copy} differs from the root LICENSE`);
    }
    // Runtime dependencies of publishable packages must be permissively licensed.
    let count = 0;
    for (const dir of ["packages/sdk", "packages/solidity/src"]) {
      const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
      if (pkg.license !== "MIT") fail(`${pkg.name}: license must be MIT`);
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        count++;
        const depPkg = join(ROOT, dir, "node_modules", dep, "package.json");
        const license = existsSync(depPkg)
          ? JSON.parse(readFileSync(depPkg, "utf8")).license
          : undefined;
        if (!PERMISSIVE.has(license))
          fail(`${pkg.name} → ${dep}: license ${license ?? "unknown"} not in allowlist`);
      }
    }
    ok(`license copies match; ${count} runtime dependencies checked`);
  },

  placeholders() {
    // Every file carrying the S0 placeholder marker must be listed in LIMITATIONS.md.
    const limitations = readFileSync(join(ROOT, "LIMITATIONS.md"), "utf8");
    const marked = [...walk("packages"), ...walk("examples")].filter(
      (f) => CODE.test(f) && readFileSync(join(ROOT, f), "utf8").includes("S0 placeholder"),
    );
    const unlisted = marked.filter((f) => !limitations.includes(f));
    if (unlisted.length) fail(`placeholders not listed in LIMITATIONS.md: ${unlisted.join(", ")}`);
    else ok(`${marked.length} placeholder files, all listed in LIMITATIONS.md`);
  },

  negative() {
    // 1. Biome must reject Node built-ins and DOM globals in portable source.
    const probe = join(ROOT, "packages/sdk/src/__negative_probe__.ts");
    writeFileSync(
      probe,
      'import { readFileSync } from "node:fs";\n\nexport const a: string = readFileSync.name;\nexport const b: unknown = document;\n',
    );
    try {
      const r = run("pnpm", ["exec", "biome", "lint", "--colors=off", probe], {
        capture: true,
        allowFail: true,
      });
      const out = `${r.stdout}${r.stderr}`;
      if (
        r.status !== 0 &&
        out.includes("noRestrictedImports") &&
        out.includes("noRestrictedGlobals")
      ) {
        ok("Biome rejects node: imports and DOM globals in portable source");
      } else fail(`Biome did not reject the portable-core probe:\n${out}`);
    } finally {
      rmSync(probe, { force: true });
    }
    // 2. The portable tsconfig must not know DOM globals.
    const t = run("pnpm", ["exec", "tsc", "-p", "tools/fixtures/negative/tsconfig.json"], {
      capture: true,
      allowFail: true,
    });
    const tout = `${t.stdout}${t.stderr}`;
    if (t.status !== 0 && /document/.test(tout)) ok("portable tsconfig rejects DOM globals");
    else fail(`portable tsconfig accepted a DOM global:\n${tout}`);
  },

  compat() {
    // Supported solc × EVM combinations: explicit list with a policy check.
    const { supported } = JSON.parse(
      readFileSync(join(ROOT, "packages/solidity/compat.json"), "utf8"),
    );
    const minor = (v) => Number(v.split(".")[2]);
    const minFor = { cancun: 25, prague: 27, osaka: 37 }; // osaka: our policy claims it only from 0.8.37
    let n = 0;
    for (const { solc, evm } of supported) {
      if (!/^0\.8\.\d+$/.test(solc)) fail(`compat.json: unsupported solc ${solc}`);
      for (const e of evm) {
        n++;
        if (!(e in minFor)) fail(`compat.json: unknown evm ${e}`);
        else if (minor(solc) < minFor[e])
          fail(`compat.json: ${solc} × ${e} is not a supported combination`);
      }
    }
    ok(`compat.json: ${n} solc × EVM combinations, all within policy`);
  },

  solidity() {
    // Libraries shipped in src/ must be internal-only, and no artifact may need linking.
    for (const f of walk("packages/solidity/src").filter((x) => x.endsWith(".sol"))) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/\blibrary\s+\w+\s*\{/g)) {
        let depth = 0;
        let i = m.index + m[0].length - 1;
        const start = i;
        do {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          i++;
        } while (depth > 0 && i < src.length);
        if (/function\s+\w+\s*\([^)]*\)[^{;]*\b(public|external)\b/.test(src.slice(start, i))) {
          fail(`${f}: library declares a public/external function`);
        }
      }
    }
    const out = join(ROOT, "packages/solidity/out");
    if (!existsSync(out)) return fail("packages/solidity/out missing; run forge build first");
    let artifacts = 0;
    for (const f of walk("packages/solidity/out", { skip: new Set(["build-info"]) }).filter((x) =>
      x.endsWith(".json"),
    )) {
      const j = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
      artifacts++;
      const refs = { ...j.bytecode?.linkReferences, ...j.deployedBytecode?.linkReferences };
      if (Object.keys(refs).length) fail(`${f}: unexpected linkReferences`);
    }
    ok(`Solidity libraries internal-only; ${artifacts} artifacts without link references`);
  },

  package() {
    const pack = JSON.parse(readFileSync(join(PACKS, "pack.json"), "utf8"));
    const sdk = pack.artifacts.find((a) => a.name === "@efs/sdk");
    run("pnpm", ["exec", "publint", "--strict", "packages/sdk"]);
    // attw's "bundler" resolution deliberately cannot resolve the node-condition-only ./node
    // subpath, and attw has no per-resolution switch. So ./node is excluded here. Its Node and
    // TS (nodenext) resolution are proven by examples/smoke-node and smoke-ts-strict, and its
    // non-resolution in browsers by examples/smoke-browser.
    run("pnpm", [
      "exec",
      "attw",
      join(PACKS, sdk.file),
      "--profile",
      "esm-only",
      "--exclude-entrypoints",
      "./node",
    ]);
    ok("publint and attw (., ./web) pass for @efs/sdk");
  },
};

const which = process.argv[2] ?? "all";
const selected =
  which === "all" ? ["spdx", "licenses", "placeholders", "negative", "compat"] : [which];
for (const name of selected) {
  if (!checks[name]) throw new Error(`unknown check: ${name}`);
  checks[name]();
}
