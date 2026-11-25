// SPDX-License-Identifier: MIT
// planEditFile refuses a media type the chain would refuse before it reads anything, so a bad type is a MISUSE the
// caller sees at once, never a revert. The RPC here is unreachable: had planning read first, it would return UNKNOWN.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createWriter, memoryJournal } from "../src/actions/index.ts";
import { createEfs } from "../src/client.ts";
import { EfsFault } from "../src/core/errors.ts";
import type { RecordId, SubjectId } from "../src/core/hex.ts";
import { planEditFile } from "../src/files/edit.ts";

const deployment = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
) as unknown;
const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });
// anvil #9: a public development key; nothing here reaches a chain.
const account = privateKeyToAccount(
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
);

describe("planEditFile media type", () => {
  it.each([
    ["text", 3],
    ["text/plain ; charset=utf-8", 5],
    ["text/plain;\r\nx-injected: 1", 6],
    ["*/*", 2],
    [`a/${"b".repeat(254)}`, 1],
  ])("refuses %j with MISUSE and the chain's code %i, before any read", async (mediaType, code) => {
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account },
      journal: memoryJournal(),
    });
    const err = await planEditFile(efs, w, {
      file: { kind: "file", subject: `0x${"aa".repeat(32)}` as SubjectId },
      base: { kind: "revision", recordId: `0x${"bb".repeat(32)}` as RecordId },
      content: new Uint8Array([1, 2, 3]),
      mediaType,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EfsFault);
    expect(err).toMatchObject({ code: "MISUSE", details: { mediaType, code } });
    expect((err as EfsFault).message).toMatch(/^invalid media type: /);
  });
});
