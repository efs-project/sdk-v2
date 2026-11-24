// SPDX-License-Identifier: MIT
// Record real results from a fixture chain into fixtures/*.json, for the client's chain-free UI tests.
// Runs only with EFS_RECORD=1 (pnpm record:fixtures). Each file: { schema, contractsCommit, case, note, result }.
// `result` is encoded with toJson (bigint and Uint8Array tagged); decode it with fromJson.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, sha256, toHex } from "viem";
import { describe, expect, inject, it } from "vitest";
import { createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { FetchLike } from "../../src/chain/rpc.ts";
import { createEfs } from "../../src/client.ts";
import type { Hex, RecordId, SubjectId } from "../../src/core/hex.ts";
import { toJson } from "../../src/core/json.ts";
import { type OpenedFile, openFile, readBytes, readRange } from "../../src/files/bytes.ts";
import { PROTOCOL_INPUTS } from "../../src/generated/inputs.ts";
import { putInline } from "./recipes.ts";

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
    if (ext.status === "PRESENT")
      save(
        "bytes-external-unsupported",
        "readBytes on the web3:// file (no gateway yet)",
        await readBytes(efs, ext.file),
      );

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
    const via = (fetch: FetchLike) => createEfs({ rpcs: [fixture.rpcUrl], deployment, fetch });
    save(
      "bytes-external-verified",
      "readBytes on an https location serving the right bytes",
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
      "readBytes on a plain http:// location (blocked by default)",
      await readBytes(efs, {
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
