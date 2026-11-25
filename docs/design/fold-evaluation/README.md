# Folding tag words: NFC + lowercase, or NFKC_Casefold

> **For the owner to decide. Nothing is built.** D-B says "NFC → lowercase". The tag model spec recommends Unicode's
> identifier case folding (NFKC_Casefold) instead. This page compares the two on the same data, with vectors. Once a
> word's id exists on a lasting deployment, the rule can never change.

## The choice in one line

**Recommended: NFKC_Casefold (B).** Things that look the same to people, such as `Ｔｅｓｌａ` and `tesla`, or `ﬁle` and
`file`, get one id instead of two, and Unicode's stability policies cover it. The cost is about 18 KB gzipped,
loaded only by apps that use tags.

## What each rule does to a typed word

Both rules share every step except the fold itself:

1. **Whitespace.**
   - Trim at both ends.
   - A run of whitespace inside a word (spaces, tabs, no-break spaces, ideographic spaces, including any underscores
     touching the run) becomes one `_`.
   - Typed underscores elsewhere are kept as typed: `model__y` and `_tesla` stay as they are.
2. **Refusals (never stripped).**
   - Bidi controls (`U+061C`, `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`).
   - Invisible separators: zero-width space, word joiner, the BOM, soft hyphen, the invisible operators, and the
     Mongolian vowel separator.
   - Controls, unassigned code points (in the pinned Unicode version), private use and noncharacters.
3. **The fold:** A or B.
4. **The chain's word rules:**
   - 1–255 bytes;
   - no `/`;
   - not `.` or `..`;
   - not starting with `~`;
   - not `0x` followed by 40 hex digits. An uppercase `0X…` folds to lowercase first, so it is refused too.

`mercury_(planet)` passes under both: parentheses and underscores are kept, which the `name_(qualifier)` convention
needs.

## Where the rules differ

These counts are for single code points in Unicode 18.0, out of every character the refusals allow.

| B (NFKC_Casefold) folds, A keeps distinct | Code points | Examples (typed → A / B) |
| --- | --- | --- |
| Compatibility forms | 3,830 | `Ｔｅｓｌａ` → `ｔｅｓｌａ` / `tesla`; `ﬁle` → `ﬁle` / `file`; `Ⓐⓑ` → `ⓐⓑ` / `ab`; `x²` → `x²` / `x2`; `Ⅻ` → `ⅻ` / `xii`; Arabic `ﻷ` → `ﻷ` / `لأ` |
| Case folding versus lowercasing | 332 | `Straße` → `straße` / `strasse`; `ΟΔΟΣ` → `οδος` / `οδοσ`; `ſtar` → `ſtar` / `star`; Cherokee `ᏣᎳᎩ` → `ꮳꮃꭹ` / `ᏣᎳᎩ` (both forms of Cherokee meet in one id under either rule) |
| Default-ignorables (joiners, variation selectors) | 384 | `❤️` (with VS16) → `❤️` / `❤`; Persian `می‌خواهم` (with ZWNJ) → kept / joined; emoji `👨‍👩‍👧` → kept / `👨👩👧` |

- **Under A,** `Ｔｅｓｌａ` and `tesla` are two topics. Someone can tag lookalike spam under the fullwidth one, and
  people who type on a CJK keyboard land in a different topic from everyone else. Under B they meet.
- **Under B,** joiners and variation selectors vanish from the id. So `❤️` and `❤` are one topic, and Persian words
  typed with or without the zero-width non-joiner meet. The display name (a label statement) keeps what was typed.
  Under A they would have to be refused, which blocks correct Persian, Indic conjuncts and emoji sequences, or kept,
  which makes invisible differences into different ids.
- **The same under both:**
  - decomposed and precomposed `é`;
  - Hangul jamo and syllables;
  - CJK compatibility ideographs, which NFC already maps;
  - Turkish `İ` (both give `i̇`, with a combining dot);
  - Georgian Mtavruli, which both fold to Mkhedruli.
- **Both are idempotent** on every allowed code point: folding twice changes nothing.

## Stability

- **Normalization (NFC, NFKC) and case folding** are covered by Unicode's stability policies: once a character is
  assigned, its normalized and case-folded forms never change. NFKC_Casefold is built from exactly those.
- **Lowercase mappings are not frozen** by a policy in the same way. A is safe only if the SDK pins its own
  lowercase table, or refuses everything assigned after the pin.
- **Pin one Unicode version and refuse what it doesn't assign.** That rule is the same under both, and it is what
  keeps an id from ever changing. Data versions seen here: ICU 79.1 is Unicode 18.0; Node 24 (ICU 78.3) and Python
  3.15 are 17.0. Node's own `normalize("NFC")` and `toLowerCase()` match ICU on all 297,334 code points assigned in
  17.0.

## Size (gzipped, as embedded in the bundle; behind its own export, so apps without tags pay nothing)

| Table | Gzipped | Needed by |
| --- | --- | --- |
| Allowed code points of the pin (733 ranges) | 1.3 KB | both |
| NFKC_Casefold mappings (6,902 entries) | 17.0 KB | B |
| Lowercase mappings (1,508 entries) | 0.8 KB | A, unless it trusts the engine |
| NFC decompositions and combining classes (2,081 decompositions; Hangul is algorithmic) | 8.2 KB | either, unless it trusts the engine |

- **A** costs about 1.3 KB when it relies on the engine's `normalize` and `toLowerCase`. That is safe only when the
  pin is no newer than the oldest engine the SDK supports. It costs about 10.3 KB when it ships its own tables.
- **B** costs about 18.3 KB when it uses the engine's NFC for the final composition (same condition on the pin), and
  about 26.5 KB fully self-contained. These are upper bounds from a naive encoding; run-length coding of contiguous
  blocks (fullwidth, mathematical alphanumerics) would shrink the mapping table.
- **Recommended:** B, self-contained. It's about 27 KB, it never depends on a browser's Unicode version, and the pin
  can then be the newest version at release.

## Prior art (why neither is copied whole)

- **ENSIP-15** (ENS name normalization) maps much like B, keeps emoji sequences, and adds confusable checks. It can't
  be adopted whole: it allows `_` only at the start of a label and has no parentheses, and D-B and `name_(qualifier)`
  need both.
- **UAX #31** (identifiers) recommends NFKC_Casefold for case-insensitive identifier matching. Its XID character
  classes would refuse parentheses and emoji, so EFS uses its fold but not its character set.
- **UTS #39** (security): mixed-script and confusable detection stay in the client, as warnings (the tag model spec
  already says so). Look-alikes across scripts can't be folded away by either rule.

## Files here

- `vectors.json`: 62 cases, each with rule A's and rule B's output or refusal (15 differ). Generated from ICU's own
  NFKC_Casefold, NFC and lowercase.
- `dump.cpp`, `fold.cpp`, `analyze.py`: the generators (ICU 79.1 and Python 3.15).
- `enginecheck.mjs`: the Node cross-check.
- To rerun: build the two C++ tools against ICU, run `./dump > icu-dump.tsv`, then `python3 analyze.py`.

## What the owner decides

1. **The rule:** A or B (recommended: B).
2. **Joiners and variation selectors:** removed by the fold, which is what B does (recommended), or refused.
3. **The pin:** the newest Unicode version at release, with self-contained tables (recommended), or an older one
   that every supported engine has.
