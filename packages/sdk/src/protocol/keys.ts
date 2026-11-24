// SPDX-License-Identifier: MIT
// Id derivations, a TypeScript twin of contracts src/lib/Keys.sol. Domains are generated from the contracts'
// golden vectors (never hand-typed); tests check every function against those vectors.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex, PrincipalId, RecordId, SubjectId, TypeId } from "../core/hex.js";
import { DOMAINS } from "../generated/domains.js";

const W = { type: "bytes32" } as const;
const U = { type: "uint256" } as const;
const enc = (types: readonly { type: string }[], values: readonly unknown[]): Hex =>
  encodeAbiParameters(types as never, values as never);
const k = (types: readonly { type: string }[], values: readonly unknown[]): Hex =>
  keccak256(enc(types, values));

/** Key principal: the left-padded address. Applies to EOAs and to exact 23-byte EIP-7702 delegation designators. */
export function keyPrincipal(account: Address): PrincipalId {
  return `0x${"0".repeat(24)}${account.slice(2).toLowerCase()}` as PrincipalId;
}
/** Contract principal: depends on the Realm origin, so the same contract is a different author in another Realm. */
export function contractPrincipal(realmOrigin: Hex, account: Address): PrincipalId {
  return k(
    [W, U, W, { type: "address" }],
    [DOMAINS.principal, 2n, realmOrigin, account],
  ) as PrincipalId;
}
export function realmOrigin(genesisChainId: bigint, core: Address, realmSalt: Hex): Hex {
  return k(
    [W, { type: "uint64" }, { type: "address" }, W],
    [DOMAINS.realmOrigin, genesisChainId, core, realmSalt],
  );
}
export function realmId(origin: Hex, genesisExecutionProfileId: number): Hex {
  return k([W, W, { type: "uint16" }], [DOMAINS.realm, origin, genesisExecutionProfileId]);
}
export function publicationId(principal: PrincipalId, intentDigest: Hex): Hex {
  return k([W, W, W], [DOMAINS.publication, principal, intentDigest]);
}
export function roleKey(purpose: Hex, role: Hex): Hex {
  return k([W, W, W], [DOMAINS.roleKey, purpose, role]);
}
export function shape(descriptor: Hex): Hex {
  return k([W, { type: "bytes" }], [DOMAINS.describedShape, descriptor]);
}
export function typeId(shape_: Hex, refTypes: readonly Hex[], ruleId: Hex): TypeId {
  const refs = keccak256(enc([{ type: "bytes32[]" }], [refTypes]));
  return k([W, W, W, W], [DOMAINS.type, shape_, refs, ruleId]) as TypeId;
}
export function recordId(type: TypeId | Hex, body: Hex | Uint8Array): RecordId {
  return recordFromHash(type, keccak256(body));
}
export function recordFromHash(type: TypeId | Hex, bodyHash: Hex): RecordId {
  return k([W, W, W], [DOMAINS.record, type, bodyHash]) as RecordId;
}
export function subjectId(creator: PrincipalId, salt: Hex): SubjectId {
  return k([W, W, W], [DOMAINS.subject, creator, salt]) as SubjectId;
}
export function positionKey(purpose: Hex, subject: Hex, role: Hex): Hex {
  return k([W, W, W, W], [DOMAINS.position, purpose, subject, role]);
}
export function bindingKey(principal: PrincipalId, position: Hex): Hex {
  return k([W, W, W], [DOMAINS.binding, principal, position]);
}
export function scopeKey(principal: PrincipalId, purpose: Hex, subject: Hex): Hex {
  return k([W, W, W, W], [DOMAINS.scope, principal, purpose, subject]);
}
export function roleScopeKey(principal: PrincipalId, purpose: Hex, role: Hex): Hex {
  return k([W, W, W, W], [DOMAINS.roleScope, principal, purpose, role]);
}

/** Posting-list kinds (Keys.sol). 2, 3, 6, 7, 9 are reserved. */
export const POSTING_KIND = {
  byType: 1,
  byAuthor: 4,
  backlink: 5,
  history: 8,
  scope: 10,
  referencePosition: 11,
  byRecord: 12,
  uniqueByType: 13,
  scalar: 14,
  digest: 15,
} as const;

const ZERO: Hex = `0x${"0".repeat(64)}`;
export function postingKey(type: Hex, kind: number, ordinal: number, valueKey: Hex): Hex {
  return k([W, W, U, U, W], [DOMAINS.posting, type, BigInt(kind), BigInt(ordinal), valueKey]);
}
export const lists = {
  byType: (type: Hex): Hex => postingKey(type, POSTING_KIND.byType, 0, ZERO),
  byAuthor: (principal: PrincipalId): Hex => postingKey(ZERO, POSTING_KIND.byAuthor, 0, principal),
  backlink: (target: Hex): Hex => postingKey(ZERO, POSTING_KIND.backlink, 0, target),
  history: (binding: Hex): Hex => postingKey(ZERO, POSTING_KIND.history, 0, binding),
  scope: (scope: Hex): Hex => postingKey(ZERO, POSTING_KIND.scope, 0, scope),
  reference: (sourceType: Hex, ordinal: number, target: Hex): Hex =>
    postingKey(sourceType, POSTING_KIND.referencePosition, ordinal, target),
  byRecord: (record: Hex): Hex => postingKey(ZERO, POSTING_KIND.byRecord, 0, record),
  uniqueByType: (type: Hex): Hex => postingKey(type, POSTING_KIND.uniqueByType, 0, ZERO),
  scalar: (type: Hex, spec: number, kind: number, value: Hex): Hex =>
    postingKey(type, POSTING_KIND.scalar, spec, k([{ type: "uint8" }, W], [kind, value])),
  digest: (algorithm: Hex, value: Hex): Hex =>
    postingKey(ZERO, POSTING_KIND.digest, 0, k([W, W], [algorithm, value])),
} as const;

/** The native-lane retry key (design §5.8). The ledger answers AlreadyAdmitted for the same digest and nonce. */
export function nativeIntentDigest(input: {
  realmId: Hex;
  principal: PrincipalId;
  nonce: bigint;
  deadline: bigint;
  expectedExecutionSet: Hex;
  expectedAcceptanceProfile: Hex;
  guardHash: Hex;
  actionsHash: Hex;
}): Hex {
  return k(
    [W, W, W, { type: "uint64" }, { type: "uint64" }, W, W, W, W],
    [
      DOMAINS.nativeIntent,
      input.realmId,
      input.principal,
      input.nonce,
      input.deadline,
      input.expectedExecutionSet,
      input.expectedAcceptanceProfile,
      input.guardHash,
      input.actionsHash,
    ],
  );
}
