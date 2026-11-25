# Tags, topics and homes: SDK design (0.1)

> **Draft design. Nothing here is built.** It follows the owner's 2026-11-25 rulings on tags (T-1 to T-5, and "the
> shared tag": paths tell tags apart, words connect them) and replaces the sketch in draft PR #36. The SDK builds
> behind it as the contracts release lands: topic records, the tag's number, homes (C8), and the lists and
> directories below. Names marked *(pending contracts)* follow the contracts dev's spike and can still change. Folders
> are separate and already built: a folder is a Files Type with minted ids and named entries (`api-0.1.md`, "Folders").

## 1. The model

- A **word** is folded text (`tesla`). Words are shared and unowned.
- A **topic** is a path of words (`/cars/tesla`). `/cars/tesla` and `/people/tesla` are different topics.
  - Its id comes from records anyone can compute: a **word page** (the word as body; also the root-level topic
    `/tesla`) and, for two or more words, a **path record** `(parent topic, last word's page)` *(pending contracts)*.
  - Ids depend only on the words: never on an author, a Realm or a chain.
  - A topic is permanent. It is never renamed or moved; a "moved to" statement points readers at another one.
- A **tag** is one author's statement "thing X is in topic T, with number n".
  - `n ≥ 0` applies, `n < 0` denies, and no statement means the author said nothing.
  - What the size of `n` means is each app's choice.
- A **home** is the place derived from an address (the address as a left-padded word). Anyone can attach to it, and it
  needs no record.
- A **Lens** is an ordered list of authors. For each (topic, thing), the first author with a stance decides.

## 2. Folding and the link grammar

- **`fold(text)`** gives the word a typed string stands for, or the rule it breaks. The rule (`efs/fold/1`) pins one
  Unicode version and refuses characters not assigned in it, so a later Unicode can never change an existing id.
- **Which fold, NFKC_Casefold or NFC plus lowercase, is not decided.** The SDK dev evaluates both with vectors, and the
  owner confirms before any lasting deployment (it refines D-B).
- **Vectors are shared with the contracts**, including words that must be refused. Two SDKs with two fold tables would
  give two ids for one typed word.
- **Whitespace** is part of the rule: trimmed at both ends, and a run of whitespace inside a word becomes one
  underscore. Zero-width and bidi control characters are refused, never stripped (the evaluation says which scripts
  would need one, if any).
- **Its own export.** `fold` and its tables ship as their own entry point, so an app that never touches tags does
  not pay for them under the size gate.
- **The chain's word rules**, checked again by the SDK before planning so a bad word is never a revert:
  - 1 to 255 bytes of well-formed UTF-8;
  - no `/`, no ASCII control characters, no ASCII space, no ASCII `A–Z`;
  - not `.` or `..`;
  - not starting with `~`, and not `0x` followed by 40 hex digits (so no word page can shadow a home or a system link).
- **Links.** `parseLink` returns which kind a link is, and never guesses:

| Form | Kind |
| --- | --- |
| `/<word>/<word>/…` | a topic: segments are percent-decoded, then folded, then hashed |
| `/<word>` | that word's page |
| `/0x<40 hex>/<name>/…` | a home, then folder and file names, which keep their case (files-name/2) |
| `/~efs/o/…`, `/~efs/v/…` | permanent object and revision links (as built) |

  Trailing slashes are ignored and empty segments are refused. Every first segment starting with `~` is reserved for
  the system. No link addresses a named file through a topic until the owner settles whether a file's name is the last
  word of a path.

## 3. Ids (pure, no chain read)

```ts
fold(text: string): { ok: true; word: string } | { ok: false; rule: FoldRule };
topicId(words: readonly string[]): TopicId; // folds each word, then the word page and path record ids
homeId(address: Address): Hex;              // the address as a word, no hash
```

Resolving a topic path is folding and hashing, never a Lens walk. Folder and home paths keep the Lens walk
(`resolvePath`).

## 4. Writes

```ts
planTag(efs, w, { topic: TopicRef | readonly string[]; targets: readonly TagTarget[]; number?: number }, opts)
planUntag(efs, w, { topic; targets }, opts)  // back to "said nothing" (RELEASE)
planDeny(efs, w, { topic; targets; number?: number }, opts) // a negative number (default -1)
type TagTarget = FileRef | RevisionRef | FolderRef | TopicRef | { kind: "address"; address: Address };
```

