// SPDX-License-Identifier: MIT
// What the person reviews is what they sign (the write-path audit, 2026-11-26). Each planner's save runs through a
// recording EIP-1193 wallet. The calldata the wallet is asked to sign (its own request, never the plan object) is
// decoded with the ledger ABI, and what it does is recomputed from the decoded actions and bodies alone, with protocol
// ids and decoders only, never planner code: a file created, a HEAD moved, a folder entry bound, released or masked,
// a statement, and whose content each published record is. It must equal what the reviewed part's effects say, part
// by part, with the part numbering, and the review object must agree. Also on the paths where planning happens again
// just in time: an atomic batch, a part refused by the wallet and sent on resume, and a part re-split for the cap.
// Accounts 45 and 46 of anvil's public development mnemonic (used by no other test file), impersonated.
import { readFileSync } from "node:fs";
import {
  decodeAbiParameters,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  sha256,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import type { Journal } from "../../src/actions/journal.ts";
import type { SequencePartInput } from "../../src/actions/sequence.ts";
import type { ActionData, EffectView } from "../../src/actions/types.ts";
import { createEfs } from "../../src/client.ts";
import { decodeChunk, decodeContent, decodeRevision, decodeSpan } from "../../src/content/codec.ts";
import { type Address, bytesToHex, type Hex, hexToBytes, lower } from "../../src/core/hex.ts";
import { utf8Encode } from "../../src/core/platform.ts";
import { planEditFile } from "../../src/files/edit.ts";
import {
  planCreateFile,
  planCreateFolder,
  planHideEntries,
  planMoveEntries,
  planRemoveEntries,
  planRestoreEntries,
  planUnhideEntries,
} from "../../src/files/entries.ts";
import type { ParentRef } from "../../src/files/folders.ts";
import { ledgerAbi, ledgerViewsAbi } from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import {
  bindingKey,
  keyPrincipal,
  positionKey,
  recordId,
  subjectId,
} from "../../src/protocol/keys.ts";
import {
  labelKey,
  pathIds,
  planBroader,
  planDeny,
  planLabel,
  planSame,
  planTag,
  planUntag,
  topicTypesOf,
} from "../../src/tags/index.ts";
import { wordPageId } from "../../src/tags/topics.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8"));
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const d = efs.deployment;
const MNEMONIC = "test test test test test test test test test test test junk";
const W = mnemonicToAccount(MNEMONIC, { addressIndex: 45 }).address.toLowerCase() as Address;
const O = mnemonicToAccount(MNEMONIC, { addressIndex: 46 }).address.toLowerCase() as Address;
const ME = keyPrincipal(W);
const OTHER = keyPrincipal(O);
const ZERO = `0x${"0".repeat(64)}` as Hex;

const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
  const res = await fetch(fixture.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const mined = async (hash: unknown): Promise<void> => {
  for (let t = 0; t < 200; t++) {
    if (await rpc("eth_getTransactionReceipt", [hash])) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("not mined");
};

// ---- the protocol's own ids and types (never a planner's)

const typeOf = (k: string): Hex => lower(d.typeIds[k] as Hex);
const T = {
  root: typeOf("files-root/1"),
  child: typeOf("files-child/1"),
  content: typeOf("files-content/1"),
  bytes: typeOf("files-bytes/1"),
  span: typeOf("files-span/1"),
  directory: typeOf("files-directory/1"),
  name: typeOf("files-name/3"),
};
const topics = topicTypesOf(d);
const BIND_KINDS: readonly number[] = [ACTION.BIND, ACTION.UNBIND, ACTION.RELEASE];

// ---- the wallet: what it is asked to sign, and the heads just before

type Head = { state: number; revision: bigint; target: Hex; targetKind: number };
interface Asked {
  /** The `data` of the wallet request, exactly as asked (eth_sendTransaction, or one wallet_sendCalls call). */
  data: Hex;
  to: Hex;
  from: Hex;
  /** Each bind-kind action's head for both accounts, read from the node just before the call went out. */
  pre: Map<Hex, Head>;
  /** The node's own snapshot of the writer's head at each bind-kind action's position, read at the same moment. */
  snapshots: Map<Hex, Hex>;
  refused: boolean;
}

const execute = (data: Hex) => {
  const x = decodeFunctionData({ abi: ledgerAbi, data });
  if (x.functionName !== "execute")
    throw new Error(`the wallet was asked to call ${x.functionName}`);
  const [actions, bodies, ctx, guard] = x.args as unknown as [
    readonly ActionData[],
    readonly Hex[],
    { nonce: bigint; deadline: bigint; expectedExecutionSet: Hex; expectedAcceptanceProfile: Hex },
    Hex,
  ];
  return {
    actions: actions.map((a) => ({
      kind: Number(a.kind),
      typeId: lower(a.typeId),
      bodyHashOrRecordId: lower(a.bodyHashOrRecordId),
      purpose: lower(a.purpose),
      subject: lower(a.subject),
      role: lower(a.role),
      target: lower(a.target),
      expectedRevision: BigInt(a.expectedRevision),
      saltOrStrength: lower(a.saltOrStrength),
    })),
    bodies: bodies.map((b) => lower(b)),
    ctx,
    guard,
  };
};

async function headsBefore(data: Hex): Promise<Map<Hex, Head>> {
  const { actions } = execute(data);
  const keys: Hex[] = [];
  for (const a of actions)
    if (BIND_KINDS.includes(a.kind)) {
      const pos = positionKey(a.purpose, a.subject, a.role);
      keys.push(bindingKey(ME, pos), bindingKey(OTHER, pos));
    }
  const out = new Map<Hex, Head>();
  // LedgerViews.heads takes at most limits.maxReadIds keys a call.
  for (let at = 0; at < keys.length; at += 64) {
    const chunk = keys.slice(at, at + 64);
    const result = (await rpc("eth_call", [
      {
        to: d.readers.ledgerViews,
        data: encodeFunctionData({
          abi: ledgerViewsAbi,
          functionName: "heads",
          args: [d.ledger, chunk],
        }),
      },
      "latest",
    ])) as Hex;
    const [hs] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "heads",
      data: result,
    }) as unknown as [readonly Head[]];
    chunk.forEach((k, i) => {
      const h = hs[i] as Head;
      out.set(lower(k), {
        state: Number(h.state),
        revision: BigInt(h.revision),
        target: lower(h.target),
        targetKind: Number(h.targetKind),
      });
    });
  }
  return out;
}

