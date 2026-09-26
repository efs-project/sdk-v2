// SPDX-License-Identifier: MIT
// Remove the given paths (relative to the current directory). Cross-platform `rm -rf`.
import { rmSync } from "node:fs";

for (const target of process.argv.slice(2)) rmSync(target, { recursive: true, force: true });
