// SPDX-License-Identifier: MIT
// efs.lens.place: the Lens for viewing a place. The reader first, then the place's owner, then the base Lens, each
// principal once; `owner: null` leaves the owner out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEfs } from "../src/client.ts";
import type { Address, PrincipalId } from "../src/core/hex.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });
const pid = (n: number) => `0x${"0".repeat(24)}${String(n).repeat(40)}` as PrincipalId;
const addr = (n: number) => `0x${String(n).repeat(40)}` as Address;

describe("efs.lens.place", () => {
  const base = efs.lens.default.principals;

  it("orders reader, owner, then the base Lens, with no duplicates", () => {
    expect(efs.lens.place({ reader: addr(1), owner: pid(2) }).principals).toEqual(
      [pid(1), pid(2), ...base].filter((p, i, a) => a.indexOf(p) === i),
    );
    // The owner is already in the base Lens: it moves up to second, once.
    expect(efs.lens.place({ reader: pid(1), owner: base[0] as PrincipalId }).principals).toEqual([
      pid(1),
      ...base,
    ]);
    // The reader is the owner (your own folder): one entry.
    expect(efs.lens.place({ reader: pid(3), owner: addr(3) }).principals[0]).toBe(pid(3));
    expect(
      efs.lens.place({ reader: pid(3), owner: addr(3) }).principals.filter((p) => p === pid(3)),
    ).toHaveLength(1);
  });

  it("owner: null leaves the owner out; an explicit base replaces the default", () => {
    expect(efs.lens.place({ reader: pid(1), owner: null }).principals).toEqual([pid(1), ...base]);
    expect(efs.lens.place({ owner: pid(2), base: { principals: [pid(4)] } }).principals).toEqual([
      pid(2),
      pid(4),
    ]);
    expect(() => efs.lens.place({ reader: "nope" as Address })).toThrow(
      /not an address or principal id/,
    );
  });
});
