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

/**
 * The kernel's index floor, as the deployment records it (index.workModel and the floor limits): before a
 * publication's callbacks the kernel reserves a prefix floor and a final reserve priced from these, and refuses
 * (E_INDEX_GAS) a call that leaves less. Planners add the gas this needs to each publication's estimate.
 */
export interface KernelFloor {
  workModel: {
    /** The quote's formula; the SDK prices formula 1 only, and plans nothing under another. */
    formulaVersion: number;
    freshPerPublication: number;
    rwPerPublication: number;
    freshPerPublishFresh: number;
    rwPerPublish: number;
    freshPerBindFresh: number;
    rwPerBind: number;
    freshPerRef: number;
    freshPerDigestSpec: number;
    computeBase: number;
    computePerAction: number;
    computePerHookEffect: number;
    finalComputeBase: number;
    finalComputePerBind: number;
  };
  floorFreshGas: number;
  floorRewriteGas: number;
  kernelTail: number;
  /** A record's references, at most (a Type the SDK has no count for is priced at this). */
  maxRefs: number;
  /** References and digest specs per Type id (lowercase): what the kernel's quote charges per record. */
  types: Readonly<Record<string, { refs: number; specs: number }>>;
}

/**
 * Each Type's reference count, by name: fixed by the Type's described shape, as the contracts' gas model lists it
 * (gas/model.json floor.types). The tag-release bundle carries the table itself; until then it is this one.
 */
const TYPE_REFS: Readonly<Record<string, number>> = {
  "directory-alias/1": 0,
  "files-bytes/1": 0,
  "files-child/1": 1,
  "files-content/1": 1,
  "files-directory/1": 0,
  "files-external/1": 1,
  "files-name/2": 0,
  "files-root/1": 0,
  "files-span/1": 2,
  "realm-notice/1": 0,
  "text/1": 0,
};
const WORK_MODEL_KEYS = [
  "formulaVersion",
  "freshPerPublication",
  "rwPerPublication",
  "freshPerPublishFresh",
  "rwPerPublish",
  "freshPerBindFresh",
  "rwPerBind",
  "freshPerRef",
  "freshPerDigestSpec",
  "computeBase",
  "computePerAction",
  "computePerHookEffect",
  "finalComputeBase",
  "finalComputePerBind",
] as const;

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
  /** The Realm's shared root folder: its files-directory/1 record and the principal that created it. */
  root: { directoryRecordId: RecordId; principalId: PrincipalId };
  /**
   * The index families the SDK reads, as the deployment recorded them (the live generation's address is read from
   * the ledger at each basis). `backlinkFamily`: bindings by target (kind 5, universe TARGET), null when absent.
   */
  index: {
    address: Address | null;
    backlinkFamily: Hex | null;
    /** The kind-10 scope lists (universe SCOPE): a principal's positions under one subject, in first-bind order. */
    scopeFamily: Hex | null;
    /** The generation's bitmap store, which holds the scope lists. */
    bitmapStore: Address | null;
  };
  defaultLens: readonly PrincipalId[];
  typeIds: Readonly<Record<string, Hex>>;
  limits: ProtocolLimits;
  /** The kernel's index floor; null for a document that records no work model (plans then omit the floor). */
  kernelFloor: KernelFloor | null;
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
/**
 * The kernel floor from index.workModel, the floor limits and index.digestSpecs; null when the document has no work
 * model. A work model that is present but malformed is a problem, never a silent null.
 */
function kernelFloorOf(
  index: Record<string, unknown>,
  limits: Record<string, unknown>,
  typeIds: Readonly<Record<string, Hex>>,
  problems: string[],
): KernelFloor | null {
  const wm = index["workModel"];
  if (wm === undefined) return null;
  const nat = (path: string, v: unknown): number => {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
    problems.push(`${path} must be a non-negative integer`);
    return 0;
  };
  const w = (wm ?? {}) as Record<string, unknown>;
  const workModel = Object.fromEntries(
    WORK_MODEL_KEYS.map((k) => [k, nat(`index.workModel.${k}`, w[k])]),
  ) as KernelFloor["workModel"];
  const specs = new Map<string, number>();
  const list = Array.isArray(index["digestSpecs"]) ? (index["digestSpecs"] as unknown[]) : [];
  for (const sp of list) {
    const t = (sp as Record<string, unknown> | null)?.["typeId"];
    if (typeof t === "string") specs.set(t.toLowerCase(), (specs.get(t.toLowerCase()) ?? 0) + 1);
  }
  const maxRefs = nat("limits.maxRefs", limits["maxRefs"]);
  const types: Record<string, { refs: number; specs: number }> = {};
  for (const [name, id] of Object.entries(typeIds))
    types[id.toLowerCase()] = {
      refs: TYPE_REFS[name] ?? maxRefs,
      specs: specs.get(id.toLowerCase()) ?? 0,
    };
  return {
    workModel,
    floorFreshGas: nat("limits.floorFreshGas", limits["floorFreshGas"]),
    floorRewriteGas: nat("limits.floorRewriteGas", limits["floorRewriteGas"]),
    kernelTail: nat("limits.kernelTail", limits["kernelTail"]),
    maxRefs,
    types,
  };
}

/** The id of the family of `kind` over `universe` in the document's index, or null when it names none. */
function familyOf(index: Record<string, unknown>, kind: number, universe: number): Hex | null {
  const families = index["families"];
  if (!Array.isArray(families)) return null;
  for (const f of families) {
    const o = obj(f);
    const id = o?.["familyId"];
    if (
      o?.["kind"] === kind &&
      o["universe"] === universe &&
      typeof id === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(id)
    )
      return id.toLowerCase() as Hex;
  }
  return null;
}

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
  const indexDoc = obj(d["index"]) ?? {};
  const indexStores = obj(indexDoc["stores"]) ?? {};
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
      principalId: word("root.principalId", root["principalId"]) as PrincipalId,
    },
    index: {
      address: isAddress(indexDoc["address"])
        ? (lower(indexDoc["address"] as Address) as Address)
        : null,
      backlinkFamily: familyOf(indexDoc, 5, 4),
      scopeFamily: familyOf(indexDoc, 10, 3),
      bitmapStore: isAddress(indexStores["bitmap"])
        ? (lower(indexStores["bitmap"] as Address) as Address)
        : null,
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
    kernelFloor: kernelFloorOf(indexDoc, limits, typeIdOut, problems),
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
