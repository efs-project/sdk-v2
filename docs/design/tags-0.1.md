# Tags, topics and homes: SDK design (0.1)

> **Built at the tag-release re-vendor** (contracts `2462e54`), as `@efs/sdk/tags`. It follows the owner's 2026-11-25
> rulings on tags (T-1 to T-5, and "the shared tag": paths tell tags apart, words connect them). Folders are separate:
> a folder is a Files Type with minted ids and named entries (`api-0.1.md`, "Folders").
>
> **Built:**
> - ids and the chain's word and text grammars (`checkWord`, `checkText`, `wordPageId`, `pathId`, `homeId`,
>   `propertyKey`). They match `test/vectors/topics.json` code for code: 197 words, 45 texts, the paths, and every
>   EfsTopics builder's actions and hashes;
> - the number law (`numbers.json`);
> - `planTag` / `planDeny` / `planUntag`: registration strictly before the tag (pages, then path records, root first;
>   earlier parts for a deep new path), the 16-bit number, lone negatives, number changes and restores, address
>   targets. Each statement is priced by its tag row and the per-level terms, by the planning rule;
> - `topicItems` (Mine, Everyone, Raw; exact or roll-up): who decided each row (`decider`: a Lens author or the
>   public tier); the scan status, where only EXHAUSTED ends a listing and every other page carries a cursor; two
>   limits per page (rows wanted, entries read); repeats removed by thing across calls and pages (`dedup`); per-call
>   bounds from the gas model's `reads` section;
> - `tagsOf`, `topicChildren` (each child's word read back and checked against its parent; an optional fold skips a
>   word that is not its own fold), `wordPage`, `topicPath`, and `placeCount` / `authorCount` ("about" figures);
>   a word nobody has used (`wordPage`) or a topic nobody registered (`topicChildren`) is ABSENT_PROVEN, never a
>   refusal, and a registered topic with nothing below it is an empty, finished page;
> - the hidden-child rule (section 5.4): in a roll-up through a Lens, a child topic the first Lens author with a
>   stance hides where it hangs hides everything filed at or below it (`counts.hiddenByChild`);
> - every reader reply is checked before use, and a failed check is the endpoint's fault (RPC_ERROR), never a row:
>   - each row's position is its own (topic, thing), and an exact read's topic is the place;
>   - a roll-up row's topic lies below the place (walked up its path records, each id recomputed);
>   - a decider names that Lens index's author, with a number of 0 or more, and an Everyone row has a yes;
>   - each place of a word page or of a topic's children is (its parent, that word);
>   - a page that is not the end gives a resume point;
> - a read the node refuses as too large (out of gas) is tried again with half the bounds, up to four times, before
>   it is UNKNOWN;
> - batches: each planned part carries the planner's own estimate (rows, per-level terms, the floor), which
>   `packBatches` sums; a part with tag binds and no estimate is never batched;
> - topic statements: `planLabel` (a topic's or a home's name in one BCP 47 language, lowercased; the text/1 record
>   published when new), `planSame` and `planBroader` (both ends registered earlier in the same save, as the
>   validator's codes 10 and 11 need; a topic is never either of these to itself), each with `remove: true` for a
>   RELEASE of your own, refused UNCHANGED or NOT_STATED. Each is priced by its measured row (contracts 0fb4804): a
>   first label `bindPropertyFresh` (a new text adds the text/1 row), a later one `bindPropertyRebind`, a first
>   `same` `bindSameFreshWord` (the dearer of the two first-same rows), a first `broader` `bindBroaderFresh`, a later
>   bind `restoreSame` / `restoreBroader`, and a removal `release*`, as the reference planner prices them; the label
>   language is lowercased (ASCII A–Z) exactly as EfsTopics.labelKey folds it;
> - names (section 5.5): `labelOf(subject, { lens, langs })`, and `topicName(topic, { lens, langs })` for every
>   segment: a path-level label from the Lens, else the word's label, else the word (`source`). In each language,
>   in the reader's order, the first Lens author with a label decides, and an earlier one's "no label" (MASKED) stops
>   that language. A label is used only when its target really is an admitted text/1 record (its id recomputed from
>   the body read back); one that is not is skipped, counted, and the next author is tried. A failed read is UNKNOWN,
>   never "no name";
> - a file's name in a topic (spec §3.7): `fileNames(files, { lens, scan })` reads each file's FOLDER backlink list
>   itself (no chain reader serves its entries): the newest `scan` (≤ 16) entries, each one's author, position, the
>   author's current head there (an entry counts only while it still binds the file) and its name record. Order: the
>   tagger's own entry in their home or a folder they created, else the creator's, else the first Lens author's, else
>   null (the client shows media type and a short id); `complete` is false when a null is not proven;
> - synonyms gathered at both levels (spec §3.5): `topicSynonyms(topic, { lens })` gives the places joined to a topic
>   by "same as" (path ↔ path, word page ↔ path, word page ↔ word page) and each word's word-level synonyms (word page ↔
>   word page only), found from both sides (each Lens author's own statements, and the list of statements naming the
>   topic), each edge decided by the Lens law at its position (an earlier "not the same" decides it), at most 4 hops,
>   16 topics and 16 entries per list, with `limited` and `complete` saying when it stopped short or can't prove an
>   absence; ids are never merged. Each joined place carries `said`, its deciding statement's own direction ("subject
>   is the same as other"), so its author can release exactly that statement;
> - `topicBroader(topic, { lens })`: one hop each way over "broader" statements, the topics it is under (`broader`)
>   and the topics under it (`narrower`), found from both sides and each decided by the Lens law at its position, with
>   `said`, `limited` and `complete` as above;
> - `lensTagsOf(thing, { view, lens, rows, entries, cursor })`: a thing's tags as a Lens sees them, applied by the SDK
>   over the chain's `about` list (which reads no Lens), per (place, thing): the first Lens author with a stance decides
>   (a yes: the Lens tier with their number; "not this": hidden, counted); with none, Everyone shows the public tier
>   when someone says yes, and Mine nothing. topicItems' page laws: two limits, only EXHAUSTED ends, repeats removed by
>   place across pages; each place checked to name the thing, each head reply checked against the Lens law, and a
>   deciding yes checked to name the thing. `tagsOf` stays the unfiltered list;
> - save effects for every tag planner: `tags.tag` / `tags.deny` (topic, number, targets), `tags.untag`,
>   `tags.label`, `tags.same`, `tags.broader`, with registration-only parts folded into their save's kind
>   (`tags.register` when a save is nothing else), on the record and through resume;
>
> **Not built yet:**
> - the fold rule itself (James's ruling: the planners and readers take a `fold` step meanwhile, and check every
>   word against the chain's grammar);
> - the junk rule for children (two distinct authors), which needs a per-child author figure the readers don't
>   give;
> - merged item reads across synonym lists (a multi-list cursor merged by statement sequence changes `topicItems`'
>   paging, so it is its own reviewed step); `topicSynonyms` gives the lists to merge.

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
| `/~efs/o/<folder>/<name>/…` | a path from a folder named by its id, the shared root included (see api-0.1) |

  Trailing slashes are ignored and empty segments are refused. Every first segment starting with `~` is reserved for
  the system. The shared root has no named link of its own (no `~root`), and `~home` is never defined. No link addresses a named file through a topic until the owner settles whether a file's name is the last
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
- **Targets.** Any existing record or subject, of any Type, other apps' Types included. In particular: a file, or one
  revision of it (for claims about content that an edit could change), a folder, a topic, or an address. An address
  needs no record, including one that has never transacted. An address target is refused only for a file's current
  version (HEAD) and for a folder entry (FOLDER), where the Files readers can't serve it: the chain refuses it there
  with a named error, and the planners refuse it first (MISUSE). TAG allows it, and other apps' purposes are not
  judged by Files (the coming `property` purpose may hold an address value).
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
  - the parts, with the gas per part and per tag. Each tag is priced by the contracts' gas model
    (`gas/model.json`), never a constant, by the model's own composition rule (`method.tagLevels`):
    - a first statement on an n-word topic costs `bindTagFresh` (nobody has stated anything on the pair) or
      `bindTagSecondAuthor` (the pair exists);
    - plus, at each of the n − 1 levels above the place, the author's own term (`tagLevel.mineNew` or
      `mineExisting`, by whether that author's list at that level is empty);
    - plus the shared term (`tagLevel.sharedNew` or `sharedExisting`) for a fresh pair of either sign, and, since
      contracts step 3c, for a later author's first yes on an existing pair. A later author's first "not this" files
      nothing below, so it pays only the author's own terms;
    - which lists are priced as new is the model's own field, `tagLists.priceAsNew` (today: exactly 1 entry, or a
      multiple of 5, zero included), read from the model and never typed in;
    - so a deep tag's cost grows with its depth, and the plan reads each term from the profile it plans for.
