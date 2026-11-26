# EFS SDK v0.1: homes, tags and names

[`index.mjs`](index.mjs) puts a file in your home, tags it into a topic, names the topic, and reads it all back as a
person sees it. CI runs it against a local fixture chain, and every step is asserted. You need Foundry's `anvil` on
PATH, then:

```bash
node tools/pack.mjs --only sdk,fixture && node tools/consumers.mjs --only fixture
```

What trips people up:

- **Words are checked as given.** The chain's word grammar refuses ASCII uppercase, spaces and controls, so `"Notes"`
  is MISUSE before anything is read. Until the fold rule is ruled, fold what people type yourself and pass the
  result (or pass a `fold` step to the planners and reads). A topic is its path of words: `/cars/tesla` and
  `/people/tesla` are different topics, and `/tesla` (the word's page) shows every place the word is used.
- **A page is not a list.** `topicItems`, `lensTagsOf` and the directory reads say `finished: true` only when the chain
  said the list ended. A short or empty page with `finished: false` means "read on with `next`", never "that's all".
- **Absent is proven, unknown is not.** A word nobody has used is `ABSENT_PROVEN` (`wordPage`), so say "no tag uses it
  yet". UNKNOWN means the read failed: say you can't tell right now, never "none".
- **Two tiers, two reads.** `topicItems` and `lensTagsOf` give each row a `decider`: a Lens author (with their number),
  or the public tier (someone says yes, nobody in your Lens has a stance). Label the public tier and hold back its
  media. `tagsOf` is the unfiltered list (every place anyone filed the thing, rows nobody says yes to included).
- **"subject" is not "file".** Each `topicItems` row has a `kind` (and a record's `typeId`). A created subject is
  `subject`, a file or another app's subject, until you ask for the exact tier (`kindsExact: true`, or `"file"` in
  `kinds`), which reads its HEAD. The SDK applies a `kinds` filter itself, so a short filtered page with
  `finished: false` still means "read on".
- **Synonyms merge only when you ask.** `topicItems` reads one topic. `topicItemsMerged` adds the Lens's synonyms
  (never a stranger's), and each row names its list (`via`). Its `missing` is never absent: when it isn't empty,
  say how many synonyms couldn't be read, never "that's everything".
- **A tag has no name.** A file shown in a topic takes its name from where it is placed (`fileNames`): its tagger's
  own entry, then its creator's, then the first from the Lens. `complete: false` means a missing name is not proven.
- **Labels are per language.** `planLabel` keys a label by its BCP 47 tag, lowercased (`"EN"` and `"en"` are one).
  `topicName` tries the reader's languages in order, and falls back to the word itself (`source: "none"`).
- **A home's owner moves.** `openHome` reads the address's own identity at one block: a key account's address
  (an EIP-7702 account with the standard designator included), a contract's Realm principal (a Safe's home shows the
  Safe's own entries). It changes when contract code is deployed at the address (a counterfactual Safe) or removed,
  so read it with the home and never cache it across reads.
- **Show people, not ids.** `efs.lens.displayOf(principal)` gives the checksummed address of a key principal, and a
  contract's address only for one you name in `contracts`.
- **Every save names what it touched.** A tag, label or folder save's `effect` (`tags.tag`, `tags.label`,
  `files.create`, …) is on its record and survives a reload, so hold and re-list by it, not by the whole account.

More: [`docs/design/tags-0.1.md`](../../docs/design/tags-0.1.md) (the model, the reads and their laws) and
[`docs/design/api-0.1.md`](../../docs/design/api-0.1.md) (every reason code).
