// SPDX-License-Identifier: MIT
// Every reason code the SDK can return is a named member of ReasonCode, and api-0.1 lists it too. ReasonCode is an open
// union (string & …), so the compiler can't refuse an unnamed code: this test reads the source instead. A client keys
// its outcome map on these names, so a code returned without being named is a case no client was told about.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

/** The quoted members of `export type <name> =` up to its closing `;`, comments skipped. */
function members(text: string, name: string): Set<string> {
  const start = text.indexOf(`export type ${name} =`);
  if (start < 0) throw new Error(`no ${name} in the text`);
  const body = text.slice(start, text.indexOf(";", text.indexOf("(string & Record<never, never>)", start)));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return new Set([...code.matchAll(/\|\s*"([A-Z_]+)"/g)].map((m) => m[1] as string));
}

/** Every code passed as a literal to reason(...), and to the byte reader's reason helper fail(...). */
function returned(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files(src)) {
    if (f.includes("/generated/")) continue;
    const text = readFileSync(f, "utf8");
    const calls = [...text.matchAll(/\breason\(\s*"([A-Z_]+)"/g)];
    if (f.endsWith("/files/bytes.ts")) calls.push(...text.matchAll(/\bfail\(\s*"([A-Z_]+)"/g));
    for (const m of calls) if (!out.has(m[1] as string)) out.set(m[1] as string, f.slice(root.length));
  }
  return out;
}

describe("every reason code the SDK returns is named", () => {
  const named = members(readFileSync(join(src, "core/errors.ts"), "utf8"), "ReasonCode");

  it("in ReasonCode (src/core/errors.ts)", () => {
    const codes = returned();
    expect(codes.size).toBeGreaterThan(20); // the scan found the SDK's reasons
    const unnamed = [...codes].filter(([c]) => !named.has(c)).map(([c, f]) => `${c} (${f})`);
    expect(unnamed).toEqual([]);
  });

  it("and in api-0.1's ReasonCode", () => {
    const doc = readFileSync(join(root, "../../docs/design/api-0.1.md"), "utf8");
    const listed = members(doc, "ReasonCode");
    expect([...named].filter((c) => !listed.has(c))).toEqual([]);
  });
});