- **Batches.** Many targets under one topic, or one target under many topics, split by gas like every other plan. A
  batch plans every tag or none, and lists each refusal by index, as the folder planners do.
  - The splitter packs by the model's per-tag prices, never by a fixed count. For scale, the contracts dev measured
    the most first tags one publication holds (spec 7a, contracts step 3c):
    - at depth 64: 8 when the topic's lists already exist (the same after Glamsterdam), and 3 when each tag is on
      its own new path (5 after Glamsterdam);
    - at depth 8: 35 and 18 today, 41 and 27 after Glamsterdam.
  - These figures are a test cross-check only, never constants in code. The model prices each tag on its own, so a
    part it packs may hold fewer tags than these, never more.
- **A tag on an unregistered topic is refused by the chain with a named error**, never a silent miss. The planner
  registers the topic first, so a plan never meets that error.
- **Effects.** One `tags.tag` effect per (topic, target), with the number and its stage. `SequenceRecord.effect`
  names the topic and the targets, so a client can hold new saves per tag.

## 5. Reads

### 5.1 The Lens rule and the three views

- **One rule for every view** (spec 3.1, planning 0109b4a). For a thing X shown at a place, walk the Lens in order.
  The first author with a stance decides: a number ≥ 0 shows X with that number, and a number below 0 hides it. An
  UNKNOWN read never counts as "said nothing".
  - **An earlier Lens author always beats a later one, in a roll-up too.** Where `/cars` shows a thing filed under
    `/cars/tesla`, each Lens author in turn is asked two things: a "not this" for it at `/cars` (the place being
    viewed), then their stance where it was filed. The first answer found decides. So someone further down your Lens
    can't hide what you filed yourself, and your own "not this" at `/cars` keeps a thing off that page even though
    you filed it below.
  - A denial does not travel down to child topics, and a stranger's negative number never hides anything from anyone
    else.
