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
  saltOrStrength: ZERO_WORD,
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
    plain({ kind: ACTION.CREATE, saltOrStrength: salt }),
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
    plain({ kind: ACTION.CREATE, saltOrStrength: salt }),
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
 * RELEASE my FOLDER entry `name` in `dir` at its revision. The SDK's remove takes only a bound entry, so this is how a
 * test reaches the RELEASE of a hidden (MASKED) one, which the ledger admits.
 */
export function releaseEntry(dir: Hex, name: string, expectedRevision: bigint) {
  const step = plain({
    kind: ACTION.RELEASE,
    purpose: PURPOSES.folder,
    subject: dir,
    role: keccak256(new TextEncoder().encode(name)),
    expectedRevision,
  });
  return {
    actions: [step.action],
    bodies: [step.body],
    effects: [{ code: "files.release", args: { name } }],
  };
}

/**
 * BIND my HEAD at `subject` to `target` (any record) at the binding's revision, with no Files check: the ledger admits
 * a HEAD at any subject naming any existing revision until the tag release refuses it. Tests use it for the HEAD law.
 */
export function bindHead(subject: Hex, target: Hex, expectedRevision: bigint) {
  const step = plain({
    kind: ACTION.BIND,
    purpose: PURPOSES.head,
    subject,
    role: ZERO_WORD,
    target,
    expectedRevision,
  });
  return {
    actions: [step.action],
    bodies: [step.body],
    effects: [{ code: "files.head", args: { subject } }],
  };
}
