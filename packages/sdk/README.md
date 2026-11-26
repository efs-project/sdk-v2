# @efs/sdk

The TypeScript SDK for EFS: portable ESM for browsers, Workers, Node servers and scripts.

**Status: EFS SDK 0.1 in development.** The package is `private` and has never been published. It pins
deployments, reads and streams verified files, lists and edits folders and homes, tags, labels and names topics,
and writes exactly once through a durable journal. The API is documented in
[`docs/design/api-0.1.md`](../../docs/design/api-0.1.md) (its appendix lists every export) and
[`docs/design/tags-0.1.md`](../../docs/design/tags-0.1.md); what is missing is listed in
[`LIMITATIONS.md`](../../LIMITATIONS.md).

## Quick start

New here? [`examples/getting-started`](../../examples/getting-started/README.md) walks through pinning, reading, editing
and recovering, with the copy rule for every outcome. CI runs it against a local chain.

```ts
import { createEfs } from "@efs/sdk";
import { openFile, readBytes } from "@efs/sdk/files";

// The app fetches its deployment document (efs-deployment/1); the SDK does no I/O at creation.
const efs = createEfs({ rpcs: ["https://rpc.example"], deployment });

const pin = await efs.pin(); // VERIFIED, MISMATCH or UNKNOWN: the live contracts checked against the document
const opened = await openFile(efs, { kind: "file", subject }); // PRESENT, ABSENT_PROVEN, UNKNOWN, …
if (opened.status === "PRESENT") {
  const r = await readBytes(efs, opened.file); // bytes only when grade is VERIFIED
}
```

Every result is plain data with a status. Bytes are handed back only after they are verified against their
content-addressed id or the file's sha256. The SDK throws only for misuse, the caller's abort, an unavailable
journal, a stream that cannot continue, or an internal invariant.

### Publisher https:// locations are off by default

A file stored outside the chain may list a publisher's `https://` location. That server is chosen by the file's
author and sees the reader's IP address, so the SDK does not fetch it unless the app allows it. A blocked read is
`POLICY_BLOCKED`. Its `blockedOrigins` names the origins, and its `reason` names the exact option that would
allow each one. IPFS and Arweave locations go through the configured gateways and are allowed by default.

```ts
// Always (an app setting): allow https locations for this client.
const efs = createEfs({ rpcs, deployment, gateways: { allowSchemes: ["https", "ipfs", "ar", "data"] } });

// Once ("Load from files.example.org"): allow one exact origin for one call. No redirect may leave that origin.
await readBytes(efs, opened.file, { allowOrigins: ["https://files.example.org"] });
```

Edit a file you opened (one wallet approval in the common case; never a silent overwrite):

```ts
import { createWriter } from "@efs/sdk/actions";
import { planEditFile } from "@efs/sdk/files";
import { indexedDbJournal } from "@efs/sdk/web/journal";

const writer = await createWriter(efs, {
  authorizer: { kind: "eip1193", profile: "direct", provider: window.ethereum },
  journal: indexedDbJournal(),
});
const lens = efs.lens.mineFirst(writer.account);
const edit = await planEditFile(efs, writer, {
  file: { kind: "file", subject: opened.file.file },
  base: { kind: "revision", recordId: opened.file.revision },
  content: new TextEncoder().encode("new text\n"),
  lens,
});
if (edit.status === "BASE_CHANGED") {
  // "This file changed since you opened it": show edit.head, then plan again from it
} else if (edit.status === "PLANNED") {
  const saved = await writer.runSequence(edit.parts); // COMPLETE, or PARTIAL / IN_FLIGHT to resume later
}
```

### Outcomes every app handles

