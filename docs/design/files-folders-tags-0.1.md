# Folders, tags and homes: an SDK sketch (0.1)

> **Design only: not for merge, nothing here is built.** This is input for when James rules on the tag questions in
> contracts-v2 `docs/TAG-OPTIONS.md`. It drafts the SDK surface for option C ("one node, two links") under the
> PM's recommended answers. Each piece says what changes under another answer, and which contracts ask from the
> parity matrix (`planning/Reviews/2026-11-24-v1-parity-matrix.md`, C3–C9) it waits on. No folder, path or tag API
> ships until he rules.

## Assumed answers

| Question | Assumed answer | The other answers this sketch has to absorb |
|---|---|---|
| T-1 Is a folder a tag? | Yes: a **node** with named children (`FOLDER`) and unnamed members (`TAG`) | No: folders stay `files-directory/1`, and tags live on separate tag nodes |
| T-2 Identity | Text for global tags, minted for folders and hierarchical tags, address for homes. No path-derived ids. | Path ids: a path is hashed rather than looked up, and breaks on rename |
| T-3 Price | Option A for the MVP: about 0.34M gas per tag in a batch (0.73M for one alone). The dense family (B) comes later. | Wait for B: the same signatures, a different carrier |
| T-4 Denial | Deny without assert, in one action (a kernel change) | Two actions (BIND then UNBIND in one publication: one prompt, about 0.81M) |
| T-5 Homes | Not asked; assumed yes. A node per address, open to anyone, with `web3://` paths starting there. | No: a home is a directory only its owner can create |

## Model

```ts
type NodeRef =
  | { kind: "node"; id: SubjectId }               // minted (creator + salt): a folder or a hierarchical tag
  | { kind: "tag"; text: string }                 // a global tag: the id is the D-B folded concept, with no creation step
  | { kind: "home"; principal: Address | PrincipalId };
type ThingRef = FileRef | NodeRef;                // what a link points at
nodes.id(ref: NodeRef): SubjectId                 // pure; text folding and home derivation mirror the contracts, with vectors
```
A node needs no record before something links to it. It needs one only to appear as someone's named child, or to
carry a label (C5).

## Reads

```ts
files.resolve(path: string, o?: { lens?; at? }): Promise<
  | { status: "PRESENT"; target: ThingRef; chain: { node: NodeRef; name: string; author: PrincipalId }[]; basis }
  | { status: "ABSENT_PROVEN" | "MASKED"; segment: number; basis }       // which segment ended the walk
  | { status: "CONFLICT"; segment: number; candidates }                   // `resolveNoTiebreak`
  | { status: "UNKNOWN"; reason; segment?: number }>
nodes.children(node, o?: { lens?; cursor?; limit?; kinds?; types?: TypeId[] }): Promise<Page<NamedRow>>
nodes.members(node, o?: { lens?; cursor?; limit?; types?: TypeId[] }): Promise<Page<ThingRef>>
tags.of(thing, o?: { lens? }): Promise<{ tag: NodeRef; stance: "ASSERTED" | "DENIED"; author }[] | UNKNOWN>
type Page<T> = { rows: T[]; skipped: { denied: number; filtered: number }; coverage: "COMPLETE" | "PARTIAL";
                 next?: ResumeToken; basis }
```
- **Paths** have the form `#/r/<realm>/<first>/<name>/…`. The first segment is `0x<address>` (a home, needing C8
  and T-5), `~tag/<text>` (C6), `~node/<id>`, or the realm's shared root, which works today. After that, each segment
  is one `lookupName` through the lens. Names follow `files-name/2`, already shipped (`checkName`, the codecs).
- **Filter by Type** is done by the SDK on each row's header Type id (parity option (a)). It needs no contracts work.
  A page with filtered rows reports `skipped.filtered`.

## Writes (planners in the shape of `planEditFile`: `PLANNED { parts, review }`, then `runSequence`)