- **The number on the wire** *(pending contracts)*. The number is 16 bits: -65,536 to 65,535. BIND carries `n` in
  the action's `salt` word (0..65,535). UNBIND carries `-1 - n` (for `n` from -1 to -65,536). RELEASE carries 0.
  - Today's actions keep their meaning: a bind is 0 and a mask is -1.
  - A number outside what the release defines is refused with MISUSE at plan time, never a revert. The range comes
    from the release constants, not from this SDK.
- **Changing a number** is one action, with the usual compare-and-swap on the author's own binding: a positive to
  another positive is a rebind, and a negative to another negative is another UNBIND. A first statement may be
  negative (a denial on its own).
- **Targets.** A file, or one revision of it (for claims about content that an edit could change), a folder, a topic,
  or an address. An address needs no record, including one that has never transacted. Address targets are for TAG
  only; anywhere else the chain refuses them with a named error, and the planners refuse them first (MISUSE).
- **Registration is planned automatically.** The planner reads which word pages and path records already exist (one
  batched read). It publishes the missing ones parent first, in the same save as the first tag, with no extra prompt.
  A topic must be registered strictly before its tag: the index walks the path at the tag's own position in the
  order, so registrations always come ahead of the tag in a publication, or in earlier parts.
  - A deep new path may not fit one transaction. The planner then splits registration into earlier parts, and the tag
    goes in the last part.
  - Registration parts are idempotent and harmless if the save is abandoned: a registered topic is just a topic.
  - A path is never shortened or skipped to make it fit. If even the split cannot fit, the plan is TOO_LARGE.
- **The review** shows, in plain figures:
  - the topics the save creates (`newTopics`), and the records that registers;
  - each tag, with its topic, target, number, and the author's current stance;
  - the parts, with the gas per part and per tag.
- **Batches.** Many targets under one topic, or one target under many topics, split by gas like every other plan. A
  batch plans every tag or none, and lists each refusal by index, as the folder planners do.
- **A tag on an unregistered topic is refused by the chain with a named error**, never a silent miss. The planner
  registers the topic first, so a plan never meets that error.
- **Effects.** One `tags.tag` effect per (topic, target), with the number and its stage. `SequenceRecord.effect`
  names the topic and the targets, so a client can hold new saves per tag.

## 5. Reads

### 5.1 The Lens rule and the three views

- **Priority.** For a thing X in topic T, walk the Lens in order. The first author with a stance on (T, X) decides: a
  number ≥ 0 shows X with that number, and a number below 0 hides it. An UNKNOWN read never counts as "said nothing".
- **Mine:** only the Lens authors' statements.
- **Everyone:** every author's statements, minus what a Lens author marks below 0, either at that place or at the topic
  the entry was filed under. A denial does not travel down to child topics, and a stranger's negative number never
  hides anything from anyone else.
- **Raw:** nothing hidden.
- **Public lists are newest first, meaning most recently first stated.** An entry is placed at an author's first
  statement on (topic, thing). Changing a number, or removing a tag and adding it back, never moves it up. The SDK
  offers no "recently active" order and never synthesizes one. The client labels the order "recently added".

### 5.2 Reads

```ts
topicItems(efs, topic, { view, lens?, rollup?, synonyms?, cursor?, limit? }) // a page of things in a topic
tagsOf(efs, thing, { view, lens? })        // the topics a thing is tagged with, and each author's stance
topicChildren(efs, topic, { lens?, showAll?, cursor?, limit? })
wordPage(efs, word, { lens? })             // every place the word is used, grouped by place
```

- **Rows carry what a client needs to order and to explain them:** the target, the number, its author, when it was
  first stated (its sequence), and, for roll-up, the topic it was filed under.
- **Coverage** follows listFolder's rule: COMPLETE only for a list scanned from its start to its end. A page from a
  cursor is at most PARTIAL, and an empty PARTIAL page means "keep reading".
- **Duplicates.** Roll-up lists a thing filed under `/cars/tesla` and under `/cars/ford` twice in `/cars`. The SDK
  removes duplicates by thing, and every result says how far: `dedup: "COMPLETE" | "BOUNDED"` (with the bound), so a
  page never claims a uniqueness it cannot guarantee.
  - An in-memory iterator, for a client scrolling one view, keeps the seen set for the session, so it is always
    COMPLETE.
  - A serializable cursor, for resuming, carries the things already returned up to the stated bound; past it the
    result is BOUNDED.
  - A dropped duplicate's place stays on the surviving row ("filed under tesla, ford"). Clients still dedupe what they
    render, since they merge synonym lists anyway.
