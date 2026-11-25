// SPDX-License-Identifier: MIT
// Id derivations, a TypeScript twin of contracts src/lib/Keys.sol. Domains are generated from the contracts'
// golden vectors (never hand-typed); tests check every function against those vectors.
import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { misuse } from "../core/errors.js";
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
/**
 * What a person should see for a principal (an author in a Lens, a row's `author`):
 * - address: a key principal is its account's address, EIP-55 checksummed (the padded `0x0000…` id is never shown);
 * - contract: a contract principal of this Realm, matched to an address you name (`contracts`, such as the Safe whose
 *   home you are showing) by recomputing it here: a contract principal is a hash, so it is never read back or guessed;
 * - principal: anything else, as its id (lowercase): a contract principal you didn't name, another kind, the zero word.
 * Pure: no reads. A match is true forever (the id is a hash of the Realm origin and the address), so it can be cached.
 */
export type PrincipalDisplay =
  | { kind: "address"; address: Address }
  | { kind: "contract"; address: Address }
  | { kind: "principal"; id: PrincipalId };
export function principalDisplay(
  principal: PrincipalId,
  realmOrigin: Hex,
  contracts: readonly Address[] = [],
): PrincipalDisplay {
  if (!/^0x[0-9a-fA-F]{64}$/.test(principal ?? ""))
    throw misuse("a principal is a 32-byte word (0x and 64 hex digits)");
  const p = principal.toLowerCase() as PrincipalId;
  if (/^0x0{24}/.test(p) && !/^0x0{64}$/.test(p))
    return { kind: "address", address: getAddress(`0x${p.slice(26)}`) as Address };
  for (const a of contracts)
    if (contractPrincipal(realmOrigin, a).toLowerCase() === p)
      return { kind: "contract", address: getAddress(a) as Address };
  return { kind: "principal", id: p };
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
/** The scope-below value key (index family 19): one list per (author, purpose, ancestor topic). */
export function scopeBelowKey(principal: PrincipalId, purpose: Hex, ancestor: Hex): Hex {
  return k([W, W, W, W], [DOMAINS.scopeBelow, principal, purpose, ancestor]);
}

/** Posting-list kinds (Keys.sol). */
export const POSTING_KIND = {
  byType: 1,
  byAuthor: 4,
  backlink: 5,
  place: 6,
  placeBelow: 7,
  history: 8,
  scope: 10,
  referencePosition: 11,
  byRecord: 12,
  uniqueByType: 13,
  scalar: 14,
  digest: 15,
  scopeBelow: 19,
  positionAuthors: 20,
  rolePlaces: 21,
} as const;

const ZERO: Hex = `0x${"0".repeat(64)}`;
export function postingKey(type: Hex, kind: number, ordinal: number, valueKey: Hex): Hex {
  return k([W, W, U, U, W], [DOMAINS.posting, type, BigInt(kind), BigInt(ordinal), valueKey]);
}
export const lists = {
  byType: (type: Hex): Hex => postingKey(type, POSTING_KIND.byType, 0, ZERO),
  byAuthor: (principal: PrincipalId): Hex => postingKey(ZERO, POSTING_KIND.byAuthor, 0, principal),
  /** One backlink list per (purpose, target): no read spans every kind of link (FOLDER, TAG, …). */
  backlink: (purpose: Hex, target: Hex): Hex =>
    postingKey(purpose, POSTING_KIND.backlink, 0, target),
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
  /** Every filing at a place (a topic or a home), either sign: a fresh position and each later author's first yes. */
  place: (purpose: Hex, place: Hex): Hex => postingKey(purpose, POSTING_KIND.place, 0, place),
  /** The same, for every topic below `ancestor`. */
  placeBelow: (purpose: Hex, ancestor: Hex): Hex =>
    postingKey(purpose, POSTING_KIND.placeBelow, 0, ancestor),
  /** One author's first statements on every topic below `ancestor`. */
  scopeBelow: (principal: PrincipalId, purpose: Hex, ancestor: Hex): Hex =>
    postingKey(ZERO, POSTING_KIND.scopeBelow, 0, scopeBelowKey(principal, purpose, ancestor)),
  /** Every author who ever stated anything at a position (`live`: those who say yes now). */
  positionAuthors: (position: Hex): Hex =>
    postingKey(ZERO, POSTING_KIND.positionAuthors, 0, position),
  /** Every statement about a thing, by role, wherever it was filed. */
  rolePlaces: (purpose: Hex, role: Hex): Hex =>
    postingKey(purpose, POSTING_KIND.rolePlaces, 0, role),
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