/** The node's snapshot (LedgerViews.headSnapshots) of the writer's head at each bind-kind action's position, now. */
async function snapshotsBefore(data: Hex): Promise<Map<Hex, Hex>> {
  const { actions } = execute(data);
  const positions = [
    ...new Set(
      actions
        .filter((a) => BIND_KINDS.includes(a.kind))
        .map((a) => lower(positionKey(a.purpose, a.subject, a.role))),
    ),
  ];
  const out = new Map<Hex, Hex>();
  for (let at = 0; at < positions.length; at += 256) {
    const chunk = positions.slice(at, at + 256);
    const result = (await rpc("eth_call", [
      {
        to: d.readers.ledgerViews,
        data: encodeFunctionData({
          abi: ledgerViewsAbi,
          functionName: "headSnapshots",
          args: [d.ledger, [ME], chunk],
        }),
      },
      "latest",
    ])) as Hex;
    const [snaps] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "headSnapshots",
      data: result,
    }) as unknown as [readonly Hex[], readonly Hex[]];
    chunk.forEach((pos, i) => {
      out.set(pos, lower(snaps[i] as Hex));
    });
  }
  return out;
}

/** The impersonated account as an EIP-1193 wallet that records every request it is asked to sign. */
function recorder(account: Address, k: { refuseSend?: number; atomic?: boolean } = {}) {
  const asked: Asked[] = [];
  const batchSizes: number[] = [];
  let sends = 0;
  let batches = 0;
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      const p = (params ?? []) as unknown[];
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      if (method === "eth_sendTransaction") {
        const tx = p[0] as { to: Hex; data: Hex; from: Hex };
        sends++;
        const refused = k.refuseSend === sends;
        asked.push({
          data: lower(tx.data),
          to: lower(tx.to),
          from: lower(tx.from),
          pre: await headsBefore(tx.data),
          snapshots: await snapshotsBefore(tx.data),
          refused,
        });
        if (refused) throw Object.assign(new Error("User rejected"), { code: 4001 });
        const hash = await rpc(method, p);
        await mined(hash);
        return hash;
      }
      if (method === "wallet_getCapabilities") {
        if (!k.atomic) throw Object.assign(new Error("method not found"), { code: -32601 });
        const id = (p as [string, string[]])[1][0] as string;
        return { [id]: { atomic: { status: "supported" } } };
      }
      if (method === "wallet_sendCalls") {
        batches++;
        const req = p[0] as { from: Hex; calls: { to: Hex; data: Hex }[] };
        batchSizes.push(req.calls.length);
        for (const c of req.calls) {
          asked.push({
            data: lower(c.data),
            to: lower(c.to),
            from: lower(req.from),
            pre: await headsBefore(c.data),
            snapshots: await snapshotsBefore(c.data),
            refused: false,
          });
          await mined(
            await rpc("eth_sendTransaction", [{ from: req.from, to: c.to, data: c.data }]),
          );
        }
        return { id: `batch-${batches}` };
      }
      if (method === "wallet_getCallsStatus") return { status: 200 };
      return rpc(method, p);
    },
  };
  return { provider, asked, batchSizes };
}

// ---- what the signed actions do: recomputed from the decoded actions and bodies

/** An effect without its part numbering (code, the args that name the change, and the stage). */
type Did = { code: string; args: Record<string, string>; stage: string };
const didOf = (e: EffectView): Did => {
  const { part: _p, parts: _n, stage, ...args } = e.args;
  return { code: e.code, args, stage: stage ?? "" };
};
const key = (x: Did): string =>
  JSON.stringify([x.code, x.stage, Object.entries(x.args).sort(([a], [b]) => (a < b ? -1 : 1))]);

/** What the test itself named: names by role, topics' words, label languages and texts. */
interface Known {
  names: Map<Hex, string>;
  /** Every word list a save may register (each prefix's topic and each word's page). */
  words: readonly (readonly string[])[];
  langs: readonly string[];
  lens: readonly Hex[];
  /**
   * What the requests' read-set guards must be: "written" (default), every head a request's actions write and nothing
   * else, each expected value the node's own snapshot just before; "none", no guard (a planner not guarded yet).
   */
  guard?: "written" | "none";
}

interface Tx {
  actions: ReturnType<typeof execute>["actions"];
  bodies: Hex[];
  pre: Map<Hex, Head>;
}
interface Revision {
  id: Hex;
  code: "files.create" | "files.edit";
  args: Record<string, string>;
  /** The records that hold its content: the descriptor and its chunk tree (empty for inline). */
  content: Set<Hex>;
}

/**
 * Recompute each transaction's effects from its decoded actions alone, for a whole save (a content part names the
 * file whose content it stores, which only the save's finish part says). Anything left unexplained is an effect
 * "UNEXPLAINED", so it can never match a review.
 */