- **Calls stay under the endpoint's gas limit.** A roll-up read under a big Lens is expensive (the contracts
  measured about 283k gas for a page of 10 at a Lens of 1, and 15M for a page of 50 at a Lens of 64). The SDK splits
  each read by Lens and by page so every eth_call stays under a conservative per-call cap. It starts small and backs
  off when an endpoint runs out of gas. A call that ran out of gas is UNKNOWN or PARTIAL, never an empty page, and a
  big Lens never turns into UNKNOWN just because one call was too large.
- **Skipped rows are counted, never dropped silently:** denied, duplicate, and below the junk rule.
- **`tagsOf` has the three views too.** Mine reads the Lens authors' statements. Everyone and Raw read the contracts'
  all-authors list per target, which includes lone negatives for every kind of target, so it shows who says a tag
  applies and who says it doesn't. Hiding still uses only the Lens authors' denials, read directly.

### 5.3 Synonyms and moves

- Two levels: word level (`car` = `cars`) applies to every path using the word, and path level joins two specific
  places.
- Synonyms never merge ids. The reader gathers each list through the "what points at this" list, and merges them in
  time order (statement sequence), removing duplicates.
- At most 4 hops, cycle-safe, and at most 16 lists per view. A view that hits a limit says so.
- Each synonym is one more list read, and the result reports which lists it merged.

### 5.4 Children, word pages and counts

- **Children of a topic,** in three tiers:
  1. those a Lens author listed with a number ≥ 0, ranked by that number;
  2. then places a Lens author has filed something under, by Lens count;
  3. then the rest by global count.
  - Each row carries what places it in its tier: the Lens author's number, the Lens count, the global count, and how
    many distinct authors tagged it.
  - **Junk rule (an SDK default, so clients agree):** a child with no statement from the Lens needs tags from at least
    2 different authors to be listed. `showAll` turns the rule off. How many rows to show is each client's choice.
  - A big directory cannot be ranked in one read, so the read scans a bounded number of entries and reports PARTIAL,
    never a short list as COMPLETE.
- **Word pages** read the directory "topics that use a word".
  - A group is a place whose own word is the word. A place below another group is not a second group.
  - Group order: places the Lens has used first (by Lens count), then the rest by global count, largest first. Both
    counts are returned.
  - There is no separate per-word item list.
- **Counts** are list lengths, and they also count removed and negative statements, so they are "about". The SDK
  returns the count from the Lens beside the global one, because a global count alone can be inflated.

### 5.5 Names

- **A topic segment's display name:** a path-level label from the Lens, else the word-level label in the reader's
  language, else the word.
- **A file shown in a topic** (a tag has no name), in order:
  1. the name its tagger gave it in their own home or folders;
  2. the name its creator gave it;
  3. the first name from the Lens;
  4. else its media type and a short id.
  Files in a topic open by permanent link.

### 5.6 Homes

- Viewing a home uses `efs.lens.place({ reader, owner: address })`, then "public" once the all-authors lists exist.
- **Contract addresses.** A home's id is the padded address, but a contract's principal is not: it is the contract
  principal of the Realm (origin-qualified). `place` inserts the principal that the address actually publishes as,
  and both when an address could act as either. A Safe's home is in the design and in the tests.
- Every row says whose entry it is when it isn't the home owner's, because a reader's own `pet.jpg` at someone else's
  address would otherwise look like the owner's.

## 6. What this design guards against

| Pitfall | Guard |
| --- | --- |
| A tag lands but a list misses it (silent absence) | planners register first; reads never treat UNKNOWN as nothing; rebuild-equals-live vectors |
| A deep new path doesn't fit one transaction | registration split into earlier, harmless parts; never a skipped level |
| A word that shadows a home or a system link | refused by the SDK and by the chain |
| Two fold tables, two ids | one pinned fold rule and shared vectors |
| Junk children, inflated counts | the junk rule by default, and the Lens count beside the global one |
| A latest poster topping a public view | entries ordered by first statement, so no bump; the Lens tier is shown first |
| A tag outliving an edit | a tag can target a revision |
| Hiding by strangers | only Lens authors' denials hide things |

## 7. What waits on what

- **The contracts release:**
  - the topic record Types and their rule;
  - the number in BIND and UNBIND;
  - addresses as targets and homes as parents (C8);
  - the lists (per author and all authors, exact and roll-up) and the two directories;
  - the purposes for topic statements (label, definition, same as, moved to, parent);
  - the readers for the three views.
- **The owner (James):**
  - the fold rule (NFKC_Casefold or NFC plus lowercase);
  - the default view for topics, and what a newcomer's Lens contains.
- **Built first, once confirmed:** `fold` and the link grammar with vectors, then the planners, then the reads.
- **Statement planners** (label, definition, "same as", "moved to", parent) join section 4 once the contracts dev
  names their purposes.
