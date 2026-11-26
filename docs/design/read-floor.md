# Read floor: read-your-writes across endpoints (PROPOSAL, 2026-11-26)

**Status: accepted 2026-11-26 and built.** The PM and the client decided D1 (4 s), D2 (no time-based reset), D3
(per-policy floors), D4 (the journal raises the floor, keyed by chain identity) and D5 (`blockHash` optional). The
API is in api-0.1 §2, "The read floor". Not needed for the local MVP (one anvil endpoint never lags), so it is kept
small.

**Changed while building (D4's condition):** the journal's floors are keyed by chain identity.
- A record carries the chain's genesis hash, read once per client at the first commit: one request on the save path.
- A floor from the journal binds only when its genesis matches the current chain's. That is checked only when the
  floor would hold a read back.
- A fresh anvil has a new genesis: its genesis timestamp is the start time (measured with the fixture's flags). So a
  reset local chain ignores old saves.

## The problem

After a save commits, a re-read can be served by an endpoint that is behind, at a block from before the save, and
the new tag quietly isn't there. This is the "confirms but unreadable" shape one step removed: the write is fine and
the read is honest about its block, but nothing says that block is older than one the app has already seen. Today:

- `efs.at` takes only `latest`, `safe` or `finalized`, and each read takes whatever block the first healthy
  endpoint calls its head;
- the pool has no "never older than already seen" guard;
- `SequenceProgress` at COMPLETE does not say at which block its parts were seen committed.

Within one read nothing changes: every call is already pinned to the pin's block hash (EIP-1898,
`requireCanonical`), and an endpoint that does not have that block fails over. The gap is between reads.

## Where it goes

Every read and every plan pins through `efs.at` (`pinDeployment`): 29 call sites, one choke point. The floor is
checked there, on the block the pin already fetches, before the pin's describe and code-hash calls. The byte cache
is content-addressed (immutable records), so it can't serve state from before a floor.

## 1. Monotonic reads per Efs instance

- **The floor.** Each `Efs` instance keeps a floor per policy: `{ blockNumber, blockHash, endpoint }`. Every
  VERIFIED pin raises its policy's floor to the served block when that block is higher. A `latest` read must be at
  or above every floor (a head below a seen finalized block is certainly behind); `safe` must be at or above the
  safe and finalized floors; `finalized` at or above the finalized floor. Asking for `finalized` after a `latest`
  read is not a violation: the policy asked for an older block.
- **A head below the floor is BEHIND, never a quiet older read:**
  1. Fail over: that endpoint's attempt fails with BEHIND (`retryElsewhere`), and the next endpoint is asked.
     A behind endpoint costs one `eth_getBlockByNumber`, and none of the pin's other calls.
  2. If every endpoint is behind, poll for a short while (`behindWaitMs`, default 4 s, polled at 0.5, 1, 2 and
     3.5 s). A load-balanced URL whose backend lags usually answers from another backend on the next request.
  3. Then UNKNOWN with reason `BEHIND` (`retry: "transient"`), with `details: { floor, served: [{ endpoint,
     blockNumber }] }`, so the page says "the network is catching up" with a retry, not "nobody tagged this".
- **Reorgs.** The floor guards block *numbers*: "never older".
  - **Reorg at the same height:** a head at the floor's height with another hash is served, and becomes the floor.
  - **Reorg below the head:** a head above the floor is served without checking the floor's hash. If the floor's
    block was reorged out, the newer canonical state is what it should show.
  - **The one stuck case is a chain shorter than the floor.** Every endpoint is below the floor's height. On one
    endpoint this can't be told apart from lag: a load-balanced URL also appears to go backward. It happens in a
    shallow PoS reorg after a missed slot (the head is one lower for up to a slot), and on a dev chain that was reset
    or rewound (`anvil_reset`, `evm_revert`).
  - **Proposed handling of the stuck case:** UNKNOWN BEHIND, and never a time-based silent reset, because a stuck
    node would then serve old state again. A shallow reorg clears itself at the next block. For a reset chain:
    - `efs.resetReadFloor()` is the escape (dev tools, or an app's "the chain was reset" signal);
    - a new `Efs` instance (a reload) starts with no floor.
  - **Rejected alternative:** reset the floor after N seconds below it. It turns a stuck endpoint back into silent
    old reads.

## 2. Where a save was seen committed

- **Per part:** `SequencePart.committedAt?: { blockNumber, blockHash }` is the reconcile basis at which the part was
  first seen COMMITTED, recorded in the journal. It is cleared when a reorg undoes the admission (`reorged`).
  - **Why the reconcile basis:** it is at or after the inclusion block, and reconcile already has it, with no
    receipt read.
- **For the whole save:** `SequenceProgress.visibleAt?: { blockNumber, blockHash }` is the highest part
  `committedAt`, present once COMPLETE. A read at or above it sees the whole save.
- **Single sends:** `writer.run` and `reconcile` already return the basis of a COMMITTED reconcile.
- **Within one instance this is already the floor:** reconcile's pin is a `latest` pin, so rule 1 raised the floor
  when it saw the commit, and the next read can't be older. Item 2 is for the other cases: another tab, a worker, or
  a reload.
  - The journal is shared (IndexedDB), so another tab's `pendingSequences` sees `visibleAt` and can pass it as
    `atLeast`.
  - **Optional, decision D4:** `openJournal` / `pendingSequences` could raise the instance floor to the account's
    newest `visibleAt` by themselves.

## 3. An explicit `atLeast`

- `CallOpts.atLeast?: { blockNumber: bigint; blockHash?: Hex }` is passed to any read or plan. Every read already
  hands its `o` to `efs.at`, so this is one change, not 29.
- **The rule:** the pin must serve a block at or above `max(instance floor, atLeast.blockNumber)`, or BEHIND as in
  1. A served block then raises the instance floor as usual.
- **Uses:** another tab or a worker (post `efs.readFloor()` to it, or a save's `visibleAt`), and a link that carries
  a basis.
- **`blockHash`, when given:** one `eth_getBlockByNumber(atLeast.blockNumber)` on the serving endpoint, cached per
  served head.
  - **On a mismatch:** the block was reorged out. The read still returns at the head (newer and canonical), with
    `basis.reorgedSince: { blockNumber, blockHash }`. The page then reconciles the save instead of saying "it isn't
    there".
  - **Without `blockHash`:** number only, no extra call.
- **Handoff getter:** `efs.readFloor(): { latest?, safe?, finalized? }`, to post to a worker.

## 4. Cost

| Case | Extra requests per read | Notes |
| --- | --- | --- |
| Happy path (head at or above the floor) | 0 | a comparison and a max, in memory |
| One endpoint behind, another not | +1 `eth_getBlockByNumber` | the behind endpoint stops before the pin's describe and code-hash calls |
| Every endpoint behind | ≤ 4 `eth_getBlockByNumber` per endpoint, over ≤ 4 s | then UNKNOWN BEHIND |
| `atLeast` with `blockHash` | +1, once per new head | cached per served head hash |
| SequenceProgress `committedAt` / `visibleAt` | 0 | reconcile already has the basis |

- **View budgets:** the happy path is unchanged. A BEHIND read's polls count as attempts in `evidence.attempts`, as
  failovers do today, so a view's budget can see them.

**Epoch replay** (`createReplay`):
- The floor follows the recorded heads. Heads are recorded in order and only move at gates, and a repeated read in
  the same epoch gets the epoch's last head: equal to the floor, never below it. So today's transcripts replay
  unchanged: one anvil, no lag, and no extra calls on the happy path.
- The BEHIND path makes calls today's transcripts don't have. Its tests record their own, with a lagging endpoint in
  front of anvil: a fetch wrapper that answers `latest` with an older block.

**Out of scope:**
- automatic cross-tab sync (BroadcastChannel): apps pass `atLeast`;
- `eth_estimateGas` at the send, which is unpinned today and stays so;
- reconcile's finalized read, where a behind endpoint only delays `final`, conservatively.

## Tests (when built)

1. An endpoint behind, another not: the read is served by the second; no pre-floor basis appears.
2. Every endpoint behind: UNKNOWN BEHIND after the wait, with the floor and the served heads; never an older read.
3. Reconcile COMMITTED, then a read through a lagging endpoint: BEHIND or a later basis, never one from before the
   save.
4. `atLeast` from another instance (a second `Efs`), with and without `blockHash`; a reorged `blockHash` gives
   `reorgedSince`.
5. A same-height sibling is served and becomes the floor; `resetReadFloor()` after `evm_revert`.
6. Mutations: the floor check removed (1–3 fail); the floor not raised by reconcile's pin (3 fails).

## Decisions wanted

- **D1. The behind window:** `behindWaitMs` default 4 s, configurable on `createEfs`. Longer covers a missed slot
  (12 s), but holds a page that long.
- **D2. No time-based reset:** the stuck case is UNKNOWN BEHIND until `resetReadFloor()` or a reload (rejected
  alternative above).
- **D3. Per-policy floors,** with `latest` at or above all of them.
- **D4.** Whether the journal raises the floor from `visibleAt` by itself (cross-tab and reload read-your-writes for
  free), or apps pass `atLeast`.
- **D5.** Whether `atLeast.blockHash` (and `reorgedSince`) is worth its one call per head, or number only.
