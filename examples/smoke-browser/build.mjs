// SPDX-License-Identifier: MIT
// S0 placeholder example: bundle the guest entry for the browser and inspect what got in.
import assert from "node:assert/strict";
import { build } from "esbuild";

const guest = await build({
  stdin: {
    contents:
      'import { smoke } from "@efs/sdk"; import { smoke as web } from "@efs/sdk/web"; console.log(smoke, web);',
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

const bytes = guest.outputFiles.reduce((n, f) => n + f.contents.length, 0);
console.log(`smoke-browser: ok (${inputs.length} input modules, ${bytes} bytes; trend only)`);
