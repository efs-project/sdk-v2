// SPDX-License-Identifier: MIT
/**
 * EFS SDK, the guest-safe root entry: create a client, pin a deployment, check names, encode paths.
 * No network, storage or wallet code runs at import. Byte reads live in `@efs/sdk/files`; writes (later) in
 * `@efs/sdk/actions`.
 */
import { getAddress } from "viem";
import type { Address, Hex } from "./core/hex.js";

export type { ByteStore, ResultStore } from "./cache/stores.js";
export { memoryByteStore, memoryResultStore } from "./cache/stores.js";
export type { Attempt, Basis, BasisPolicy } from "./chain/pool.js";
export type { Eip1193Like, FetchLike, RequestEvent, RpcEndpoint } from "./chain/rpc.js";
export type { Capabilities, Efs, EfsConfig, GatewayConfig, Lens, LensTools } from "./client.js";
export { createEfs } from "./client.js";
export type { AbortSignalLike, CallOpts, FaultCode, Reason, ReasonCode } from "./core/errors.js";
export { EfsFault } from "./core/errors.js";
export type { Address, Hex, PrincipalId, RecordId, SubjectId, TypeId } from "./core/hex.js";
export { fromJson, toJson } from "./core/json.js";
export type { DeploymentInfo, ManifestCheck, ProtocolLimits } from "./deployment/manifest.js";
export { validateDeploymentManifest } from "./deployment/manifest.js";
export type { Evidence, LiveDeployment, PinMismatch, PinResult } from "./deployment/pin.js";
export { PROTOCOL_INPUTS } from "./generated/inputs.js";
export type {
  LinkParse,
  LinkRule,
  LinkTarget,
  ObjectLink,
  RealmRef,
  RealmRule,
  RealmSplit,
  RevisionLink,
} from "./names/links.js";
export {
  formatRealm,
  LINK_PREFIX,
  link,
  MAX_LINK_LENS,
  parseLink,
  splitRealm,
} from "./names/links.js";
export type { NameCheck, NameInput, NameRule } from "./names/name.js";
export { checkName, MAX_NAME_BYTES, NAME_PROFILE, normalizeName } from "./names/name.js";
export type { SegmentParse } from "./names/segment.js";
export { displaySegment, parseSegment, wireSegment } from "./names/segment.js";

/** EIP-55 checksum form of an address (for display). */
export function checksumAddress(address: Hex): Address {
  return getAddress(address) as Address;
}
