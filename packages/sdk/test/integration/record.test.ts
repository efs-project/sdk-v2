// SPDX-License-Identifier: MIT
// Record real results from a fixture chain into fixtures/*.json, for the client's chain-free UI tests.
// Runs only with EFS_RECORD=1 (pnpm record:fixtures). Each file: { schema, contractsCommit, case, note, result }.
// `result` is encoded with toJson (bigint and Uint8Array tagged); decode it with fromJson.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, sha256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { toJson } from "../../src/core/json.ts";
import { type OpenedFile, openFile, readBytes, readRange } from "../../src/files/bytes.ts";
import { PROTOCOL_INPUTS } from "../../src/generated/inputs.ts";
import { type RpcTranscript, recordingFetch } from "../../src/testing/index.ts";
import { putExternal, putInline } from "./recipes.ts";

const RECORD = process.env["EFS_RECORD"] === "1";
const OUT = join(import.meta.dirname, "../../fixtures");
const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as {
  seed: { folder: { directoryRecordId: Hex }; files: { name: string; subjectId: string }[] };
};
const subject = (n: string) =>
  deployment.seed.files.find((f) => f.name === n)?.subjectId as SubjectId;

function save(name: string, note: string, result: unknown): void {
  mkdirSync(OUT, { recursive: true });
  const doc = {
    schema: "efs-sdk-fixture/1",
    contractsCommit: PROTOCOL_INPUTS.contractsCommit,
    case: name,
    note,
    result,
  };
  writeFileSync(join(OUT, `${name}.json`), `${toJson(doc, 2)}\n`);
}

/** A fake gateway: serves `body` for every URL, or a status code. */
const gateway =
  (body: Uint8Array | number): FetchLike =>
  async () =>
    typeof body === "number"
      ? {
          ok: false,
          status: body,
          headers: { get: () => null },
          text: async () => "",
          arrayBuffer: async () => new ArrayBuffer(0),
        }
      : {
          ok: true,
          status: 200,
          headers: { get: () => String(body.length) },
          text: async () => "",
          arrayBuffer: async () => body.slice().buffer,
        };