function explain(txs: readonly Tx[], k: Known): Did[][] {
  // Every record the save publishes, by id.
  const pubs = new Map<Hex, { typeId: Hex; body: Uint8Array }>();
  for (const t of txs)
    t.actions.forEach((a, i) => {
      if (a.kind !== ACTION.PUBLISH) return;
      const body = t.bodies[i] as Hex;
      expect(a.bodyHashOrRecordId).toBe(lower(keccak256(body)));
      pubs.set(lower(recordId(a.typeId, body)), { typeId: a.typeId, body: hexToBytes(body) });
    });
  const nameOf = (role: Hex): string => {
    const n = k.names.get(lower(role));
    if (n === undefined) throw new Error(`a folder entry at a role the test never named: ${role}`);
    expect(lower(keccak256(utf8Encode(n)))).toBe(lower(role));
    return n;
  };
  const nameRecordOf = (role: Hex): Hex => lower(recordId(T.name, utf8Encode(nameOf(role))));
  const registration = new Set<Hex>();
  for (const w of k.words) {
    for (const id of pathIds(topics, w)) registration.add(lower(id));
    for (const x of w) registration.add(lower(wordPageId(topics, x)));
  }

  /** A revision's content: its descriptor and the chunk tree under it, checked to hash to what it declares. */
  const contentOf = (rev: Hex, kind: "root" | "child") => {
    const rec = pubs.get(rev);
    if (!rec) throw new Error("a HEAD bound to a revision this save never published");
    const r = decodeRevision(rec.body, kind);
    if (!r) throw new Error("a revision body that doesn't decode");
    if (r.form === "inline")
      return {
        r,
        facts: {
          size: String(r.bytes.length),
          sha256: lower(sha256(r.bytes)),
          layout: "inline",
          mediaType: "",
        },
        content: new Set<Hex>(),
      };
    const desc = pubs.get(lower(r.descriptor));
    if (!desc || desc.typeId !== T.content)
      throw new Error("a content revision without its descriptor");
    const c = decodeContent(desc.body);
    if (!c) throw new Error("a descriptor that doesn't decode");
    const content = new Set<Hex>([lower(r.descriptor)]);
    const walk = (id: Hex): Uint8Array => {
      const x = pubs.get(lower(id));
      if (!x) throw new Error(`a content record this save never published: ${id}`);
      content.add(lower(id));
      if (x.typeId === T.bytes) {
        const ch = decodeChunk(x.body);
        if (!ch) throw new Error("a chunk that doesn't decode");
        expect(lower(sha256(ch.payload))).toBe(lower(ch.sha256));
        return ch.payload;
      }
      if (x.typeId === T.span) {
        const s = decodeSpan(x.body);
        if (!s) throw new Error("a span that doesn't decode");
        const l = walk(s.left);
        const rr = walk(s.right);
        const out = new Uint8Array(l.length + rr.length);
        out.set(l);
        out.set(rr, l.length);
        expect(BigInt(out.length)).toBe(s.length);
        return out;
      }
      throw new Error(`a content tree holding a record of another Type: ${x.typeId}`);
    };
    const bytes = walk(c.bytesRef);
    expect(BigInt(bytes.length)).toBe(c.length);
    expect(lower(sha256(bytes))).toBe(lower(c.sha256));
    const layout = pubs.get(lower(c.bytesRef))?.typeId === T.span ? "span" : "chunk";
    return {
      r,
      facts: { size: String(c.length), sha256: lower(c.sha256), layout, mediaType: c.mediaType },
      content,
    };
  };

  const revisions: Revision[] = [];
  const per: { did: Did[]; used: Set<number>; tx: Tx }[] = txs.map((tx) => ({
    did: [],
    used: new Set(),
    tx,
  }));
  for (const p of per) {
    const { actions } = p.tx;
    const at = (i: number) => actions[i] as Tx["actions"][number];
    const use = (i: number) => p.used.add(i);
    const find = (f: (a: Tx["actions"][number], i: number) => boolean): number =>
      actions.findIndex((a, i) => !p.used.has(i) && f(a, i));
    const pubIndex = (id: Hex): number =>
      find(
        (a, i) =>
          a.kind === ACTION.PUBLISH &&
          lower(recordId(a.typeId, p.tx.bodies[i] as Hex)) === lower(id),
      );
    const useName = (role: Hex) => {
      const j = pubIndex(nameRecordOf(role));
      if (j >= 0) use(j);
    };
    const folderBindTo = (target: Hex): number =>
      find(
        (a) =>
          a.kind === ACTION.BIND && a.purpose === PURPOSES.folder && a.target === lower(target),
      );

    // A new file: CREATE, its root revision, its HEAD, its folder entry.
    actions.forEach((a, i) => {
      if (a.kind !== ACTION.CREATE || p.used.has(i)) return;
      const file = lower(subjectId(ME, a.saltOrStrength));
      const head = find(
        (b) => b.kind === ACTION.BIND && b.purpose === PURPOSES.head && b.subject === file,
      );
      const entry = folderBindTo(file);
      if (head < 0 || entry < 0) return;
      const rev = at(head).target;
      const { r, content } = contentOf(rev, "root");
      expect(lower(r.file)).toBe(file);
      expect(at(head).role).toBe(ZERO);
      use(i);
      use(head);
      use(entry);
      use(pubIndex(rev));
      useName(at(entry).role);
      const args = { folder: at(entry).subject, name: nameOf(at(entry).role), file, revision: rev };
      revisions.push({ id: rev, code: "files.create", args, content });
      p.did.push({ code: "files.create", args, stage: "finish" });
    });
    // A new folder: its directory record (by this writer) and its folder entry.
    actions.forEach((a, i) => {
      if (a.kind !== ACTION.PUBLISH || a.typeId !== T.directory || p.used.has(i)) return;
      const body = hexToBytes(p.tx.bodies[i] as Hex);
      expect(bytesToHex(body.subarray(0, 32))).toBe(lower(ME));
      const dir = lower(recordId(T.directory, body));
      const entry = folderBindTo(dir);
      if (entry < 0) return;
      use(i);
      use(entry);
      useName(at(entry).role);
      p.did.push({
        code: "files.createFolder",
        args: { folder: at(entry).subject, name: nameOf(at(entry).role), directory: dir },
        stage: "finish",
      });
    });
    // An edit: a child revision of the file and its HEAD.
    actions.forEach((a, i) => {
      if (a.kind !== ACTION.BIND || a.purpose !== PURPOSES.head || p.used.has(i)) return;
      const rec = pubs.get(a.target);
      if (!rec || rec.typeId !== T.child) return;
      const { r, facts, content } = contentOf(a.target, "child");
      expect(lower(r.file)).toBe(a.subject);
      use(i);
      use(pubIndex(a.target));
      const args: Record<string, string> = {
        file: a.subject,
        base: lower(r.parent as Hex),
        revision: a.target,
        author: lower(ME),
        size: facts.size,
        sha256: facts.sha256,
        layout: facts.layout,
        ...(facts.mediaType ? { mediaType: facts.mediaType } : {}),
      };
      revisions.push({ id: a.target, code: "files.edit", args, content });
      p.did.push({ code: "files.edit", args, stage: "finish" });
    });
    // Folder entries left: moves (a release followed by a bind), restores, removes, hides and unhides.
    const mine = (a: Tx["actions"][number]) =>
      p.tx.pre.get(lower(bindingKey(ME, positionKey(a.purpose, a.subject, a.role)))) as Head;
    const theirs = (a: Tx["actions"][number], who: Hex) =>
      p.tx.pre.get(
        lower(bindingKey(who as never, positionKey(a.purpose, a.subject, a.role))),
      ) as Head;
    for (let i = 0; i < actions.length; i++) {
      const a = at(i);
      if (p.used.has(i) || a.purpose !== PURPOSES.folder || !BIND_KINDS.includes(a.kind)) continue;
      const name = nameOf(a.role);
      if (a.kind === ACTION.RELEASE) {
        const next = actions.findIndex(
          (b, j) =>
            j > i && !p.used.has(j) && b.purpose === PURPOSES.folder && BIND_KINDS.includes(b.kind),
        );
        const b = next >= 0 ? at(next) : undefined;
        if (b && b.kind === ACTION.BIND) {
          use(i);
          use(next);
          useName(b.role);
          p.did.push({
            code: "files.move",
            args: {
              folder: a.subject,
              name,
              toFolder: b.subject,
              toName: nameOf(b.role),
              target: b.target,
            },
            stage: "finish",
          });
          continue;
        }
        use(i);
        const before = mine(a);
        p.did.push(
          before.state === 2
            ? { code: "files.unhide", args: { folder: a.subject, name }, stage: "finish" }
            : {
                code: "files.remove",
                args: { folder: a.subject, name, target: before.target, hide: "false" },
                stage: "finish",
              },
        );
      } else if (a.kind === ACTION.BIND) {
        use(i);
        p.did.push({
          code: "files.restore",
          args: { folder: a.subject, name, target: a.target },
          stage: "finish",
        });
      } else {
        use(i);
        useName(a.role);
        const before = mine(a);
        if (before.state === 1) {
          p.did.push({
            code: "files.remove",
            args: { folder: a.subject, name, target: before.target, hide: "true" },
            stage: "finish",
          });
        } else {
          const shown = k.lens.find((who) => who !== lower(ME) && theirs(a, who)?.state === 1);
          p.did.push({
            code: "files.hide",
            args: { folder: a.subject, name, ...(shown ? { author: shown } : {}) },
            stage: "finish",
          });
        }
      }
    }
    // Statements about topics and homes.
    for (let i = 0; i < actions.length; i++) {
      const a = at(i);
      if (p.used.has(i) || !BIND_KINDS.includes(a.kind)) continue;
      const strength = BigInt(a.saltOrStrength);
      if (a.purpose === PURPOSES.tag) {
        use(i);
        if (a.kind === ACTION.BIND) {
          expect(a.target).toBe(a.role);
          p.did.push({
            code: "tags.tag",
            args: { topic: a.subject, thing: a.role, number: String(strength) },
            stage: "finish",
          });
        } else if (a.kind === ACTION.UNBIND) {
          expect(a.target).toBe(ZERO);
          p.did.push({
            code: "tags.deny",
            args: { topic: a.subject, thing: a.role, number: String(-1n - strength) },
            stage: "finish",
          });
        } else
          p.did.push({
            code: "tags.untag",
            args: { topic: a.subject, thing: a.role },
            stage: "finish",
          });
      } else if (a.purpose === PURPOSES.property) {
        const lang = k.langs.find((l) => lower(labelKey(l)) === a.role);
        if (!lang) continue;
        use(i);
        if (a.kind === ACTION.BIND) {
          const text = pubs.get(a.target);
          if (text) use(pubIndex(a.target));
        }
        p.did.push({
          code: "tags.label",
          args: { subject: a.subject, lang, remove: String(a.kind === ACTION.RELEASE) },
          stage: "finish",
        });
      } else if (a.purpose === PURPOSES.same || a.purpose === PURPOSES.broader) {
        use(i);
        if (a.kind === ACTION.BIND) expect(a.target).toBe(a.role);
        p.did.push({
          code: a.purpose === PURPOSES.same ? "tags.same" : "tags.broader",
          args: { subject: a.subject, other: a.role, remove: String(a.kind === ACTION.RELEASE) },
          stage: "finish",
        });
      }
    }
    // Registration (word pages and path records the test's own words name) and label texts.
    actions.forEach((a, i) => {
      if (p.used.has(i) || a.kind !== ACTION.PUBLISH) return;
      const id = lower(recordId(a.typeId, p.tx.bodies[i] as Hex));
      if ((a.typeId === topics.word || a.typeId === topics.path) && registration.has(id)) use(i);
      if (a.typeId === topics.text) use(i);
    });
  }
  // Content: a part that publishes a revision's chunk or span records stores that revision's content, whether or not
  // it also finishes the save (the descriptor and the revision itself belong to the finish).
  for (const p of per) {
    const owners = new Set<Revision>();
    p.tx.actions.forEach((a, i) => {
      if (p.used.has(i) || a.kind !== ACTION.PUBLISH) return;
      const id = lower(recordId(a.typeId, p.tx.bodies[i] as Hex));
      const owner = revisions.find((r) => r.content.has(id));
      if (!owner) return;
      p.used.add(i);
      if (a.typeId === T.bytes || a.typeId === T.span) owners.add(owner);
    });
    for (const r of owners) p.did.push({ code: r.code, args: r.args, stage: "content" });
  }
  // A part that only registers names the save's subject, as its statement part does.
  const subject =
    per.flatMap((p) => p.did).find((x) => x.code.startsWith("tags."))?.args ??
    ({} as Record<string, string>);
  for (const p of per) {
    if (p.did.length === 0 && p.used.size === p.tx.actions.length && p.used.size > 0)
      p.did.push({
        code: "tags.register",
        args: { topic: (subject["topic"] ?? subject["subject"]) as string },
        stage: "register",
      });
    p.tx.actions.forEach((_, i) => {
      if (!p.used.has(i))
        p.did.push({ code: "UNEXPLAINED", args: { index: String(i) }, stage: "" });
    });
  }
  return per.map((p) => p.did);
}

