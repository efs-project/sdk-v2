// SPDX-License-Identifier: MIT
// The public root entry imports cleanly and exposes the stable surface; the node subpath exposes its adapters.
import { describe, expect, it } from "vitest";
import {
  checkName,
  checksumAddress,
  createEfs,
  link,
  PROTOCOL_INPUTS,
  parseLink,
} from "../src/index.ts";
import { fileJournal } from "../src/node/index.ts";

describe("root entry", () => {
  it("exposes the stable surface", () => {
    expect(checkName("readme.txt").status).toBe("VALID");
    expect(checksumAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266")).toBe(
      "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    );
    expect(typeof createEfs).toBe("function");
    expect(
      parseLink(link({ kind: "object", subject: `0x${"ab".repeat(32)}` as `0x${string}` })).status,
    ).toBe("OK");
    expect(PROTOCOL_INPUTS.contractsCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof fileJournal).toBe("function");
  });
  it("refuses an invalid deployment document as misuse", () => {
    expect(() =>
      createEfs({ rpcs: ["http://127.0.0.1:1"], deployment: { schema: "nope" } }),
    ).toThrow(/invalid deployment document/);
  });
});