describe.runIf(RECORD)("record fixtures", () => {
  it("records pin, open, bytes and journal results", async () => {
    const efs = createEfs({ rpcs: [{ url: fixture.rpcUrl, label: "local fixture" }], deployment });
    save("pin-verified", "efs.pin() against the true deployment document", await efs.pin());
    const forged = structuredClone(deployment) as unknown as {
      readers: { lensReader: { runtimeCodehash: string } };
    };
    forged.readers.lensReader.runtimeCodehash = `0x${"ab".repeat(32)}`;
    save(
      "pin-mismatch",
      "efs.pin() with a forged LensReader code hash in the document",
      await createEfs({ rpcs: [fixture.rpcUrl], deployment: forged }).pin(),
    );
    save(
      "pin-unknown",
      "efs.pin() with every endpoint down",
      await createEfs({
        rpcs: [{ url: "http://127.0.0.1:1", label: "offline node" }],
        deployment,
        timeoutMs: 1000,
      }).pin(),
    );

    const inline = await openFile(efs, { kind: "file", subject: subject("readme.txt") });
    save("open-inline", "openFile on an inline file (docs/readme.txt)", inline);
    if (inline.status === "PRESENT")
      save(
        "bytes-inline-verified",
        "readBytes on the inline file",
        await readBytes(efs, inline.file),
      );
    const span = await openFile(efs, { kind: "file", subject: subject("big.bin") });
    save("open-span", "openFile on a 20,000-byte span-tree file (docs/big.bin)", span);
    if (span.status === "PRESENT")
      save(
        "bytes-span-range-verified",
        "readRange 8150..8170 across a chunk boundary",
        await readRange(efs, span.file, { offset: 8150n, length: 20n }),
      );
    const ext = await openFile(efs, { kind: "file", subject: subject("remote.txt") });
    save(
      "open-external",
      "openFile on a files-external/1 file with a web3:// locator (docs/remote.txt)",
      ext,
    );
    if (ext.status === "PRESENT") {
      save(
        "bytes-web3-no-contract",
        "readBytes on the seed's web3:// file, whose locator names the zero address: UNAVAILABLE (no contract)",
        await readBytes(efs, ext.file),
      );
      const seedUrl = (deployment as unknown as { readers: { web3Gateway: { seedUrl: string } } })
        .readers.web3Gateway.seedUrl;
      const big = deployment.seed.files.find((f) => f.name === "big.bin") as unknown as {
        length: number;
        sha256: Hex;
      };
      save(
        "bytes-web3-verified",
        "readBytes on a web3:// location served by the fixture's EfsWeb3Gateway (3 chunks): VERIFIED",
        await readBytes(efs, {
          ...ext.file,
          size: BigInt(big.length),
          sha256: big.sha256,
          locations: [{ scheme: "web3", uri: `${seedUrl}docs/big.bin` }],
        }),
      );
      save(
        "bytes-external-unsupported",
        "readBytes on a web3:// location on another chain (the client has RPC endpoints for its own chain only)",
        await readBytes(efs, {
          ...ext.file,
          locations: [
            { scheme: "web3", uri: `${seedUrl.replace(/:\d+\//, ":1/")}docs/remote.txt` },
          ],
        }),
      );
    }

    // External https locations through injected gateways (synthetic locations; the real verification path).
    const text = new TextEncoder().encode("hello from a gateway\n");
    const file: OpenedFile = {
      file: subject("remote.txt"),
      revision: `0x${"11".repeat(32)}` as RecordId,
      author: null,
      size: BigInt(text.length),
      sha256: sha256(text),
      layout: "external",
      locations: [{ scheme: "https", uri: "https://files.example/hello.txt" }],
    };
    // Publisher https:// is off by default (privacy): these record what an app with https allowed sees.
    const via = (fetch: FetchLike) =>
      createEfs({
        rpcs: [fixture.rpcUrl],
        deployment,
        fetch,
        gateways: { allowSchemes: ["https", "ipfs", "ar", "data"] },
      });
    save(
      "bytes-external-blocked",
      "readBytes on an https location with the default policy: POLICY_BLOCKED, naming the origin (offer allowOrigins)",
      await readBytes(
        createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: gateway(text) }),
        file,
      ),
    );
    save(
      "bytes-external-allowed-once",
      "readBytes with { allowOrigins: ['https://files.example'] } under the default policy: VERIFIED",
      await readBytes(
        createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: gateway(text) }),
        file,
        {
          allowOrigins: ["https://files.example"],
        },
      ),
    );
    save(
      "bytes-external-verified",
      "readBytes on an https location serving the right bytes (https allowed)",
      await readBytes(via(gateway(text)), file),
    );
    save(
      "bytes-external-mismatch",
      "readBytes on an https location serving tampered bytes (never handed back)",
      await readBytes(via(gateway(new TextEncoder().encode("tampered"))), file),
    );
    save(
      "bytes-external-unavailable",
      "readBytes on an https location answering 404",
      await readBytes(via(gateway(404)), file),
    );
    save(
      "bytes-policy-blocked",
      "readBytes on a plain http:// location (blocked even with https allowed)",
      await readBytes(via(gateway(text)), {
        ...file,
        locations: [{ scheme: "http", uri: "http://files.example/hello.txt" }],
      }),
    );

    save(
      "open-absent",
      "openFile on a file subject nobody created",
      await openFile(efs, { kind: "file", subject: keccak256(toHex("no such file")) as SubjectId }),
    );
    save(
      "open-unknown",
      "openFile with every endpoint down",
      await openFile(
        createEfs({
          rpcs: [{ url: "http://127.0.0.1:1", label: "offline node" }],
          deployment,
          timeoutMs: 1000,
        }),
        { kind: "file", subject: subject("readme.txt") },
      ),
    );

    // Journal: an ambiguous submission before and after reconcile.
    const journal = memoryJournal();
    const rpc = async (method: string, params: unknown[] = []) => {
      const r = await fetch(fixture.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return ((await r.json()) as { result: unknown }).result;
    };
    const bob = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as Hex;
    const lossy = {
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method === "eth_accounts") return [bob];
        if (method === "eth_sendTransaction") {
          await rpc(method, params as unknown[]);
          throw new Error("network connection lost");
        }
        return rpc(method, (params as unknown[]) ?? []);
      },
    };
    const w = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: lossy },
      journal,
    });
    const planned = await w.planActions(
      putInline(
        efs,
        w.principal,
        deployment.seed.folder.directoryRecordId,
        "fixture-lost.txt",
        text,
        keccak256(toHex("fixture-lost")),
      ),
    );
    if (planned.status !== "PLANNED") throw new Error(planned.status);
    const sent = await w.send(planned.plan);
    save("send-ambiguous", "writer.send() whose wallet response was lost", sent);
    save(
      "journal-ambiguous-before",
      "the attempt record right after the lost response",
      await journal.get(planned.plan.id),
    );
    await rpc("evm_mine");
    const rec = await w.reconcile(planned.plan.id);
    save("reconcile-committed", "writer.reconcile() after the lost response", rec);
    save(
      "journal-ambiguous-after",
      "the attempt record after reconcile",
      await journal.get(planned.plan.id),
    );
    expect(rec.outcome).toBe("COMMITTED");
  });
});

