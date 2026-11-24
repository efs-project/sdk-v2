// SPDX-License-Identifier: MIT
// The deployment document (efs-deployment/1) an app is configured with. Validated structurally before use; the
// pin then checks it against the chain. Type ids, addresses and limits are always read from here, never hardcoded.
import {
  type Address,
  type Hex,
  isAddress,
  isWord,
  lower,
  type PrincipalId,
  type RecordId,
  type SubjectId,
} from "../core/hex.js";

export interface ProtocolLimits {
  maxInlineBytes: number;
  maxActionsPerPublication: number;
  maxBodyBytes: number;
  maxBodyBytesPerPublication: number;
  maxBindsPerPublication: number;
  spanChunkBytes: number;
  maxLensPrincipals: number;
}

export interface DeploymentInfo {
  chainId: number;
  realmId: Hex;
  realmOrigin: Hex;
  layoutId: Hex;
  releaseDigest: Hex | null;
  ledger: Address;
  ledgerImplementation: Address;
  readers: {
    ledgerReads: Address;
    ledgerViews: Address;
    lens: Address;
    filesPage: Address;
    keysView: Address | null;
  };
  /** Expected runtime code hashes, by unit, as recorded when the deployment was made. */
  codehashes: {
    ledgerImplementation: Hex;
    ledgerReads: Hex;
    ledgerViews: Hex;
    lens: Hex;
    filesPage: Hex;
  };
  root: { directoryRecordId: RecordId; subjectId: SubjectId; principalId: PrincipalId };
  defaultLens: readonly PrincipalId[];
  typeIds: Readonly<Record<string, Hex>>;
  limits: ProtocolLimits;
  /** The execution set the document was written at. The pin reports the live one. */
  executionSet: Hex;
  revision: number;
}

export type ManifestCheck =
  | { ok: true; deployment: DeploymentInfo }
  | { ok: false; problems: readonly string[] };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;

/** The chunk payload size of canonical chunking (efs2/chunking/1): 8,192-byte bodies minus the 32-byte sha256. */
const SPAN_CHUNK_BYTES = 8160;
/** Bytes a files-root/1 inline body spends before the file bytes (abi.encode(file, form)). */
const ROOT_HEADER_BYTES = 64;

/** Validate an efs-deployment/1 document. Pure; no network. */
export function validateDeploymentManifest(input: unknown): ManifestCheck {
  const problems: string[] = [];
  const d = obj(input);
  if (!d) return { ok: false, problems: ["the deployment document is not an object"] };
  if (d["schema"] !== "efs-deployment/1")
    problems.push(`unsupported schema ${String(d["schema"])}`);
  const word = (path: string, v: unknown): Hex => {
    if (!isWord(v)) problems.push(`${path} must be a 32-byte hex word`);
    return (isWord(v) ? lower(v) : "0x") as Hex;
  };
  const addr = (path: string, v: unknown): Address => {
    if (!isAddress(v)) problems.push(`${path} must be an address`);
    return (isAddress(v) ? lower(v) : "0x") as Address;
  };
  const num = (path: string, v: unknown): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      problems.push(`${path} must be a non-negative integer`);
    return typeof v === "number" ? v : 0;
  };
  const readers = obj(d["readers"]) ?? {};
  const lens = obj(readers["lensReader"]) ?? {};
  const files = obj(readers["filesPageReader"]) ?? {};
  const contracts = obj(d["contracts"]) ?? {};
  const unit = (name: string): Obj => obj(contracts[name]) ?? {};
  const proxy = obj(obj(d["proxies"])?.["ledger"]) ?? {};
  const root = obj(d["root"]) ?? {};
  const limits = obj(d["limits"]) ?? {};
  const activation = obj(d["activation"]) ?? {};
  const typeIds = obj(d["typeIds"]) ?? {};
  const typeIdOut: Record<string, Hex> = {};
  for (const [k, v] of Object.entries(typeIds)) typeIdOut[k] = word(`typeIds.${k}`, v);
  const defaultLens = Array.isArray(d["defaultLensPrincipals"])
    ? (d["defaultLensPrincipals"] as unknown[])
    : [];
  const maxBody = num("limits.maxBody", limits["maxBody"]);
  const deployment: DeploymentInfo = {
    chainId: num("chainId", d["chainId"]),
    realmId: word("realmId", d["realmId"]),
    realmOrigin: word("realmOrigin", d["realmOrigin"]),
    layoutId: word("layoutId", d["layoutId"]),
    releaseDigest: isWord(d["releaseDigest"]) ? lower(d["releaseDigest"] as Hex) : null,
    ledger: addr("ledger", d["ledger"]),
    ledgerImplementation: addr("proxies.ledger.implementation", proxy["implementation"]),
    readers: {
      ledgerReads: addr("readers.ledgerReads", readers["ledgerReads"]),
      ledgerViews: addr("readers.ledgerViews", readers["ledgerViews"]),
      lens: addr("readers.lensReader.address", lens["address"]),
      filesPage: addr("readers.filesPageReader.address", files["address"]),
      keysView: isAddress(readers["keysView"]) ? lower(readers["keysView"] as Address) : null,
    },
    codehashes: {
      ledgerImplementation: word(
        "contracts.LedgerCore.runtimeCodehash",
        unit("LedgerCore")["runtimeCodehash"],
      ),
      ledgerReads: word(
        "contracts.LedgerReads.runtimeCodehash",
        unit("LedgerReads")["runtimeCodehash"],
      ),
      ledgerViews: word(
        "contracts.LedgerViews.runtimeCodehash",
        unit("LedgerViews")["runtimeCodehash"],
      ),
      lens: word("readers.lensReader.runtimeCodehash", lens["runtimeCodehash"]),
      filesPage: word("readers.filesPageReader.runtimeCodehash", files["runtimeCodehash"]),
    },
    root: {
      directoryRecordId: word("root.directoryRecordId", root["directoryRecordId"]) as RecordId,
      subjectId: word("root.subjectId", root["subjectId"]) as SubjectId,
      principalId: word("root.principalId", root["principalId"]) as PrincipalId,
    },
    defaultLens: defaultLens.map((p, i) => word(`defaultLensPrincipals[${i}]`, p) as PrincipalId),
    typeIds: typeIdOut,
    limits: {
      maxInlineBytes: Math.max(0, maxBody - ROOT_HEADER_BYTES),
      maxActionsPerPublication: num("limits.maxActions", limits["maxActions"]),
      maxBodyBytes: maxBody,
      maxBodyBytesPerPublication: num(
        "limits.maxBodyBytesPerPublication",
        limits["maxBodyBytesPerPublication"],
      ),
      maxBindsPerPublication: num(
        "limits.maxBindsPerPublication",
        limits["maxBindsPerPublication"],
      ),
      spanChunkBytes: SPAN_CHUNK_BYTES,
      maxLensPrincipals: 64,
    },
    executionSet: word("activation.executionSet", activation["executionSet"]),
    revision: num("activation.revision", activation["revision"]),
  };
  if (
    deployment.ledgerImplementation !== "0x" &&
    proxy["address"] !== undefined &&
    lower(String(proxy["address"]) as Hex) !== deployment.ledger
  ) {
    problems.push("proxies.ledger.address differs from ledger");
  }
  return problems.length ? { ok: false, problems } : { ok: true, deployment };
}