- **A read never comes from before your last save.** Each client keeps a read floor (the highest block it has
  read; a save's block counts, and a reload or another tab gets it from the journal). An endpoint behind it is
  skipped; when every endpoint is behind, the read is UNKNOWN with reason `BEHIND` after a short wait: "This network
  hasn't caught up with your last save yet. Checking…", then Retry. Never show it as empty. Pass `atLeast` for a
  block this client can't know about (a worker, a link).
- **The same save is never sent twice.** Saving parts that are already on their way, or saved and not yet final,
  sends nothing: `NOT_SENT` (a save: `NOT_STARTED`) with reason `ALREADY_ATTEMPTED` and `reason.twin`, which names
  the earlier save. Show its progress instead. A lost wallet answer is `IN_FLIGHT`, never "not sent":
  `reconcileSequence` settles it from the ledger.
- **A wallet short of funds is named.** An account that can't cover the gas limit is `AMBIGUOUS` (a save stops
  `IN_FLIGHT`) with reason `INSUFFICIENT_FUNDS` and, for a single send, `reason.funds.gasLimit`: "Your wallet needs
  enough to cover the gas limit of N; a save is charged only the gas it uses." Once the account is topped up, "Send
  again" (`resume`, or `send` of the same plan) sends the same plan again, so it can't land twice; if the wallet had
  queued the original and it landed, nothing more is sent. With under a minute left before the plan's deadline, it
  waits for reconcile instead. A wallet that just disables its confirm button gives a plain `USER_REJECTED`.
- **What people type is folded, and some words wait.** Tag words go through `foldWord` (interim, until the tag text
  rule is chosen): an all-ASCII word is trimmed, its spaces become underscores, and A–Z become a–z ("Notes" saves as
  `notes`: say so). Adding a tag refuses a word with a non-ASCII character a candidate rule would change (MISUSE,
  `details.rule: "unstable-until-ruled"`): "can't be used until the tag text rule is chosen". `checkStableWord` lets
  a field say it as the person types.
- **Words and names keep links working.** Of ASCII, a tag word holds only a–z, 0–9, `-`, `_` and `.` after the fold
  (letters of other scripts and emoji are judged by the word rules, not refused as ASCII), never ends with `.` and
  never starts with `-` (`checkWord` gives the chain's code: "c++" is code 3, "inc." 4, "-x" 9). A
  file or folder name can't use `# ? % / \ < > " | : * ;` or end with `.` (`checkName`: `reserved-character`,
  `trailing-dot`): "A name can't use # ? % / \ < > " | : * ; or end with a dot." Inner spaces, `& ( ) ! @ ~` and
  the like are fine.
- **UNKNOWN is never absence.** Only `ABSENT_PROVEN` means "not there"; a failed or unvouched read is UNKNOWN with a
  reason and a `retry` class.

## Entry points

| Import | For |
| --- | --- |
| `@efs/sdk` | `createEfs`, pinning, names, links, ids, `principalDisplay` (and `efs.lens.displayOf`), the JSON codec, memory caches |
| `@efs/sdk/links` | the route and link grammar alone, with no runtime dependencies (for startup routers) |
| `@efs/sdk/files` | `openFile`, `readBytes`, `readRange`, `fileChunks`, `unverifiedChunks`, `planEditFile`, `fileVersions` (everyone's versions of a file); folders and homes (an address as a parent): `listFolder`, `lookupEntry`, `resolvePath`, `openObject`, `openPath`, `openHome`, `listRemoved`, and the planners `planCreateFile`, `planCreateFolder`, `planMoveEntries`, `planRemoveEntries`, `planRestoreEntries`, `planHideEntries`, `planUnhideEntries` |
| `@efs/sdk/actions` | `createWriter`: plan, review, send and reconcile writes, exactly once |
| `@efs/sdk/tags` | topics, tags and homes: `planTag`, `planDeny`, `planUntag`, `planLabel`, `planSame`, `planBroader`, `topicItems`, `tagsOf`, `topicChildren`, `wordPage`, `labelOf`, `topicName`, `fileNames`, `topicSynonyms`, `topicBroader`, `lensTagsOf` |
| `@efs/sdk/web` | `streamFile` / `streamUnverified` (ReadableStream) |
| `@efs/sdk/web/journal` | `indexedDbJournal`, the durable write journal for pages and workers |
| `@efs/sdk/web/cache` | `indexedDbByteStore`, an opt-in persistent cache of verified bytes |
| `@efs/sdk/node` | `fileJournal` (Node only) |
| `@efs/sdk/testing` | RPC transcript replay for chain-free tests; `planLoneHide` and `planOtherEntry` for fixture tests (development only) |
| `@efs/sdk/fixtures/*.json` | recorded results and RPC transcripts from a real fixture chain |

License: MIT.