/**
 * RPC transcripts: the JSON-RPC traffic of the real SDK on this chain, for chain-free e2e replays
 * (`@efs/sdk/testing`). Each case starts from a fresh client, so the endpoint chain check is included.
 */
describe.runIf(RECORD)("record RPC transcripts", () => {
  const RPC_OUT = join(OUT, "rpc");
  const record = async (
    name: string,
    note: string,
    ids: Record<string, string>,
    run: (efs: ReturnType<typeof createEfs>, steps: string[]) => Promise<void>,
    inner: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) => {
    const rec = recordingFetch(inner);
    const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch: rec.fetch });
    const steps: string[] = [];
    await run(efs, steps);
    const t: RpcTranscript = {
      schema: "efs-sdk-rpc-transcript/1",
      case: name,
      note,
      contractsCommit: PROTOCOL_INPUTS.contractsCommit,
      ids,
      steps,
      calls: rec.calls,
    };
    mkdirSync(RPC_OUT, { recursive: true });
    writeFileSync(join(RPC_OUT, `${name}.json`), `${JSON.stringify(t, null, 2)}\n`);
  };

  it("records the deployment document and four transcripts", async () => {
    mkdirSync(RPC_OUT, { recursive: true });
    writeFileSync(join(RPC_OUT, "deployment.json"), readFileSync(fixture.deployment, "utf8"));
    const inline = subject("readme.txt");
    const span = subject("big.bin");
    const absent = keccak256(toHex("no such file")) as SubjectId;

    await record(
      "pin-verified",
      "createEfs({ deployment }).pin() → VERIFIED",
      {},
      async (efs, steps) => {
        steps.push("efs.pin()");
        expect((await efs.pin()).status).toBe("VERIFIED");
      },
    );
    await record(
      "open-inline",
      "openFile(docs/readme.txt) → PRESENT inline, then readBytes → VERIFIED",
      { file: inline },
      async (efs, steps) => {
        steps.push(
          "openFile(efs, { kind: 'file', subject: ids.file })",
          "readBytes(efs, opened.file)",
        );
        const o = await openFile(efs, { kind: "file", subject: inline });
        if (o.status !== "PRESENT") throw new Error(o.status);
        expect((await readBytes(efs, o.file)).grade).toBe("VERIFIED");
      },
    );
    await record(
      "open-absent",
      "openFile on a file nobody created → ABSENT_PROVEN",
      { file: absent },
      async (efs, steps) => {
        steps.push("openFile(efs, { kind: 'file', subject: ids.file })");
        expect((await openFile(efs, { kind: "file", subject: absent })).status).toBe(
          "ABSENT_PROVEN",
        );
      },
    );
    await record(
      "open-span",
      "openFile(docs/big.bin, 20,000 bytes, span tree) → PRESENT; readRange(8150, 20) across a chunk edge and readBytes → VERIFIED",
      { file: span },
      async (efs, steps) => {
        steps.push(
          "openFile(efs, { kind: 'file', subject: ids.file })",
          "readRange(efs, opened.file, { offset: 8150n, length: 20n })",
          "readBytes(efs, opened.file)",
        );
        const o = await openFile(efs, { kind: "file", subject: span });
        if (o.status !== "PRESENT") throw new Error(o.status);
        expect((await readRange(efs, o.file, { offset: 8150n, length: 20n })).grade).toBe(
          "VERIFIED",
        );
        expect((await readBytes(efs, o.file)).grade).toBe("VERIFIED");
      },
    );

    // open-external-https: a file whose only location is a publisher's https:// URL, published here as the
    // fixture principal (so the default Lens sees it). The https half is plain fetch, not RPC: a replay must route
    // HTTPS_URL to serve HTTPS_TEXT.
    const HTTPS_URL = "https://files.example/hello.txt";
    const HTTPS_TEXT = new TextEncoder().encode("hello from a gateway\n");
    const owner = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // anvil dev key #0: public, test only
    );
    const plainEfs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
    const w = await createWriter(plainEfs, {
      authorizer: { kind: "local", profile: "direct", account: owner },
      journal: memoryJournal(),
    });
    const docs = (deployment as unknown as { seed: { folder: { directoryRecordId: Hex } } }).seed
      .folder.directoryRecordId;
    const put = putExternal(
      plainEfs,
      w.principal,
      docs,
      "hello.txt",
      { length: BigInt(HTTPS_TEXT.length), sha256: sha256(HTTPS_TEXT), locator: HTTPS_URL },
      keccak256(toHex("fixture-https-hello")),
    );
    const p = await w.planActions(put);
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await w.run(p.plan)).reconcile?.outcome).toBe("COMMITTED");
    const serveHttps: FetchLike = async (url, init) =>
      url === HTTPS_URL
        ? {
            ok: true,
            status: 200,
            headers: {
              get: (n: string) => (n === "content-length" ? String(HTTPS_TEXT.length) : null),
            },
            text: async () => "",
            arrayBuffer: async () => HTTPS_TEXT.slice().buffer,
          }
        : (globalThis.fetch as unknown as FetchLike)(url, init);
    await record(
      "open-external-https",
      "openFile(docs/hello.txt, external at a publisher https:// URL) → readBytes with the default policy " +
        "(POLICY_BLOCKED, blockedOrigins [https://files.example], nothing fetched) → readBytes with " +
        "{ allowOrigins: ['https://files.example'] } → VERIFIED. Route ids.httpsUrl to serve ids.httpsText.",
      { file: put.file, httpsUrl: HTTPS_URL, httpsText: "hello from a gateway\n" },
      async (efs, steps) => {
        steps.push(
          "openFile(efs, { kind: 'file', subject: ids.file })",
          "readBytes(efs, opened.file)  // POLICY_BLOCKED",
          "readBytes(efs, opened.file, { allowOrigins: ['https://files.example'] })  // VERIFIED",
        );
        const o = await openFile(efs, { kind: "file", subject: put.file });
        if (o.status !== "PRESENT") throw new Error(o.status);
        const blocked = await readBytes(efs, o.file);
        expect(blocked.grade).toBe("POLICY_BLOCKED");
        expect(blocked.blockedOrigins).toEqual(["https://files.example"]);
        const once = await readBytes(efs, o.file, { allowOrigins: ["https://files.example"] });
        expect(once.grade).toBe("VERIFIED");
      },
      serveHttps,
    );
  });
});
