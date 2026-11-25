# EFS SDK v0.1: folders

[`index.mjs`](index.mjs) creates a folder and a file under a parent, lists the folder, renames the file, then
removes and restores it. CI runs it against a local fixture chain, and every step is asserted. You need Foundry's
`anvil` on PATH, then:

```bash
node tools/pack.mjs --only sdk,fixture && node tools/consumers.mjs --only fixture
```

- **The parent is always named.** There is no default root. The Realm's shared root is only a stand-in parent here;
  real folders will live under an address once homes land.
- **Entries are per author.** You rename, move and remove your own entries. The Lens decides which author's entry a
  name shows, and every planner's review says what this Lens will show afterwards.
- **Remove releases** your entry, so the next author's entry at that name shows. `hide: true` masks the name instead.
  Nothing is destroyed: the file stays reachable by its link, and `planRestoreEntries` puts the entry back.
- **Links outlive renames.** Share files and folders by object link (`~efs/o/<id>`). A path is a lookup: a rename or
  a move can break it.
- **A link says what it is.** A folder's id is its files-directory/1 record, which only its creator can publish; a
  file's id is its subject. `openObject(efs, id)` answers FOLDER (with its owner), FILE (opened under your Lens) or
  ABSENT_PROVEN from that id alone, so a shared link can never open as the wrong kind.

More: [`docs/design/api-0.1.md`](../../docs/design/api-0.1.md), "Folders (0.1)".