```ts
planCreateFile(efs, w, { parent: NodeRef; name; content; media? })    // mint, root revision, BIND(FOLDER) + BIND(HEAD)
planRenameFile(efs, w, { file, from: { parent, name }, to: { parent?, name } })  // atomic UNBIND + BIND; also moves
planDeleteFile(efs, w, { file, at: { parent, name } })               // your own entry: UNBIND (a mask); restore: BIND
planHide(efs, w, { at: { parent, name } })                           // another author's entry: C3, or T-4's lone deny
planCreateNode(efs, w, { parent?: NodeRef; name?; label? })          // a minted folder or hierarchical tag (idempotent)
planTag(efs, w, { tag: NodeRef; targets: ThingRef[] })              // BIND(TAG, node, target); batched, split by gas
planUntag(efs, w, { tag; targets })                                  // back to "said nothing" (RELEASE)
planDeny(efs, w, { tag; targets })                                   // an explicit "not this" (T-4)
planAttach(efs, w, { to: NodeRef; target: ThingRef; name? })        // with a name: a child; without: a member
```
Every review carries the gas price per tag in plain figures (T-3). At about 45 tags per transaction, planTag splits
into parts that carry the usual effects.

## Per piece: what other answers change, and what it waits on

| Piece | If James answers differently | Waits on |
|---|---|---|
| Create / rename / delete a file | T-1 no: `parent` is a directory, and the shape stays the same. Yes: the parent Type changes, and fixtures are re-recorded once. | nothing for own entries; **C3** (a direct mask) for hiding others' entries, or T-4 |
| Tag / untag / deny | T-2 path: `{ kind: "tag", path }` becomes a hash. T-3 wait: the carrier changes, the signatures don't. T-4 two-step: planDeny emits two actions in one prompt. | **C6** (concept id, stance, index family, `F_TAGS`, `tagsOf`) |
| Attach to a folder | T-1 no: members attach only to tag nodes, children only to directories | C6, plus the node-as-parent validator (under C) |
| Attach to a home | T-5 no: only homes their owner has created exist; `nodes.id({home})` still computes, and attach answers ABSENT | **C8** (home derivation and its reader) |
| List children / members | none for children. Members need the tag page reader under A or C; a bitmap scan only after B | children: today. Members and `F_TAGS`: C6 |
| Labels, descriptions | none | **C5** (properties) |
| Path resolution | T-2 path: no walk, a hash; rename breaks links | homes C8, `~tag/` C6; the rest works today |
| Persistent links | T-2 path: none survive a rename | none: `~efs` object links exist; node links reuse that codec |
| Aliases, lists, MIME | out of scope here | C9, C7, C4 |

## Hard cases

1. **A partial page never reads as empty.** `coverage` is COMPLETE only for a scan from the origin that finished
   (`completeFromOrigin`). A page cut short by the gas reserve, the limit, or filtering says PARTIAL with `next`. An
   empty PARTIAL page means "keep reading", never "none".
2. **Denied entries are skipped, never shown as absent.** Under the Lens law the first author with a stance decides,
   and a denial stops the search. Skipped rows are counted (`skipped.denied`). `resolve` reports MASKED with its
   segment, not ABSENT_PROVEN.
3. **Rename keeps links.** A link to a file or node is its subject id, so a rename or move changes one placement
   and the link still opens. A path link is a lookup: after a rename it answers ABSENT_PROVEN at that segment, and
   the UI can offer `files.placements(object)`. A rename never re-files members.
4. **Your `/car/tesla` is not mine** unless we share `car` through a lens. `resolve` returns the chain with its
   authors so the UI can say whose.
5. **Placement is not inference** (D-A). Putting `tesla` under `car` doesn't make things tagged `tesla` show up
   under `car`. `members` lists only explicit links. Nodes form a graph, not a tree: `resolve` caps the number of
   segments, and listings never recurse.
6. **The SDK mirrors the contracts byte for byte.** That covers text folding (D-B), home ids, node ids and name
   roles, checked by generated vectors in the way `KeyVectors` checks keys today. Normalization (NFC) stays in the
   SDK.
7. **Batches split cleanly.** Tags, children and the file finish ride `splitPublications` under the per-transaction
   cap. A file appears only when its finish commits, and a tag batch can be PARTIAL, using the same recovery as
   edits (EXPIRED, REORGED, `effect`).
8. **"Said nothing", "untagged" and "denied" are different states.** The three verbs are kept apart, and `tags.of`
   never collapses DENIED into absent.
