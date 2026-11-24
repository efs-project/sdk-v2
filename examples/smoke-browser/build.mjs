// SPDX-License-Identifier: MIT
// S0 placeholder example: bundle the guest entry for the browser and inspect what got in.
import assert from "node:assert/strict";
import { build } from "esbuild";

const guest = await build({
  stdin: {
    contents:
      'import { checkName, createEfs } from "@efs/sdk"; import { openFile } from "@efs/sdk/files"; import { indexedDbJournal } from "@efs/sdk/web/journal"; console.log(checkName, createEfs, openFile, indexedDbJournal);',
    resolveDir: process.cwd(),
    loader: "js",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  metafile: true,
  write: false,
  logLevel: "silent",
});
const inputs = Object.keys(guest.metafile.inputs);
const nodeish = inputs.filter((p) => p.startsWith("node:") || p.includes("/dist/node/"));
assert.deepEqual(nodeish, [], `browser bundle pulled in Node code: ${nodeish.join(", ")}`);

// The Node-only subpath must not resolve under browser conditions.
let resolved = true;
try {
  await build({
    stdin: { contents: 'import "@efs/sdk/node";', resolveDir: process.cwd(), loader: "js" },
    bundle: true,
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
} catch {
  resolved = false;
}
assert.equal(resolved, false, "@efs/sdk/node resolved under browser conditions");

// The startup grammar: @efs/sdk/links must bundle from SDK files alone (no viem, ox, abitype or @noble).
const startup = await build({
  stdin: {
    contents:
      'import { formatRealm, link, parseLink, splitRealm } from "@efs/sdk/links"; console.log(formatRealm, link, parseLink, splitRealm);',
    resolveDir: process.cwd(),
    loader: "js",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  metafile: true,
  write: false,
  logLevel: "silent",
});
const startupInputs = Object.keys(startup.metafile.inputs)
  .filter((p) => p !== "<stdin>")
  .map((p) => p.replace(/^.*\/@efs\/sdk\//, "@efs/sdk/"));
assert.deepEqual(
  startupInputs.sort(),
  ["@efs/sdk/dist/core/errors.js", "@efs/sdk/dist/links/index.js", "@efs/sdk/dist/names/links.js"],
  `@efs/sdk/links pulled in more than the grammar: ${startupInputs.join(", ")}`,
);
const startupBytes = startup.outputFiles.reduce((n, f) => n + f.contents.length, 0);
console.log(`smoke-browser: @efs/sdk/links bundles alone (${startupBytes} bytes)`);

const bytes = guest.outputFiles.reduce((n, f) => n + f.contents.length, 0);
console.log(`smoke-browser: ok (${inputs.length} input modules, ${bytes} bytes; trend only)`);