- **Mine:** that walk over the Lens alone.
- **Everyone:** the same walk with "public" at the end. When nobody in the Lens has a stance, the row shows if anyone
  says yes. So everything Mine shows, Everyone shows too.
- **Raw:** no rule, nothing hidden.
- **Every public row says who decided it** (`decider`): the Lens author and their number, or nobody in the Lens,
  which is the public tier. The client labels public-tier rows one by one and holds back media from that tier.
- **A stranger's "not this" can neither hide a row nor add one** (tag spec 3.2; planning 1b9a059, c0cc5a5).
  - Raw shows every row.
  - Everyone shows a row when someone says yes, and leaves it out when nobody does. The decision is exact: the
    pair's head carries how many authors currently say yes (contracts step 3c), and a row is left out only when
    that count is zero. No author scan decides it, so a stopped scan can never drop a row, and negatives posted
    ahead of the first real tag can't hide it.
  - The row shows "N say yes" from that count. The "no" side is read from the pair's authors, bounded, and marked
    when not every author was read.
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

- **Rows carry what a client needs to order and to explain them:** the target, the number, who decided it
  (`decider`, section 5.1), when it was first stated (its sequence), and, for roll-up, the topic it was filed under.
  - A public row does not say who made the filing that put it at the top. Where that matters, as for a home used as
    an inbox, it comes from the first page of `byName` at that position (section 5.6).
- **Coverage** follows listFolder's rule: COMPLETE only for a list scanned from its start to its end. A page from a
  cursor is at most PARTIAL, and an empty PARTIAL page means "keep reading".
