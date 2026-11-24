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
  history: { stage: AttemptStage; at: number /* ms epoch */; detail?: string }[];
  extensions?: Record<string, unknown>; // fields from newer SDKs, preserved on rewrite
}
```

Resolved stages are `COMMITTED`, `NOT_COMMITTED_PROVEN` and `NOT_SENT`; every other stage is pending.
`SUBMISSION_POSSIBLE` is written before any call that might broadcast. An attempt in that stage is never sent again,
only reconciled.

The lock key is `efs:<chainId>:<realmId>:<ledger>:<account>`, all lowercase, from `lockKey(plan)`.

## Browser and worker storage (`indexedDbJournal`)

| Thing | Value |
| --- | --- |
| IndexedDB database | `efs-sdk-journal` by default (`name` option), version **1** |
| Object store | `attempts`, keyPath `planId` |
| Index | `lock` on the `lock` field (not unique) |
| Row | `{ planId: string, lock: string, stage: string, json: string }`; `json` is the `toJson` record |
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
<dir>/locks/<sha256(lockKey)[0:32]>.lock   {"pid","host","at","token"} while a send holds the lock
```

A lock file whose owner is gone is taken over. An owner is gone when the lock is on the same host and its pid no
longer exists, or when the lock is older than `staleLockMs` (default 30 minutes). A record that does not parse
raises an `EfsFault`; it is never skipped. Use a local disk, one directory per user and machine. Network filesystems
are not supported.
