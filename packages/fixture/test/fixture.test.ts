// SPDX-License-Identifier: MIT
// The client's live-chain path end to end: start a fixture chain, pin it, edit the seeded readme.txt as the fixture
// principal through an EIP-1193 provider that forwards eth_sendTransaction to anvil's unlocked account, read the new
// HEAD back under the default Lens, then stop the chain and see it gone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWriter, memoryJournal } from "../../sdk/src/actions/index.ts";
import type { Eip1193Like } from "../../sdk/src/chain/rpc.ts";
import { createEfs } from "../../sdk/src/client.ts";
import type { Hex, RecordId, SubjectId } from "../../sdk/src/core/hex.ts";
import { openFile, readBytes } from "../../sdk/src/files/bytes.ts";
import { planEditFile } from "../../sdk/src/files/edit.ts";
import { type FixtureChain, startFixtureChain } from "../src/index.ts";

let chain: FixtureChain;
beforeAll(async () => {
  chain = await startFixtureChain({ ttlSeconds: 300 });
});
afterAll(async () => {
  await chain?.stop();
});

const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

describe("startFixtureChain", () => {
  it("starts a pinned deployment with the seed and unlocked accounts", async () => {
    expect(chain.chainId).toBe(31337);
    expect(chain.accounts.unlocked).toHaveLength(10);
    expect(chain.accounts.fixture.address.toLowerCase()).toBe(
      (chain.accounts.unlocked[0] as Hex).toLowerCase(),
    );
    expect(chain.seed.files.map((f) => f.name)).toEqual(["readme.txt", "big.bin", "remote.txt"]);
    expect(chain.contracts.commit).toMatch(/^[0-9a-f]{40}$/);
    const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
    expect((await efs.at("latest")).status).toBe("VERIFIED");
  });

  it("edits the seeded readme through an unlocked-account wallet (the client's live e2e path)", async () => {
    const efs = createEfs({ rpcs: [chain.rpcUrl], deployment: chain.deployment });
    const me = chain.accounts.fixture.address;
    const wallet: Eip1193Like = {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [me];
        return rpc(method, (params as unknown[] | undefined) ?? []);
      },
    };
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: wallet },
      journal: memoryJournal(),
    });
    const readme = chain.seed.files.find((f) => f.name === "readme.txt");
    if (!readme) throw new Error("no readme.txt in the seed");
    const file = { kind: "file" as const, subject: readme.subjectId as SubjectId };
    const opened = await openFile(efs, file);
    if (opened.status !== "PRESENT") throw new Error(opened.status);
    expect(opened.file.revision).toBe(readme.headRecordId);
    const edit = await planEditFile(efs, writer, {
      file,
      base: { kind: "revision", recordId: opened.file.revision as RecordId },
      content: new TextEncoder().encode("Meeting moved to 11:00.\n"),
    });
    if (edit.status !== "PLANNED") throw new Error(edit.status);
    expect(edit.review).toMatchObject({ guard: "own-head", visibleInLens: true, parts: 1 });
    expect((await writer.runSequence(edit.parts)).state).toBe("COMPLETE");
    const after = await openFile(efs, file);
    if (after.status !== "PRESENT") throw new Error(after.status);
    expect(after.file.revision).toBe(edit.review.revision);
    expect(new TextDecoder().decode((await readBytes(efs, after.file)).bytes)).toBe(
      "Meeting moved to 11:00.\n",
    );
  });

  it("stop() ends anvil, and a second stop() is harmless", async () => {
    const other = await startFixtureChain({ ttlSeconds: 120 });
    expect(await rpc("eth_chainId")).toBe("0x7a69");
    await other.stop();
    await other.stop();
    await expect(
      fetch(other.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      }),
    ).rejects.toThrow();
  });
});
