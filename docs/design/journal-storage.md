# Attempt journal storage (`efs-sdk-attempt/1`)

Status: stable for EFS SDK 0.1. `@efs/sdk/web` stays guest-safe (no storage, no write capability), which is why the
browser journal has its own subpath. Apps consume the journals through the exports below. The on-disk shapes are
documented so apps can avoid colliding with them and can inspect them while debugging. Only the SDK writes them.

## Exports

| Import | Export | Notes |
| --- | --- | --- |
| `@efs/sdk/actions` | `Journal`, `AttemptRecord`, `AttemptStage`, `WithLock` (types) | the port every journal implements |
| `@efs/sdk/actions` | `memoryJournal()` | not durable (`durable: false`); for tests only |
| `@efs/sdk/actions` | `localLocks()`, `lockKey(plan)`, `isResolved(stage)` | building blocks for custom journals |
| `@efs/sdk/actions` | `encodeJournalRecord(record)`, `decodeJournalRecord(text)` | the storage form below; decode checks the schema |
| `@efs/sdk/web/journal` | `indexedDbJournal({ name? })` → `WebJournal` | pages and workers; `crossContext`, `close()` |
| `@efs/sdk/web/journal` | `IndexedDbJournalOptions`, `WebJournal` (types) | |
| `@efs/sdk/node` | `fileJournal(dir, { staleLockMs?, pollMs? })` → `Journal` | `node` export condition only |
| `@efs/sdk/node` | `FileJournalOptions` (type) | |

Pass a journal to `createWriter(efs, { authorizer, journal })`. On start, `writer.pending()` lists the attempts that
still need `writer.reconcile(planId)`.

## The record

One record per plan, replaced on every stage change. It is serialized with `encodeJournalRecord` (the same tagged
JSON as `toJson` from `@efs/sdk`): a bigint is
`{"$efs:bigint":"<decimal>"}` and bytes are `{"$efs:bytes":"<hex>"}`.

```ts
interface AttemptRecord {
  schema: "efs-sdk-attempt/1";
  planId: Hex;                // lowercase 0x + 64 hex
  plan: Plan;                 // the full plan: chain, realm, ledger, account, nonce, deadline, actions, calldata, basis
  stage: "PLANNED" | "SUBMISSION_POSSIBLE" | "SUBMITTED" | "NOT_SENT" | "COMMITTED" | "NOT_COMMITTED_PROVEN";
  txHash?: Hex;
  publication?: bigint;       // set at COMMITTED
  final?: boolean;            // on COMMITTED: false until the admission is at a finalized block (absent: final)
  history: { stage: AttemptStage; at: number /* ms epoch */; detail?: string }[];
  extensions?: Record<string, unknown>; // fields from newer SDKs, preserved on rewrite
}
```

An attempt is settled when it is `NOT_SENT`, `NOT_COMMITTED_PROVEN`, or `COMMITTED` at a finalized block
(`isSettled`); every other attempt is pending, a `COMMITTED` with `final: false` included, so reconcile keeps
re-checking it. If a reorg drops it, it goes back to `SUBMISSION_POSSIBLE` with "reorged out" in its history.
`SUBMISSION_POSSIBLE` is written before any call that might broadcast. An attempt in that stage is never sent again,
only reconciled.

The lock key is `efs:<chainId>:<realmId>:<ledger>:<account>`, all lowercase, from `lockKey(plan)`.

## The sequence record (`efs-sdk-sequence/1`)

A save split into several publications (`writer.runSequence`) is one record, replaced whenever a part moves:

```ts
interface SequenceRecord {
  schema: "efs-sdk-sequence/1";
  sequenceId: Hex;
  lock: string;               // the account's lock key
  chainId: number; realmId: Hex; ledger: Address; account: Address;
  parts: { actions, bodies, effects, planId?: Hex, committed?: boolean, publication?: bigint }[];
  partsHash?: Hex;            // keccak256 of the parts' content as the SDK last set them (0.1; absent before)
  state: "NOT_STARTED" | "IN_FLIGHT" | "PARTIAL" | "COMPLETE" | "ABANDONED";
  batchMax?: number;          // most parts per wallet request, lowered after a failed batch (1: part by part)
  history: { state, at, detail? }[];
  extensions?: Record<string, unknown>;
}
```

A part's `planId` is set only while it is planned or in flight, and each part's attempt record is the exactly-once
authority. COMPLETE and ABANDONED are closed, so `openSequences` never returns them.

`partsHash` covers each part's actions, bodies, effects, units, gas figures, split depth and deadline window (never the
per-attempt fields), set at `runSequence` and at a re-split. Resume refuses parts that don't hash to it (RECORD_DAMAGED,
nothing sent); a record without it (written before 0.1) resumes as before. It detects a corrupted or version-skewed
record; it is no secret, so it can't stop a party who can write the journal.

## Browser and worker storage (`indexedDbJournal`)

| Thing | Value |
| --- | --- |
| IndexedDB database | `efs-sdk-journal` by default (`name` option), version **2** |
| Object store | `attempts`, keyPath `planId`, index `lock` (not unique) |
| Row | `{ planId: string, lock: string, stage: string, json: string }`; `json` is the record's storage form |
| Object store (v2) | `sequences`, keyPath `sequenceId`, index `lock` (not unique) |
| Row (v2) | `{ sequenceId: string, lock: string, state: string, json: string }`; `json` is `encodeSequenceRecord` |
| Upgrade 1 → 2 | adds `sequences`; `attempts` and every record in it are untouched. A v1 database read by v2 code (without a write) is not upgraded, and its sequences read as empty. The first sequence write upgrades it. |
| Transactions | `durability: "strict"`; `put` resolves only after the transaction completes |
| Web Lock name | the lock key itself (`efs:…`). Locks are per origin, so they cover every tab and worker |

Nothing is written until a submission: creating the journal, `get`, `unresolved` (so `writer.pending()`) and
`withLock` never create the database. Reads open it without a version and abort the creating upgrade, so on a fresh
origin they return nothing and leave `indexedDB.databases()` unchanged. The first `put` creates it, and `put` runs
only as the write-ahead of a real send. A reader that found nothing still sees a database created later by another
tab.

Apps keep their own data in **their own database**, under a name that does not start with `efs-sdk-`. Apps never open
the `efs-sdk-journal` database themselves. An app's Web Lock names do not start with `efs:`. A future SDK version
that changes this layout raises the database version and migrates. A connection open in another tab is closed on
`versionchange` and reopened at its next use.

## Node storage (`fileJournal(dir)`)

```text
<dir>/attempts/<planId>.json    one record per plan (encodeJournalRecord), written temp → fsync → rename → dir fsync
<dir>/attempts/.<planId>.json.<pid>.<random>.tmp   only while a write is in flight (ignored by readers)
<dir>/sequences/<sequenceId>.json  one record per split save (encodeSequenceRecord), written like attempts
<dir>/locks/<sha256(lockKey)[0:32]>.lock   {"pid","host","at","token"} while a send holds the lock
```

A lock file whose owner is gone is taken over. An owner is gone when the lock is on the same host and its pid no
longer exists, or when the lock is older than `staleLockMs` (default 30 minutes). A record that does not parse
raises an `EfsFault`; it is never skipped. Use a local disk, one directory per user and machine. Network filesystems
are not supported.

**The tag release (contracts 2462e54).** `ActionData.salt` is `saltOrStrength` (the vendored ABI's field name: CREATE's
salt, a BIND's or UNBIND's strength). Records written before name the field `salt`; they belong to deployments the tag
release replaced (another ledger, another Realm), so they are never sent again, and readers that only display them may
read either name.
