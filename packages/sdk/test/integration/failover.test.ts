// SPDX-License-Identifier: MIT
// Reads that used to end on one endpoint's bad reply now try the next endpoint (the read-validation audit,
// 2026-11-26), and end exactly as before when every endpoint says the same:
//   - reconcile: a reader's UNSUPPORTED from publicationAt (a pinned reader can't be another layout);
//   - web3://: a resolveMode that isn't ERC-5219 (or no code), a request() reply that doesn't decode, or a status
//     other than 200 (or a 307 with a Location).
// Each is shown with a lying endpoint first and an honest one second (the honest answer wins), and the liar alone (the
// same outcome as before). Account 64 of anvil's public development mnemonic (used by no other test file).
import { readFileSync } from "node:fs";
import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import { reconcileAttempt } from "../../src/actions/reconcile.ts";
import { createEfs } from "../../src/client.ts";
import {
  type Address,
  type Hex,
  type RecordId,
  type SubjectId,
  ZERO_WORD,
} from "../../src/core/hex.ts";
import { type OpenedFile, readBytes } from "../../src/files/bytes.ts";
import { planCreateFolder } from "../../src/files/entries.ts";
import { ledgerReadsAbi } from "../../src/generated/abis.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const ME = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 64,
});

/** An EIP-1193 endpoint on the fixture whose eth_call replies to `selector` are replaced by `edit`. */
const liar = (selector: string, edit: (result: Hex) => Hex) => ({
  provider: {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const res = await fetch(fixture.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = (await res.json()) as {
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
      const data = String((params as [{ data?: string }] | undefined)?.[0]?.data ?? "");
      if (method === "eth_call" && data.startsWith(selector) && typeof json.result === "string")
        return edit(json.result as Hex);
      return json.result;
    },
  },
  label: "liar",
});
const both = (l: ReturnType<typeof liar>) => createEfs({ rpcs: [l, fixture.rpcUrl], deployment });
const alone = (l: ReturnType<typeof liar>) => createEfs({ rpcs: [l], deployment });

describe("reconcile: a reader's UNSUPPORTED tries the next endpoint", () => {
  let planId: Hex;
  let journal: ReturnType<typeof memoryJournal>;
  beforeAll(async () => {
    await fetch(fixture.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [ME.address, "0x56bc75e2d63100000"],
      }),
    });
    journal = memoryJournal();
    const w = await createWriter(efs, {
      authorizer: { kind: "local", profile: "direct", account: ME },
      journal,
    });
    const p = await planCreateFolder(efs, w, {
      folder: { kind: "home", address: ME.address.toLowerCase() as Address },
      name: `fo${Date.now().toString(36)}`,
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    const part = p.parts[0];
    if (!part) throw new Error("no part");
    const planned = await w.planActions({
      actions: part.actions,
      bodies: part.bodies,
      effects: [],
      ...(part.guard ? { guard: part.guard } : {}),
    });
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const ran = await w.run(planned.plan);
    expect(ran.reconcile?.outcome).toBe("COMMITTED");
    planId = planned.plan.id;
  }, 120_000);
  const unsupported = liar(
    toFunctionSelector(
      ledgerReadsAbi.find((x) => x.type === "function" && x.name === "publicationAt") as never,
    ),
    () =>
      encodeFunctionResult({
        abi: ledgerReadsAbi,
        functionName: "publicationAt",
        result: [10, 0n, ZERO_WORD] as never,
      }) as Hex,
  );
  it("a liar first and an honest endpoint second: COMMITTED (the honest answer)", async () => {
    const r = await reconcileAttempt(both(unsupported), journal, planId);
    expect(r.outcome).toBe("COMMITTED");
  });
  it("the liar alone: UNKNOWN, UNSUPPORTED_PROFILE, as before", async () => {
    const r = await reconcileAttempt(alone(unsupported), journal, planId);
    expect(r).toMatchObject({
      outcome: "UNKNOWN",
      reason: { code: "UNSUPPORTED_PROFILE", retry: "never" },
    });
  });
});

describe("web3://: an unusable reply from one endpoint tries the next", () => {
  const web3Abi = parseAbi([
    "function request(string[] resource, (string key, string value)[] params) view returns (uint16 statusCode, bytes body, (string key, string value)[] headers)",
  ]);
  const RESOLVE_MODE = toFunctionSelector("resolveMode()");
  const REQUEST = toFunctionSelector("request(string[],(string,string)[])");
  const gateway = deployment.readers.web3Gateway as { address: string; seedUrl: string };
  const readme = (
    deployment.seed.files as { name: string; subjectId: string; length: number; sha256: string }[]
  ).find((f) => f.name === "readme.txt") as { subjectId: string; length: number; sha256: string };
  // An external file whose only location is the gateway's readme (no byte cache: each read reaches the gateway).
  const file: OpenedFile = {
    file: readme.subjectId as SubjectId,
    revision: `0x${"11".repeat(32)}` as RecordId,
    author: null,
    size: BigInt(readme.length),
    sha256: readme.sha256 as Hex,
    layout: "external",
    locations: [{ scheme: "web3", uri: `${gateway.seedUrl}docs/readme.txt` }],
  };
  const noBytes = { get: async () => undefined, put: async () => {} };
  const lies: { what: string; selector: string; reply: Hex; detail: string | RegExp }[] = [
    {
      what: "a status other than 200",
      selector: REQUEST,
      reply: encodeFunctionResult({
        abi: web3Abi,
        functionName: "request",
        result: [404, "0x", []],
      }),
      detail: "web3 status 404",
    },
    {
      what: "a resolveMode that isn't ERC-5219",
      selector: RESOLVE_MODE,
      reply: `0x${"00".repeat(32)}` as Hex,
      detail: "the contract is not in ERC-5219 resource-request mode",
    },
    {
      what: "no contract (an empty resolveMode)",
      selector: RESOLVE_MODE,
      reply: "0x" as Hex,
      detail: /^no contract at 0x/,
    },
    {
      what: "a request() reply that doesn't decode",
      selector: REQUEST,
      reply: "0x1234" as Hex,
      detail: "request() returned data that does not decode",
    },
  ];
  it.each(lies)(
    "$what: the honest endpoint's bytes, verified; the liar alone ends as before",
    async (l) => {
      const lying = liar(l.selector, () => l.reply);
      const two = createEfs({
        rpcs: [lying, fixture.rpcUrl],
        deployment,
        cache: { bytes: noBytes },
      });
      const r = await readBytes(two, file);
      expect(r.grade).toBe("VERIFIED");
      expect(new TextDecoder().decode(r.bytes)).toBe("Meeting at 10:00.\n");
      const one = createEfs({ rpcs: [lying], deployment, cache: { bytes: noBytes } });
      const r1 = await readBytes(one, file);
      expect(r1.grade).toBe("UNAVAILABLE");
      expect(r1.attempts[0]).toMatchObject({ outcome: "FAILED", detail: l.detail });
    },
  );
});