const READ_SET = [
  {
    type: "tuple",
    components: [
      { name: "principals", type: "bytes32[]" },
      { name: "positions", type: "bytes32[]" },
      { name: "expectedHeads", type: "bytes32[]" },
    ],
  },
] as const;
/**
 * The read-set guard a request signs, from its decoded actions alone: it names the writer at exactly the positions its
 * BIND, UNBIND and RELEASE actions write (each once, nothing else), and every expected snapshot is the node's own
 * snapshot of that head just before the request, so the guard passes on an honest chain. A request that writes no
 * head carries none.
 */
function guardIsTheWrittenHeads(
  e: ReturnType<typeof execute>,
  x: Asked,
  mode: "written" | "none",
): void {
  const written = [
    ...new Set(
      e.actions
        .filter((a) => BIND_KINDS.includes(a.kind))
        .map((a) => lower(positionKey(a.purpose, a.subject, a.role))),
    ),
  ];
  if (mode === "none" || written.length === 0) {
    expect(e.guard).toBe("0x");
    return;
  }
  const [rs] = decodeAbiParameters(READ_SET, e.guard);
  expect(rs.principals.map((p) => lower(p))).toEqual([lower(ME)]);
  expect([...rs.positions.map((p) => lower(p))].sort()).toEqual([...written].sort());
  expect(rs.expectedHeads.map((h) => lower(h))).toEqual(
    rs.positions.map((p) => x.snapshots.get(lower(p))),
  );
}