- **A short page is never the end** (spec 3.3). Rows nobody says yes to, repeats and hidden rows are skipped, so a
  page can return fewer rows than asked for, or none, while more remain.
  - Every paged result says whether its list is finished, and if not, gives the point to resume from. Finished is
    claimed only when the list's end was read, never because a page came back short or empty.
  - **The chain says why a page stopped** (its scan status). Only "exhausted", meaning the list ended, finishes a
    listing. Every other status (the entry limit was reached, or the gas reserve stopped it) carries the point to
    resume from. The SDK keeps that in its own result and never turns a stop into an end.
  - **Two limits** (spec 3.3, planning 0109b4a): a page read takes the rows wanted and the entries to read, and stops
    at whichever comes first. One number can't bound both: skipping a padded stretch is cheap, and a shown row under
    a big Lens is not. Anyone can pad a list with rows that get skipped, at about the price of a tag each, so a read
    that kept going until it filled a page could be made to run forever.
  - **The yes-count comes before the Lens** (planning 2be0828). A reader checks a row's yes-count first and asks the
    Lens only about rows someone says yes to, so a skipped row costs one read whatever the size of the Lens. The
    SDK's own merging (synonyms, removing duplicates across pages) follows the same order.
  - **The limits are sized from the gas model:** the per-row and per-skipped-entry read costs in `gas/model.json`'s
    `reads` section, from the release the SDK vendors. Together with the Lens size and the endpoint's per-call cap,
    they set both limits; no constant does.
- **Duplicates.** Roll-up lists a thing filed under `/cars/tesla` and under `/cars/ford` twice in `/cars`. A place's
  own list repeats a thing too (contracts step 3c), so exact-topic reads remove duplicates exactly as roll-ups do.
  The SDK removes duplicates by thing, in Mine as in Everyone, and every result says how far: `dedup: "COMPLETE" | "BOUNDED"` (with the
  bound), so a page never claims a uniqueness it cannot guarantee. The chain's readers dedupe within a page only;
  removing duplicates across pages is the SDK's job (spec 3.3).
  - **Decide a row before marking its thing as seen** (spec 3.3). Only a row that will be shown adds its thing to
    the seen set. A thing filed under two child topics, with no yes at the newer filing and a yes at the older one,
    still shows, through the older one. A reader that marked the thing as seen at the newer row would drop it
    silently. The same holds for every skip: a row left out for its yes-count, a Lens denial or a hidden child never
    marks its thing as seen.
  - **Why a place's list repeats (3c):** it takes an entry for a fresh (place, thing) pair of either sign, and one
    for any author's first yes, so nobody can get in first and keep a later tag out of "newest first". A pair with
    only negatives stays listed. A later author's first negative adds no entry; it is reached through the pair's
    authors list (position-authors), from the place and, for tags, from the thing.
  - **Stated limit:** an author whose first statement on a pair was negative and who later flips to yes gets no new
    entry. The pair is already listed, so nothing is missing; it just doesn't show as new. Reads don't compensate.
  - An in-memory iterator, for a client scrolling one view, keeps the seen set for the session, so it is always
    COMPLETE.
  - A serializable cursor, for resuming, carries the things already returned up to the stated bound; past it the
    result is BOUNDED.
  - The row shown is the newest filing that shows, and it names the topic it was filed under (spec 3.3). A dropped
    duplicate's place stays on the surviving row ("filed under tesla, ford"), the list "where is this filed" shows.
    Clients still dedupe what they render, since they merge synonym lists anyway.
- **Calls stay under the endpoint's gas limit.** A read under a big Lens is expensive (contracts step 4 measured
  `mine` at about 555k gas for a page of 10 at a Lens of 1, and 12.1M for a page of 50 at a Lens of 64). The SDK splits
  each read by Lens and by page so every eth_call stays under a conservative per-call cap. It starts small and backs
  off when an endpoint runs out of gas. A call that ran out of gas is UNKNOWN or PARTIAL, never an empty page, and a
  big Lens never turns into UNKNOWN just because one call was too large.
- **Skipped rows are counted, never dropped silently:** denied, duplicate, below the junk rule, and not their own
  fold (next point).
- **Every listed word is folded again** (a topic's children, a word's places): a row whose word is not its own fold
  is skipped into the `skipped` count. The chain can't check case outside ASCII, unassigned characters or
  compatibility forms, so this keeps a look-alike child that a careless or hostile client registered out of
  listings (tag spec, planning ba33d7f).
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
    - The chain keeps no per-child author count. "2 different authors" comes from the per-item "who said it" lists:
      the read samples a bounded number of a child's items. When it stops before it can decide, the child is reported
      as undecided and the listing is PARTIAL, never quietly dropped.
  - A big directory cannot be ranked in one read, so the read scans a bounded number of entries and reports PARTIAL,
    never a short list as COMPLETE.
  - **Hiding a child hides what is filed under it** (tag spec 3.6). If a Lens author marks `/cars/tesla` below 0 as
    a child of `/cars`, that reader's roll-up of `/cars` leaves out everything filed at or below `/cars/tesla`. The
    SDK applies this from each entry's path; the chain's reader does not.
