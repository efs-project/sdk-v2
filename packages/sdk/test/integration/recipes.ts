// SPDX-License-Identifier: MIT
// Test-only Files recipes (raw actions), mirroring contracts src/lib/EfsFiles.sol. They are not SDK API: folder
// shapes stay provisional until the tags-vs-directories ruling.
import { keccak256 } from "viem";
import { ACTION, type ActionData } from "../../src/actions/index.ts";
import type { Efs } from "../../src/client.ts";
import { encode } from "../../src/content/codec.ts";
import { bytesToHex, type Hex, type PrincipalId, ZERO_WORD } from "../../src/core/hex.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { recordId, subjectId } from "../../src/protocol/keys.ts";

const blank: ActionData = {
  kind: 0,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  salt: ZERO_WORD,
};
const publish = (typeId: Hex, body: Uint8Array): { action: ActionData; body: Hex } => ({
  action: { ...blank, kind: ACTION.PUBLISH, typeId, bodyHashOrRecordId: keccak256(body) },
  body: bytesToHex(body),
});
const plain = (a: Partial<ActionData>): { action: ActionData; body: Hex } => ({
  action: { ...blank, ...a },
  body: "0x",
});

/** New inline file `name` in folder `dir` (the name record is published too; re-publishing is harmless). */
export function putInline(
  efs: Efs,
  me: PrincipalId,
  dir: Hex,
  name: string,
  bytes: Uint8Array,
  salt: Hex,
) {
  const t = efs.deployment.typeIds as Record<string, Hex>;
  const file = subjectId(me, salt);
  const rootBody = encode.rootInline(file, bytes);
  const nameBytes = new TextEncoder().encode(name);
  const steps = [
    plain({ kind: ACTION.CREATE, salt }),
    publish(t["files-root/1"] as Hex, rootBody),
    publish(t["files-name/2"] as Hex, nameBytes),
    plain({
      kind: ACTION.BIND,
      purpose: PURPOSES.head,
      subject: file,
      role: ZERO_WORD,
      target: recordId(t["files-root/1"] as Hex, rootBody),
    }),
    plain({
      kind: ACTION.BIND,
      purpose: PURPOSES.folder,
      subject: dir,
      role: keccak256(nameBytes),
      target: file,
    }),
  ];
  return {
    file,
    actions: steps.map((s) => s.action),
    bodies: steps.map((s) => s.body),
    effects: [{ code: "files.put", args: { name } }],
  };
}

/**
 * New external file `name` in folder `dir`, stored at `locator` (mirrors the contracts seed's remote.txt: the empty
 * files-bytes/1 sentinel, a files-external/1 record, and a form-1 root naming it).
 */
export function putExternal(
  efs: Efs,
  me: PrincipalId,
  dir: Hex,
  name: string,
  content: { length: bigint; sha256: Hex; locator: string },
  salt: Hex,
) {
  const t = efs.deployment.typeIds as Record<string, Hex>;
  const file = subjectId(me, salt);
  const sentinelBody = encode.chunk(new Uint8Array());
  const sentinel = recordId(t["files-bytes/1"] as Hex, sentinelBody);
  const externalBody = encode.external(sentinel, content.length, content.sha256, content.locator);
  const external = recordId(t["files-external/1"] as Hex, externalBody);
  const rootBody = encode.rootContent(file, external);
  const nameBytes = new TextEncoder().encode(name);
  const steps = [
    publish(t["files-bytes/1"] as Hex, sentinelBody),
    publish(t["files-external/1"] as Hex, externalBody),
    plain({ kind: ACTION.CREATE, salt }),
    publish(t["files-root/1"] as Hex, rootBody),
    publish(t["files-name/2"] as Hex, nameBytes),
    plain({
      kind: ACTION.BIND,
      purpose: PURPOSES.head,
      subject: file,
      role: ZERO_WORD,
      target: recordId(t["files-root/1"] as Hex, rootBody),
    }),
    plain({
      kind: ACTION.BIND,
      purpose: PURPOSES.folder,
      subject: dir,
      role: keccak256(nameBytes),
      target: file,
    }),
  ];
  return {
    file,
    actions: steps.map((s) => s.action),
    bodies: steps.map((s) => s.body),
    effects: [{ code: "files.put", args: { name } }],
  };
}