/**
 * The invariant: what each wallet request asked to sign does exactly what its reviewed part's effects say. `parts` is
 * the save as reviewed (or, after a re-split, the journal's parts the person is shown progress for); every asked
 * request is one of them, in order, and every part was asked.
 */
function signedIsReviewed(
  parts: readonly SequencePartInput[],
  asked: readonly Asked[],
  k: Known,
): void {
  const txs = asked.map((x) => {
    expect(x.to).toBe(lower(d.ledger));
    expect(x.from).toBe(W);
    const e = execute(x.data);
    guardIsTheWrittenHeads(e, x, k.guard ?? "written");
    return { ...e, pre: x.pre };
  });
  // Which part each request is: the same actions and bodies, in order (a refused part is asked again on resume).
  let at = 0;
  const partOf = txs.map((t) => {
    const same = (p: SequencePartInput) =>
      JSON.stringify(
        p.actions
          .map((a) => ({ ...a, expectedRevision: String(a.expectedRevision) }))
          .map(lowerAll),
      ) ===
        JSON.stringify(
          t.actions
            .map((a) => ({ ...a, expectedRevision: String(a.expectedRevision) }))
            .map(lowerAll),
        ) && JSON.stringify(p.bodies.map(lower)) === JSON.stringify(t.bodies);
    while (at < parts.length && !same(parts[at] as SequencePartInput)) at++;
    if (at === parts.length)
      throw new Error("the wallet was asked to sign actions no reviewed part holds");
    return at;
  });
  expect([...new Set(partOf)]).toEqual(parts.map((_, i) => i));
  // Effects recomputed from what was signed, against the part's own (as a set; the part numbering checked apart).
  const did = explain(
    // one transaction per part for the save-level content check: the last request of each part
    parts.map((_, i) => txs[partOf.lastIndexOf(i)] as Tx),
    k,
  );
  /** A revision's "content" effect is implied by its "finish" in the same part (planners say it either way). */
  const implied = (xs: readonly Did[]): string[] =>
    [
      ...new Set(
        xs
          .filter(
            (x) =>
              x.stage !== "content" ||
              !xs.some(
                (y) =>
                  y.stage === "finish" &&
                  y.code === x.code &&
                  y.args["revision"] === x.args["revision"],
              ),
          )
          .map(key),
      ),
    ].sort();
  parts.forEach((p, i) => {
    const want = implied(p.effects.map(didOf));
    const got = implied(did[i] as Did[]);
    expect(got, `part ${i + 1} of ${parts.length}`).toEqual(want);
    for (const e of p.effects)
      if (e.args["part"] !== undefined)
        expect([e.args["part"], e.args["parts"]]).toEqual([String(i + 1), String(parts.length)]);
  });
}
const lowerAll = (a: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : v]),
  );