- **Word pages** read the directory "topics that use a word".
  - A group is a place whose own word is the word. A place below another group is not a second group.
  - Group order: places the Lens has used first (by Lens count), then the rest by global count, largest first. Both
    counts are returned.
  - There is no separate per-word item list.
- **Counts** are one read each (contracts step 3c). A place's head gives two: filings, and distinct things ever filed
  there. A (place, thing) pair's head gives two: its authors, and how many of them currently say yes.
  - The place counts include things nobody says yes to any more, and removed and negative statements. So the
    distinct count is shown as "about N", never as the number of rows Everyone returns.
  - The SDK returns the count from the Lens beside the global one, because a global count alone can be inflated.

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
- **A home used as an inbox.** A public row doesn't say who made the filing that put it at the top, so who left a
  thing in someone's home comes from the first page of `byName` at that position: one author per row, with each
  author's first statement there.

## 6. What this design guards against

| Pitfall | Guard |
| --- | --- |
| A tag lands but a list misses it (silent absence) | planners register first; reads never treat UNKNOWN as nothing; rebuild-equals-live vectors |
| A public page comes back short because skipped rows used up the read, and looks like the end | only "exhausted" finishes a listing, every other stop gives a resume point; two limits (rows wanted, entries to read); the yes-count is read before the Lens; a thing is marked seen only once its row is shown |
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
- **The SDK's re-vendor checklist for that release** (each on a branch, then PM review). The re-vendor happens once,
  at the whole tag release (contracts step 5, after the step-4 readers and the floor follow-up), never at an earlier
  step such as 3c: one bundle, and one re-pin for the client. The PM says when the release surface is handed over.
  - tag planners and reads as this document describes; the number is 16-bit (−65,536..65,535, MISUSE outside);
    registration strictly before the tag; address targets refused only for HEAD and FOLDER, at plan time as on chain
    (allowed for TAG, other purposes not judged);
  - **backlinks are one list per (purpose, target)**, at `Keys.backlinkList(purpose, target)` (contracts step 3a,
    planning 0dc8708). No chain read spans every kind of link. So restore's `alsoPlaced` reads the FOLDER list,
    with a test that tags don't change it. Synonym gathering (section 5.3) reads the "same as" list, and any
    "everything pointing at this" read names the purposes it wants, one read each, and says which it read;
  - the pin probe checks the index and reads-contract codehashes that the deployment file now carries (step 3a),
    beside today's five;
  - interface ids now commit to their functions (a new hot id, `0xf37d24d0…`). The SDK pins none today. Any
    check the re-vendor adds takes them from the release, never typed by hand;
  - **removed entries (listRemoved, planRestoreEntries).** Today's walk (`lastBoundTarget`) relies on UNBIND needing
    a BOUND head and RELEASE a BOUND or MASKED one: a removed entry's last bound version is then at most two versions
    back, so its target is always known and any other history is an endpoint fault (page-level UNKNOWN). The tag
    release admits UNBIND from every state, for every purpose (contracts `docs/TAG-DESIGN.md`: "a first statement
    may be negative"), including a hide of another author's FOLDER entry, so that invariant ends there:
    - bring back a per-row state: KNOWN (the target), UNKNOWN (with its reason) and NEVER_BOUND (a mask with no
      earlier bind by this author: "you hid someone else's entry here; Unhide", never something to restore);
    - make the walk paged or bounded, with an honest UNKNOWN per row instead of page-wide, because release and mask
      can alternate and an honest history can run deeper than 8;
    - restore answers NEVER_BOUND rows with a named refusal, not ENTRY_ABSENT, and Unhide is a RELEASE of the mask;
    - tests on the new contracts: a lone hide, and an alternating history deeper than 8 (built in-test with the
      `EfsFiles` builders `hide`/`loneNegative` and their JS twins);
    - what the contracts dev confirmed for that release: a lone mask's head is MASKED, target kind 0 (NONE), revision
      1, no previous admission, and `historyAt` answers target kind 0 for a version with no earlier BIND. To fill in
      the kept target kind, `historyAt` itself walks back past masks and releases to the last BIND on the same
      `maxHops`, so on an alternating history it can answer UNKNOWN for a version the SDK reached within its own
      bound: that is a per-row UNKNOWN, not an endpoint fault. Each head (and history reply) gains the recorded
      strength as its last word, so the head ABI and its decoders change.
  - **the tag PM's read rules from the contracts 3b review** (spec planning 1b9a059):
    - Everyone leaves out a row exactly when the pair's yes-count (its head, 3c) is zero; no author scan decides it
      (section 5.1, spec planning c0cc5a5). Tests: an all-negative pair is left out; a pair with many negative
      authors ahead of one yes is shown, with "1 says yes";
    - the head counts read as one read each: filings and distinct things per place, authors and yes-count per
      pair. The distinct count is "about N", never the number of rows Everyone returns (section 5.4);
    - chain readers dedupe within a page only; the SDK dedupes across pages (section 5.2, spec 3.3);
    - exact-topic reads remove duplicates like roll-ups, since a place's list takes each author's first yes (3c);
      an author's negative-then-yes adds no entry, and reads don't compensate (section 5.2);
    - a Lens author's hidden child topic hides everything filed at or below it from that reader's roll-up of the
      parent (section 5.4);
    - tags priced by `gas/model.json`, including the per-level terms a later author's first yes carries after 3c;
  - **the PM's items from the contracts 3c review** (spec planning 2810ef6):
    - pricing by the model's composition rule (section 4): `bindTagSecondAuthor`, plus at each level above the
      place the author's own term and, for a yes, the shared term. Test: a later author's first yes on a deep
      existing pair is priced above the same author's first "not this" there, by the shared terms, and each part's
      real gas fits under the cap;
    - splitting by the model, never by fixed counts (section 4, spec 7a). Tests at depth 64 and depth 8, with the
      lists existing and with each tag on its own new path: every part fits under the cap, and no part holds more
      first tags than the dev measured (8 and 3 at depth 64, 35 and 18 at depth 8; on the Glamsterdam profile 8
      and 5, 41 and 27);
    - a short or empty page is never the end: every paged result says finished or gives a resume point, and a read
      bounds its work by entries read (section 5.2). Tests: a list padded with all-negative pairs ahead of one shown
      row returns short or empty pages that say "more to read", and the row arrives on a later page;
    - a row is decided before its thing is marked as seen, and duplicates are removed by thing across pages
      (section 5.2). Test: a thing filed under two child topics, with no yes at the newer filing and a yes at the
      older one, shows once in the parent's roll-up, through the older one;
  - **the PM's read rules for the step-4 readers** (spec planning 0109b4a, 2be0828; 3.1–3.3):
    - one rule for every view: Mine is the Lens walk alone, Everyone adds the public tier at the end, Raw has no rule.
      An earlier Lens author beats a later one, in a roll-up too, asked first for a "not this" at the viewed place,
      then for their stance where the thing was filed (section 5.1). Tests: a later Lens author's "not this" at
      `/cars` can't hide what an earlier one filed at `/cars/tesla`; an earlier author's own "not this" at `/cars`
      hides what they filed below; everything Mine shows, Everyone shows;
    - every public row carries `decider` (a Lens author, or the public tier), for the client to label the tier and
      hold back its media; the filer of a home's inbox row comes from `byName`'s first page (sections 5.2, 5.6);
    - the scan status: only "exhausted" ends a listing, and the entry-limit and gas stops carry a resume point. Two
      limits per page, rows wanted and entries to read. Test: a list padded with all-negative pairs pages through
      entry-limit stops, each with a resume point, until the real row;
    - the yes-count read before the Lens, so a skipped row costs one read at any Lens size; the SDK's merging in
      the same order. Test: paging through a padded stretch costs about the same gas at a Lens of 1 and of 64;
    - duplicates removed by thing in Mine as in Everyone; the row shown is the newest filing that shows, naming its
      topic, and the rest go to "where is this filed";
    - both limits sized from the `reads` terms of `gas/model.json`, never constants;
  - **the readers rebuild's read costs** (contracts b163514, with the tag PM; provisional until the model's `reads`
    section):
    - a padded entry costs a reader about 36k gas whatever the Lens size, so a large entry limit is safe: padding
      can't make a page expensive, only short;
    - until the release-step speed-up lands, one call under a 10M cap holds about page × Lens = 760 for the Lens view
      of one place and 312 for its roll-up, and 688 and 320 for Everyone. At a Lens of 64 that is 15 and 5 rows. These
      will rise, so pages are sized from `gas/model.json`'s `reads` bounds, never from these figures;
  - **the contracts gateway's 501** (until a gateway split serves them): it answers 501 "not served by this gateway
    yet" for an existing file's or revision's object id. A files-external/1 whose locator points at the EFS
    gateway's own by-id path then reads as unavailable, never as absent. The SDK already maps it so: any web3:// status
    other than 200 or 307 fails that location, and a read with no working location is UNAVAILABLE
    (GATEWAY_UNAVAILABLE, transient). `test/web3read.test.ts` pins the 501 case;
  - **plan every publication by the model's planning rule** (contracts floor follow-up 7d11236; `gas/model.json`
    `planning` and, per schedule, `floor`). This covers files as well as tags:
    - a publication is planned only when it is inside the Realm's limits (actions, bind-kind actions, PUBLISH body
      bytes) and `max(E, V) ≤ floor(txGasCap × (100 − headroomPercent) / 100)`. E is the model's execution
      estimate (prague: `constants`; amsterdam: `split.executionGas`). V is the visible gas the kernel's floor checks
      need, from the floor's own formula: its prefix floor and final reserve from `floor.workModel`, `floor.limits`
      and `floor.types`, the kernel's share from `floor.kernel`, and the 63/64 forwarding;
    - since the kernel-floor fix (see api-0.1, "The kernel's floor"), the planners already add an upper bound of
      V − E from the deployment's work model, with the kernel's share K bounded by E. The re-vendor replaces that
      bound with the model's exact rule (`floor.kernel` for K), which splits less;
    - why: the SDK used to plan by E alone, and its review's `gas.floor` is still always null. In the contracts'
      shared shapes V exceeds E in every case, by about 0.04M to 1.56M gas, so E alone can admit a publication the
      floor refuses. On prague, 11 create-file recipes in one publication have E 13.87M, inside the 14.26M budget,
      but V 15.42M. On the fixture it was worse, since its vendored release (cc59d0c) reserves 120,000 gas per
      bind (contracts main: 7,400): 64-entry removes, moves and renames were planned as parts that needed 18.9M
      to 22.2M, over the 2^24 cap, so they could never be sent. Fill `gas.floor` with V;
    - mirror `tools/gas-plan.mjs` (contracts), which reads only the model, and run its shared cases,
      `test/vectors/floor-plan.json` (per schedule: lone negatives, first tags at depth 8 and 64 on new and existing
      positions, a second author's first tags, masks, releases, restores, a registration chunk, create-file
      recipes). Each case gives the largest admitted `k` with E, K, V, the prefix floor, the final reserve and the
      slot counts, and the next `k` with why it is refused (gas or maxActions). The SDK must match every figure;
    - never plan from the kernel's public floor helper: it prices every bind as a first statement, so it is an
      upper bound only;
    - an atomic EIP-5792 batch (several publications, one transaction) packs by the sum of max(E, V) per part, a
      conservative bound, since each call must still find its floor;
    - `eth_estimateGas` on the exact call stays the authority before sending, and the gas limit comes from the
      estimate, never from V;
  - **the posting store's ABI id is now `efs/posting-store/2`** (contracts step 3b amended: `retain` and the
    UNCOUNTED append tag; `/1` before), so the vendored bundle and its generated ABIs bump at this re-vendor. The SDK
    checks no store ABI id today; any check the re-vendor adds takes the id from the release;
  - **word listings re-fold each word** (section 5.2): children and word pages run every listed word through the
    pluggable fold and skip, into `skipped`, any word that isn't its own fold. Built against the `FoldStep`
    plug-in, so it doesn't wait for the fold ruling; tested with both candidates (NFKC_Casefold, and NFC then
    lowercase), including look-alike children registered by raw actions;
  - **gate before any lasting deployment: one Unicode version, one generator.** The chain's refused-character table
    is part of the word Type's id and was built from Unicode 15.1; the SDK's fold evaluation used 18.0. Both must
    come from one pinned version through one generator. Coordinate the generator with the contracts dev once James
    rules on the fold, and add a CI check that the SDK's table and the chain's agree byte for byte.
- **Built first, once confirmed:** `fold` and the link grammar with vectors, then the planners, then the reads.
- **Statement planners:** label, "same as" and "broader" are built (`planLabel`, `planSame`, `planBroader`).
  "Definition" and "moved to" are property keys (`propertyKey("definition")`, `propertyKey("moved-to")`) with no
  planner or read yet.
