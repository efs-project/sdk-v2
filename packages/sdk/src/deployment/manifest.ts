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

/**
 * Chain facts the deployment document records (efs-deployment.chain): a snapshot from when the instance was
 * deployed. `feeSchedule` names the gas model the SDK plans with; the per-transaction cap is always enforced.
 */
export interface ChainFacts {
  hardfork: string;
  feeSchedule: string | null;
  txGasCap: bigint;
  blockGasLimit: bigint | null;
}

export interface DeploymentInfo {
  chainId: number;
  /** Null for a document without a `chain` block: gas planning then needs an explicit model. */
  chain: ChainFacts | null;
  realmId: Hex;
  realmOrigin: Hex;
  layoutId: Hex;
  releaseDigest: Hex | null;
  ledger: Address;
  ledgerImplementation: Address;
  /** LedgerIngress: acceptanceProfileOf, indexFloor and nativeIntentDigest live here. */
  ingress: Address;
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

/** EIP-7825's per-transaction gas cap, for a `chain` block that does not state one. */
const TX_GAS_CAP_DEFAULT = 16_777_216n;
/** The chunk payload size of canonical chunking (efs/chunking/1): 8,192-byte bodies minus the 32-byte sha256. */
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
  let chain: ChainFacts | null = null;
  if (d["chain"] !== undefined) {
    const c = obj(d["chain"]);
    const gasNum = (path: string, v: unknown, required: boolean): bigint | null => {
      if (v === undefined && !required) return null;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
        problems.push(`${path} must be a positive integer`);
        return null;
      }
      return BigInt(v);
    };
    if (!c || typeof c["hardfork"] !== "string" || !c["hardfork"])
      problems.push("chain.hardfork must be a non-empty string");
    else {
      const fee = c["feeSchedule"];
      if (fee !== undefined && (typeof fee !== "string" || !fee))
        problems.push("chain.feeSchedule must be a non-empty string");
      chain = {
        hardfork: c["hardfork"] as string,
        feeSchedule: typeof fee === "string" && fee ? fee : null,
        txGasCap: gasNum("chain.txGasCap", c["txGasCap"], false) ?? TX_GAS_CAP_DEFAULT,
        blockGasLimit: gasNum("chain.blockGasLimit", c["blockGasLimit"], false),
      };
    }
  }
  const deployment: DeploymentInfo = {
    chainId: num("chainId", d["chainId"]),
    chain,
    realmId: word("realmId", d["realmId"]),
    realmOrigin: word("realmOrigin", d["realmOrigin"]),
    layoutId: word("layoutId", d["layoutId"]),
    releaseDigest: isWord(d["releaseDigest"]) ? lower(d["releaseDigest"] as Hex) : null,
    ledger: addr("ledger", d["ledger"]),
    ledgerImplementation: addr("proxies.ledger.implementation", proxy["implementation"]),
    ingress: addr("contracts.LedgerIngress.address", unit("LedgerIngress")["address"]),
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
