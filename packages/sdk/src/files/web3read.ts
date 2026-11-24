// SPDX-License-Identifier: MIT
// Read a web3:// location (ERC-6860 + ERC-5219 resource requests + ERC-7617 chunks) through the client's own RPC
// endpoints: no new party sees the reader. One logical read runs on one endpoint at one block; a failed endpoint
// restarts the whole read on the next one. The caller verifies the returned bytes against the file's sha256.
//
// Checked here, before or while the body arrives: resolveMode is "5219"; Content-Length (the whole file's length on
// every chunk) matches the file; the body never runs past the file or maxBytes; each chunk makes progress; a status
// other than 200 or 307 is a failure of this location (a 307 hands back its Location, which the caller re-plans
// through the gateway policy). A reverting call is a fault of the call (gas, RPC), never "not found".
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { callsAt, getBlock } from "../chain/basis.js";
import { onEndpoint, type Step } from "../chain/pool.js";
import type { Efs } from "../client.js";
import { header, type KeyValue, parsePathQuery, type Web3Url } from "../content/web3.js";
import { type CallOpts, reason } from "../core/errors.js";
import type { Hex } from "../core/hex.js";

/** ERC-5219 `request`, with the body slot decoded as bytes (string and bytes ABI-encode identically). */
const abi = parseAbi([
  "function resolveMode() view returns (bytes32)",
  "function request(string[] resource, (string key, string value)[] params) view returns (uint16 statusCode, bytes body, (string key, string value)[] headers)",
]);
/** "5219", left-aligned in bytes32 (ERC-6944). */
const MODE_5219 = `0x35323139${"0".repeat(56)}`;
/**
 * Bounds that never come from the file or the contract: a hostile contract could otherwise answer with tiny chunks
 * and turn one read into millions of eth_calls against the user's endpoint.
 */
const MAX_CHUNKS = 8192;
/** Every chunk but the last must carry at least this much (the EFS gateway's carry 8,160 bytes). */
const MIN_CHUNK_BYTES = 1024;

export type Web3Outcome =
  | { kind: "BODY"; bytes: Uint8Array }
  | { kind: "REDIRECT"; location: string }
  | { kind: "FAILED"; outcome: "FAILED" | "MISMATCH" | "TOO_LARGE"; detail: string };

export async function readWeb3(
  efs: Efs,
  url: Web3Url,
  expected: { size: bigint; max: bigint },
  o: CallOpts = {},
): Promise<Web3Outcome> {
  // The whole read, across chunks and endpoints, gets ten per-call timeouts (100 s by default).
  const deadline = Date.now() + 10 * (efs.gateways.timeoutMs ?? 10_000);
  const r = await onEndpoint<Web3Outcome>(
    efs._internal.pool,
    async (s): Promise<Step<Web3Outcome>> => {
      const block = await getBlock(s, "latest");
      if (!block.ok) return block;
      const at = block.value.hash;
      const call = (resource: string[], params: KeyValue[]) => ({
        to: url.address,
        data: encodeFunctionData({ abi, functionName: "request", args: [resource, params] }),
      });
      const [mode, first] = await callsAt(s, at, [
        { to: url.address, data: encodeFunctionData({ abi, functionName: "resolveMode" }) },
        call(url.resource, url.params),
      ]);
      if (!mode?.ok)
        return {
          ok: false,
          retryElsewhere: true,
          reason: mode ? mode.reason : reason("RPC_UNAVAILABLE", "transient"),
        };
      if (mode.result === "0x")
        return done({ kind: "FAILED", outcome: "FAILED", detail: `no contract at ${url.address}` });
      if (String(mode.result).toLowerCase() !== MODE_5219)
        return done({
          kind: "FAILED",
          outcome: "FAILED",
          detail: "the contract is not in ERC-5219 resource-request mode",
        });
      const parts: Uint8Array[] = [];
      let total = 0n;
      let next: Awaited<ReturnType<typeof callsAt>>[number] | undefined = first;
      // Each chunk must carry bytes, so a file of n bytes needs at most n chunks; bound it for hostile contracts.
      for (let i = 0; next; i++) {
        if (!next.ok) {
          // The call itself failed: a revert (out of gas, a broken contract) or the transport. Try another endpoint.
          return { ok: false, retryElsewhere: true, reason: next.reason };
        }
        let status: number;
        let body: Hex;
        let headers: readonly KeyValue[];
        try {
          const out = decodeFunctionResult({
            abi,
            functionName: "request",
            data: next.result as Hex,
          });
          status = Number(out[0]);
          body = out[1];
          headers = out[2];
        } catch {
          return done({
            kind: "FAILED",
            outcome: "FAILED",
            detail: "request() returned data that does not decode",
          });
        }
        if (status === 307) {
          const location = header(headers, "location");
          return done(
            location
              ? { kind: "REDIRECT", location }
              : { kind: "FAILED", outcome: "FAILED", detail: "307 without a Location" },
          );
        }
        if (status !== 200)
          return done({ kind: "FAILED", outcome: "FAILED", detail: `web3 status ${status}` });
        const declared = header(headers, "content-length");
        if (
          declared !== undefined &&
          (!/^\d+$/.test(declared) || BigInt(declared) !== expected.size)
        )
          return done({
            kind: "FAILED",
            outcome: "MISMATCH",
            detail: `declares ${declared} bytes`,
          });
        const bytes = hexBytes(body);
        total += BigInt(bytes.length);
        if (total > expected.size)
          return done({
            kind: "FAILED",
            outcome: "MISMATCH",
            detail: `the body is longer than ${expected.size} bytes`,
          });
        if (total > expected.max)
          return done({
            kind: "FAILED",
            outcome: "TOO_LARGE",
            detail: `over ${expected.max} bytes`,
          });
        parts.push(bytes);
        const more = header(headers, "web3-next-chunk");
        if (more === undefined) break;
        if (bytes.length < MIN_CHUNK_BYTES)
          return done({
            kind: "FAILED",
            outcome: "FAILED",
            detail: `a chunk before the last carried ${bytes.length} bytes (at least ${MIN_CHUNK_BYTES} required)`,
          });
        if (i + 1 >= MAX_CHUNKS)
          return done({
            kind: "FAILED",
            outcome: "FAILED",
            detail: `more than ${MAX_CHUNKS} chunks`,
          });
        if (Date.now() > deadline)
          return done({
            kind: "FAILED",
            outcome: "FAILED",
            detail: "the web3 read ran past its time budget",
          });
        const pq = parsePathQuery(more);
        if (!pq)
          return done({ kind: "FAILED", outcome: "FAILED", detail: "a malformed web3-next-chunk" });
        [next] = await callsAt(s, at, [call(pq.resource, pq.params)]);
      }
      const out = new Uint8Array(Number(total));
      let p = 0;
      for (const part of parts) {
        out.set(part, p);
        p += part.length;
      }
      return done({ kind: "BODY", bytes: out });
    },
    o,
  );
  return r.ok
    ? r.value
    : { kind: "FAILED", outcome: "FAILED", detail: r.reason.detail ?? r.reason.code };
}

const done = (v: Web3Outcome): Step<Web3Outcome> => ({ ok: true, value: v });

function hexBytes(h: Hex): Uint8Array {
  const s = h.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