// ---- running a save through the recording wallet

async function run(
  parts: readonly SequencePartInput[],
  k: { account?: Address; refuseSend?: number; atomic?: boolean; journal?: Journal } = {},
) {
  const account = k.account ?? W;
  const rec = recorder(account, k);
  const journal = k.journal ?? memoryJournal();
  const writer = await createWriter(efs, {
    authorizer: { kind: "eip1193", profile: "direct", provider: rec.provider, account },
    journal,
  });
  const progress = await writer.runSequence(parts, { batch: k.atomic ? "auto" : "never" });
  return { progress, asked: rec.asked, journal, rec };
}
const planned = <R extends { status: string }>(
  r: R,
): Extract<R, { status: "PLANNED" }> & { parts: readonly SequencePartInput[] } => {
  if (r.status !== "PLANNED") throw new Error(`not planned: ${JSON.stringify(r)}`);
  return r as Extract<R, { status: "PLANNED" }> & { parts: readonly SequencePartInput[] };
};

// ---- the saves

const tag = `sr${Date.now().toString(36)}`;
const names = new Map<Hex, string>();
const named = (n: string): string => {
  names.set(lower(keccak256(utf8Encode(n))), n);
  return n;
};
const home: ParentRef = { kind: "home", address: W };
const lensWO = { principals: [ME, OTHER] };
const known = (extra: Partial<Known> = {}): Known => ({
  names,
  words: [],
  langs: [],
  lens: [lower(ME), lower(OTHER)],
  ...extra,
});
const bytesOf = (n: number, seed: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

let folder: ParentRef;
let hello: Hex;

beforeAll(async () => {
  for (const a of [W, O]) {
    await rpc("anvil_impersonateAccount", [a]);
    await rpc("anvil_setBalance", [a, "0x56bc75e2d63100000"]);
  }
}, 60_000);

describe("folders and files: every planner, signed as reviewed", () => {
  it("planCreateFolder", async () => {
    const r = planned(
      await planCreateFolder(efs, { principal: ME }, { folder: home, name: named(`${tag}-docs`) }),
    );
    const { progress, asked } = await run(r.parts);
    signedIsReviewed(r.parts, asked, known());
    expect(progress.state).toBe("COMPLETE");
    folder = { kind: "folder", directory: r.review.created.directory };
  });

  it("planCreateFile, inline (one part)", async () => {
    const content = utf8Encode("hello, reviewed\n");
    const r = planned(
      await planCreateFile(efs, { principal: ME }, { folder, name: named("hello.txt"), content }),
    );
    const { progress, asked } = await run(r.parts);
    signedIsReviewed(r.parts, asked, known());
    expect(progress.state).toBe("COMPLETE");
    hello = r.review.file.subject;
    expect(r.review.sha256).toBe(lower(sha256(content)));
  });

  it("planCreateFile, chunked over several parts: each content part stores this file's bytes", async () => {
    const content = bytesOf(40_000, 7);
    const r = planned(
      await planCreateFile(efs, { principal: ME }, { folder, name: named("big.bin"), content }),
    );
    expect(r.parts.length).toBeGreaterThan(1);
    const { progress, asked } = await run(r.parts);
    signedIsReviewed(r.parts, asked, known());
    expect(progress.state).toBe("COMPLETE");
    expect(r.review.sha256).toBe(lower(sha256(content)));
    expect(r.review.size).toBe(40_000n);
  });

  it("planMoveEntries: a rename and a move to another folder", async () => {
    const r = planned(
      await planMoveEntries(
        efs,
        { principal: ME },
        {
          moves: [
            { from: { folder, name: "hello.txt" }, to: { name: named("hi.txt") } },
            {
              from: { folder, name: "big.bin" },
              to: { folder: home, name: named(`${tag}-big.bin`) },
            },
          ],
        },
      ),
    );
    const { progress, asked } = await run(r.parts);
    signedIsReviewed(r.parts, asked, known());
    expect(progress.state).toBe("COMPLETE");
    expect(r.review.moves.map((m) => m.target)).toEqual([
      { kind: "file", subject: hello },
      expect.objectContaining({ kind: "file" }),
    ]);
  });

  it("planRemoveEntries, then planRestoreEntries, then a hiding remove", async () => {
    const rm = planned(
      await planRemoveEntries(efs, { principal: ME }, { entries: [{ folder, name: "hi.txt" }] }),
    );
    let out = await run(rm.parts);
    signedIsReviewed(rm.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
    const back = planned(
      await planRestoreEntries(efs, { principal: ME }, { entries: [{ folder, name: "hi.txt" }] }),
    );
    out = await run(back.parts);
    signedIsReviewed(back.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
    const hide = planned(
      await planRemoveEntries(
        efs,
        { principal: ME },
        { entries: [{ folder: home, name: `${tag}-big.bin` }], hide: true },
      ),
    );
    out = await run(hide.parts);
    signedIsReviewed(hide.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
  });

  it("planHideEntries and planUnhideEntries over another author's entry", async () => {
    const theirs = planned(
      await planCreateFile(
        efs,
        { principal: OTHER },
        { folder, name: named("theirs.txt"), content: utf8Encode("theirs\n") },
      ),
    );
    const made = await run(theirs.parts, { account: O });
    expect(made.progress.state).toBe("COMPLETE");
    const hide = planned(
      await planHideEntries(
        efs,
        { principal: ME },
        { entries: [{ folder, name: "theirs.txt" }], lens: lensWO },
      ),
    );
    let out = await run(hide.parts);
    signedIsReviewed(hide.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
    const unhide = planned(
      await planUnhideEntries(
        efs,
        { principal: ME },
        { entries: [{ folder, name: "theirs.txt" }], lens: lensWO },
      ),
    );
    out = await run(unhide.parts);
    signedIsReviewed(unhide.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
  });

  it("planEditFile, inline and chunked over several parts", async () => {
    // The base is the file's current revision: hello's root, as the create planned it.
    const head = (await rpc("eth_call", [
      {
        to: d.readers.ledgerViews,
        data: encodeFunctionData({
          abi: ledgerViewsAbi,
          functionName: "heads",
          args: [d.ledger, [bindingKey(ME, positionKey(PURPOSES.head, hello, ZERO))]],
        }),
      },
      "latest",
    ])) as Hex;
    const [[h]] = decodeFunctionResult({
      abi: ledgerViewsAbi,
      functionName: "heads",
      data: head,
    }) as unknown as [[Head]];
    const base = lower(h.target);
    const small = planned(
      await planEditFile(
        efs,
        { principal: ME },
        {
          file: { kind: "file", subject: hello as never },
          base: { kind: "revision", recordId: base as never },
          content: utf8Encode("hello again\n"),
          lens: { principals: [ME] },
        },
      ),
    );
    let out = await run(small.parts);
    signedIsReviewed(small.parts, out.asked, known({ guard: "none" }));
    expect(out.progress.state).toBe("COMPLETE");
    const big = planned(
      await planEditFile(
        efs,
        { principal: ME },
        {
          file: { kind: "file", subject: hello as never },
          base: { kind: "revision", recordId: small.review.revision as never },
          content: bytesOf(36_000, 3),
          mediaType: "application/octet-stream",
          lens: { principals: [ME] },
        },
      ),
    );
    expect(big.parts.length).toBeGreaterThan(1);
    out = await run(big.parts);
    signedIsReviewed(big.parts, out.asked, known({ guard: "none" }));
    expect(out.progress.state).toBe("COMPLETE");
  });
});

describe("topics and homes: every planner, signed as reviewed", () => {
  const deep = [tag, "x", "y"];
  const A1 = `0x${"a1".repeat(20)}` as Address;
  const A2 = `0x${"a2".repeat(20)}` as Address;

  it("planTag (registration and statements), planDeny, planUntag", async () => {
    const t = planned(
      await planTag(
        efs,
        { principal: ME },
        {
          topic: deep,
          targets: [
            { kind: "address", address: A1 },
            { kind: "address", address: A2 },
          ],
          number: 4,
        },
      ),
    );
    let out = await run(t.parts);
    signedIsReviewed(t.parts, out.asked, known({ words: [deep] }));
    expect(out.progress.state).toBe("COMPLETE");
    const n = planned(
      await planDeny(
        efs,
        { principal: ME },
        { topic: deep, targets: [{ kind: "address", address: A2 }], number: -3 },
      ),
    );
    out = await run(n.parts);
    signedIsReviewed(n.parts, out.asked, known({ words: [deep] }));
    expect(out.progress.state).toBe("COMPLETE");
    const u = planned(
      await planUntag(
        efs,
        { principal: ME },
        { topic: deep, targets: [{ kind: "address", address: A1 }] },
      ),
    );
    out = await run(u.parts);
    signedIsReviewed(u.parts, out.asked, known({ words: [deep] }));
    expect(out.progress.state).toBe("COMPLETE");
    // A home is a place too.
    const h = planned(
      await planTag(
        efs,
        { principal: ME },
        { topic: { kind: "home", address: W }, targets: [{ kind: "address", address: A1 }] },
      ),
    );
    out = await run(h.parts);
    signedIsReviewed(h.parts, out.asked, known());
    expect(out.progress.state).toBe("COMPLETE");
    expect(h.review.place).toMatchObject({ kind: "home" });
  });

  it("planLabel, planSame, planBroader, and taking each back", async () => {
    const x = [tag, "x"];
    const z = [tag, "z"];
    const w = [tag, "w"];
    const words = [x, z, w, deep];
    for (const plan of [
      () => planLabel(efs, { principal: ME }, { topic: x, lang: "en", text: "Ex, reviewed" }),
      () => planSame(efs, { principal: ME }, { topic: x, other: z }),
      () => planBroader(efs, { principal: ME }, { topic: deep, broader: w }),
      () => planLabel(efs, { principal: ME }, { topic: x, lang: "en", remove: true }),
      () => planSame(efs, { principal: ME }, { topic: x, other: z, remove: true }),
      () => planBroader(efs, { principal: ME }, { topic: deep, broader: w, remove: true }),
    ]) {
      const r = planned(await plan());
      const out = await run(r.parts);
      signedIsReviewed(r.parts, out.asked, known({ words, langs: ["en"] }));
      expect(out.progress.state).toBe("COMPLETE");
    }
  });
});

describe("where a part is planned again just in time", () => {
  it("an atomic EIP-5792 batch: every call in the request is its reviewed part", async () => {
    // Planned to a quarter of the cap, so consecutive parts fit one transaction together and go in one request.
    const topic = [tag, "batch"];
    const targets = Array.from({ length: 24 }, (_, i) => ({
      kind: "address" as const,
      address: `0x${(0xba7c00 + i).toString(16).padStart(40, "0")}` as Address,
    }));
    const r = planned(
      await planTag(efs, { principal: ME }, { topic, targets }, { txGasCap: 4_500_000n }),
    );
    expect(r.parts.length).toBeGreaterThan(2);
    const { progress, asked, rec } = await run(r.parts, { atomic: true });
    expect(progress.state).toBe("COMPLETE");
    expect(rec.batchSizes.some((n) => n > 1)).toBe(true);
    signedIsReviewed(r.parts, asked, known({ words: [topic] }));
  });

  it("a part the wallet refused is asked again on resume: the same reviewed actions, planned anew", async () => {
    const r = planned(
      await planCreateFile(
        efs,
        { principal: ME },
        { folder, name: named("resumed.bin"), content: bytesOf(30_000, 13) },
      ),
    );
    expect(r.parts.length).toBeGreaterThan(1);
    const first = await run(r.parts, { refuseSend: 2 });
    expect(first.progress.state).toBe("PARTIAL");
    const again = recorder(W);
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: again.provider, account: W },
      journal: first.journal,
    });
    const done = await writer.resume(first.progress.sequenceId, { batch: "never" });
    expect(done.state).toBe("COMPLETE");
    const asked = [...first.asked, ...again.asked];
    expect(asked.filter((x) => x.refused)).toHaveLength(1);
    // The refused request and its re-ask are the same reviewed part (new nonce and deadline, same actions).
    expect(execute((asked[1] as Asked).data).actions).toEqual(
      execute((asked[2] as Asked).data).actions,
    );
    signedIsReviewed(r.parts, asked, known());
  });

  it("a part re-split for the cap: the pieces signed are the reviewed part's actions and effects, in order", async () => {
    // Twelve fresh words and 30 fresh addresses, merged into one part with its units kept (resplit.test): the chain
    // prices it over 2^24, so the save cuts it between units before anything is sent.
    const words = [tag, ...Array.from({ length: 11 }, (_, i) => `s${i}`)];
    const targets = Array.from({ length: 30 }, (_, i) => ({
      kind: "address" as const,
      address: `0x${(0xc0de00 + i).toString(16).padStart(40, "0")}` as Address,
    }));
    const t = planned(await planTag(efs, { principal: ME }, { topic: words, targets }));
    // The merged part keeps every part's guarded heads, re-indexed to its actions: each piece the cut makes must
    // carry exactly its own actions' heads, never the merged part's (PM condition 2), which the oracle checks on each
    // signed request (the guard names exactly the heads it writes, at the node's snapshots).
    let offset = 0;
    const guard = t.parts.flatMap((p) => {
      const g = (p.guard ?? []).map((h) => ({ ...h, action: h.action + offset }));
      offset += p.actions.length;
      return g;
    });
    expect(guard.length).toBe(targets.length);
    const one: SequencePartInput = {
      actions: t.parts.flatMap((p) => p.actions),
      bodies: t.parts.flatMap((p) => p.bodies),
      effects: t.parts.flatMap((p) => p.effects),
      units: t.parts.flatMap((p) => p.units ?? []),
      guard,
    };
    // The cut needs more approvals than the review said: the save stops before asking (RESPLIT), and resume sends
    // the pieces, each planned just in time.
    const first = await run([one]);
    expect(first.progress).toMatchObject({ state: "NOT_STARTED", reason: { code: "RESPLIT" } });
    expect(first.asked).toEqual([]);
    const again = recorder(W);
    const writer = await createWriter(efs, {
      authorizer: { kind: "eip1193", profile: "direct", provider: again.provider, account: W },
      journal: first.journal,
    });
    const progress = await writer.resume(first.progress.sequenceId, { batch: "never" });
    expect(progress.state).toBe("COMPLETE");
    const asked = again.asked;
    const journal = first.journal;
    const seq = await journal.getSequence(progress.sequenceId);
    const pieces = (seq?.parts ?? []).map((p) => ({
      actions: p.actions,
      bodies: p.bodies,
      effects: p.effects,
    }));
    expect(pieces.length).toBeGreaterThan(1);
    // Nothing gained or lost by the cut: the pieces' actions are the reviewed part's, in order, and so are their
    // guarded heads, each piece's its own (re-indexed to it), the journal's record of them covered by its parts hash.
    expect(pieces.flatMap((p) => p.actions)).toEqual(one.actions);
    const journaled = seq?.parts ?? [];
    expect(journaled.flatMap((p) => (p.guard ?? []).map((h) => h.position))).toEqual(
      guard.map((h) => h.position),
    );
    for (const p of journaled)
      for (const h of p.guard ?? []) expect(h.action).toBeLessThan(p.actions.length);
    signedIsReviewed(pieces, asked, known({ words: [words] }));
    // And the statements the pieces say are the reviewed part's statements.
    const say = (ps: readonly SequencePartInput[]) =>
      [
        ...new Set(
          ps
            .flatMap((p) => p.effects)
            .filter((e) => e.code !== "tags.register")
            .map((e) => key(didOf(e))),
        ),
      ].sort();
    expect(say(pieces)).toEqual(say([one]));
  });
});
