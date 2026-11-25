# EFS SDK v0.1: getting started

Five steps, each in [`index.mjs`](index.mjs), which runs in CI against a local fixture chain, so this page cannot
drift from the SDK. To run it yourself, you need Foundry's `anvil` on PATH, then:

```bash
node tools/pack.mjs --only sdk,fixture && node tools/consumers.mjs --only fixture
```

Every result is data, never a guess. Show it with the rules in [`copy.mjs`](copy.mjs): **state first, then
`reason.code`, then `reason.retry`**, and never parse `reason.detail`. Say "nothing was sent" only where the SDK
proved it.

## 1. Pin the deployment

```js
const efs = createEfs({ rpcs: [rpcUrl], deployment }); // the efs-deployment document you ship
const pin = await efs.at("latest"); // VERIFIED | MISMATCH | UNKNOWN
```
Show chain data as EFS data only after VERIFIED. UNKNOWN means "can't check right now", never "not EFS".

## 2. Open and read a file

```js
const opened = await openFile(efs, { kind: "file", subject }); // PRESENT | ABSENT_PROVEN | MASKED | CONFLICT | UNKNOWN | INVALID
const read = await readBytes(efs, opened.file); // grade VERIFIED: bytes checked against their sha256
```
UNKNOWN is never "doesn't exist". Only ABSENT_PROVEN is.

## 3. Edit: plan, review, send

```js
const writer = await createWriter(efs, {
  authorizer: { kind: "eip1193", profile: "direct", provider: wallet, account }, // pass the account you show
  journal: indexedDbJournal(), // browser; fileJournal(dir) in Node
});
const edit = await planEditFile(efs, writer, { file, base: { kind: "revision", recordId: opened.file.revision }, content });
// PLANNED | BASE_CHANGED (reopen) | TOO_LARGE | UNKNOWN. Planning never calls the wallet.
edit.review; // prompts, size, gas per part, guard, visibleInLens (warn before Send when false)
const saved = await writer.runSequence(edit.parts, { onProgress }); // onProgress: advisory hints only
```

## 4. Recover

Saves outlive the page. The journal records each one before anything is sent.
- **On every start**, without a wallet: `openJournal(efs, { journal }).pendingSequences()`, then
  `reconcileSequence(id)` for each save. That settles saves that are in flight or confirming, and sends nothing.
- **Continue, Send again, Try again** call `writer.resume(id)`, and only when the person clicks. The SDK never sends
  again on its own.

## 5. What to say

| Outcome | Say | Offer |
|---|---|---|
| COMPLETE, `final: false` | Saved · confirming | — |
| COMPLETE, `final: true` | Saved | — |
| IN_FLIGHT | Sent, checking. (REORGED: undone by the network, checking. WALLET_DISCONNECTED: the wallet lost its connection, checking.) | nothing: it settles by itself |
| NOT_STARTED + USER_REJECTED | Not saved: you declined. Nothing was sent. | Try again |
| PARTIAL (k of N) + retry `transient` / `after-reconcile` | Partially saved (k of N) | Continue |
| STALE + `revert.error === "E_CAS"` | This file changed since you opened it | Review changes (plan again; abandon the old save) |
| WALLET_MISMATCH | Switch your wallet back to `reason.wallet.expected` | Continue |
| EXPIRED / REORGED_DROPPED | It didn't go through / it was undone by the network | Send again |
| A throw, `sequenceMayHaveSent === false` | Not saved. Nothing was sent. | Try again |
| A throw, otherwise | We couldn't confirm this save yet; checking | `reconcileSequence(e.sequenceId)` later |

"Nothing was sent" goes only with NOT_STARTED, for a code the SDK returns when nothing was broadcast (the list is
in `copy.mjs`). It also goes with a throw whose `sequenceMayHaveSent` is false. Everything else may have gone out,
and the ledger decides.

## 6. Folders

```js
const made = await planCreateFolder(efs, writer, { folder: parent, name: "notes", lens }); // parent: always yours to name
const page = await listFolder(efs, made.review.created, { lens }); // COMPLETE, PARTIAL (keep reading) or UNKNOWN
const object = await openObject(efs, idFromALink, { lens }); // FOLDER | FILE | ABSENT_PROVEN: route by the id itself
```
Create, rename and move (`planMoveEntries`), remove (`planRemoveEntries`: it releases, so the next author's entry at
that name shows; `hide: true` masks it) and restore (`planRestoreEntries`). Every plan is reviewed and sent with
`runSequence`, like an edit. A walkthrough CI runs on a live chain is in [`examples/folders`](../folders/README.md).

More: [`docs/design/api-0.1.md`](../../docs/design/api-0.1.md), the full API and every reason code.
