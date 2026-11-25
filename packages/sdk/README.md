# @efs/sdk

The TypeScript SDK for EFS: portable ESM for browsers, Workers, Node servers and scripts.

**Status: EFS SDK 0.1 in development.** The package is `private` and has never been published. The API is
documented in [`docs/design/api-0.1.md`](../../docs/design/api-0.1.md), and what is missing is listed in
[`LIMITATIONS.md`](../../LIMITATIONS.md). Folder, path and tag reads wait on an open data-model decision.

## Quick start

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

## Entry points

| Import | For |
| --- | --- |
| `@efs/sdk` | `createEfs`, pinning, names, links, ids, the JSON codec, memory caches |
| `@efs/sdk/links` | the route and link grammar alone, with no runtime dependencies (for startup routers) |
| `@efs/sdk/files` | `openFile`, `readBytes`, `readRange`, `fileChunks`, `unverifiedChunks`, `planEditFile` |
| `@efs/sdk/actions` | `createWriter`: plan, review, send and reconcile writes, exactly once |
| `@efs/sdk/web` | `streamFile` / `streamUnverified` (ReadableStream) |
| `@efs/sdk/web/journal` | `indexedDbJournal`, the durable write journal for pages and workers |
| `@efs/sdk/web/cache` | `indexedDbByteStore`, an opt-in persistent cache of verified bytes |
| `@efs/sdk/node` | `fileJournal` (Node only) |
| `@efs/sdk/testing` | RPC transcript replay for chain-free tests (development only) |
| `@efs/sdk/fixtures/*.json` | recorded results and RPC transcripts from a real fixture chain |

License: MIT.
