# Word-table inputs for the contracts' generator

Inputs for `TopicWordRule`'s non-ASCII table, from one pinned Unicode version: **Unicode 18.0.0, ICU 79.1** (ICU's
own data for every code point, and CLDR's exemplars as ICU 79.1 ships them). Produced by
[`../analyze.py`](../analyze.py), so they can be regenerated (see [Rerun](#rerun)). Nothing is built from them until
the owner answers the one open question, whether the chain admits unassigned code points. The working default is
option (i), admit.

## The definition (agreed with the contracts dev, 2026-11-26)

The table refuses a scalar `c` in U+0080–U+10FFFF when any of these holds. ASCII is not in the table; the chain's ASCII
rule is its own bitmap.

1. **Noncharacters:** U+FDD0–U+FDEF, and every U+xFFFE and U+xFFFF.
2. **Default-ignorables:** every `Default_Ignorable_Code_Point`, assigned or not. This includes:
   - ZWJ and ZWNJ, the soft hyphen, U+034F, the Hangul fillers, the variation selectors and the Khmer inherent vowels;
   - the reserved slots U+2065, U+FFF0–U+FFF8 and U+E0000–U+E0FFF.
   A folded word never holds one. Rule 2 is kept by name even without rule 6, so that the table never loosens today's.
3. **Never in a stored word:**
   - controls (`Cc`), private use (`Co`) and surrogates (`Cs`);
   - the bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069);
   - the invisibles (U+200B, U+2060–U+2064, U+FEFF, U+00AD, U+180E);
   - the tag characters (U+E0001, U+E0020–U+E007F).
4. **Cosmetic letters and delimiter overlays:**
   - U+0640, U+07FA, U+3031–U+3035 and U+303B;
   - U+0337, U+0338, U+20D2, U+20D3, U+20E5, U+20E6 and U+20EB.
5. **The classes.** `c` is refused when all of these hold:
   - it is assigned at the pin;
   - its general category is none of `L*`, `M*` and `N*`;
   - it is not an emoji;
   - it is not in the set left to the SDK.

   This refuses all assigned `P*`, `S*` (emoji aside), `Z*` and `Cf`.
   - **Emoji** means any of: `Extended_Pictographic` with a category outside `P*`, `Sm`, `Sc` and `Z*`;
     `Regional_Indicator`; or `Emoji_Modifier`.
   - **The set left to the SDK** is [`../left-to-sdk.json`](../left-to-sdk.json), 93 code points:
     - the five contextual characters: U+00B7, U+30FB, U+05F3, U+05F4 and U+0F0B;
     - the word-internal marks U+22C5 (CLDR's Occitan interior dot) and U+2027;
     - every item of a language's CLDR standard or auxiliary exemplars that the classes refuse, except format
       characters (`Cf`). A format character is never a word's letter, and today's table refuses every one.
6. **The fold:** every assigned `c` whose `NFKC_Casefold(c)` is not `c`. A folded word never holds one, and the fold
   of an assigned code point never changes. This is the working default's table. Without rule 6, the table is
   `chain-table-without-fold.txt`.

Everything else is admitted, **unassigned code points included** (option (i)). Should the owner choose option (ii),
the table also refuses every code point Unicode 18.0 leaves unassigned: that is `chain-table-refuse-unassigned.txt`.
The contextual rules are the SDK's alone, so the chain needs no contextual code.

## Files

The tables have one `lo hi` pair of hex scalars per line. Ranges are merged maximal runs, sorted, with ASCII
excluded.

| File | What | Lines | sha-256 |
| --- | --- | --- | --- |
| [`chain-table.txt`](chain-table.txt) | rules 1–6: **the working default** | 1,183 | `4929dd0157b07663ebd5a4aa58335d0b216cb86a537f369e03f1f45a7099ca58` |
| [`chain-table-without-fold.txt`](chain-table-without-fold.txt) | rules 1–5 | 492 | `baaf454b7f2b7190232d562089eedde4450f7a2b0eab93de40f085b7ecc5d93c` |
| [`chain-table-refuse-unassigned.txt`](chain-table-refuse-unassigned.txt) | rules 1–6, plus every unassigned code point: option (ii) | 1,440 | `4f9b1c45ff79ce08ce1770015b70f9beec26e0d5bb514faccab696bcbe560db1` |
| [`table-vectors.txt`](table-vectors.txt) | 3,477 vectors for `chain-table.txt` | 3,478 | `630ba266aad685998f230736aab9a313c5074fbb0404221a75a01f84debb0fbe` |

`table-vectors.txt` holds one vector per line: the word as UTF-8 hex, the expected refusal (7, a scalar of
`chain-table.txt`, or 0, none of it), and why. It has four kinds of vector:
- `a` followed by the first and the last scalar of every range (7). A surrogate is never encoded, so it is skipped.
- `a` followed by the scalar on each side of every range (0).
- `a` followed by each code point left to the SDK (0).
- every curated word of [`../vectors.json`](../vectors.json), both folded and as typed, whose ASCII is all admitted.

A leading `a` keeps the other rules out of the way. 1,699 vectors expect 7, and 1,780 expect 0.

## Against today's table

Today's table is `TopicProfile.REFUSED` (contracts-v2 6d11858, `src/profiles/TopicProfile.sol`), and a word refuses
every class of it. It has 59 ranges and 4,324 scalars.

- **Refused today, admitted by `chain-table.txt`: none.** The new table loosens nothing.
- **Admitted today, refused by `chain-table.txt`:** 152,943 scalars.

| What `chain-table.txt` adds | Scalars |
| --- | --- |
| Private use (`Co`) | 137,468 |
| Symbols: `So` 6,073, `Sm` 998, `Sk` 120, `Sc` 64 | 7,255 |
| Code points the fold changes (rule 6, not refused otherwise) | 5,342 |
| Surrogates (`Cs`; already malformed UTF-8, code 2) | 2,048 |
| Punctuation: `Po` 606, `Ps` 77, `Pe` 75, `Pd` 26, `Pi` 12, `Pf` 10, `Pc` 9 | 815 |
| Cosmetic letters (`Lm`, rule 4) | 8 |
| Delimiter overlays (`Mn`, rule 4) | 7 |

## Rerun

1. Build the ICU tools in [`..`](..): `dump.cpp`, `exemplars.cpp` and `../fold-evaluation/fold.cpp`.
2. Run `./dump > icu-dump.tsv` and `./exemplars > exemplars.tsv`.
3. Run `git show 6d11858:src/profiles/TopicProfile.sol > TopicProfile.sol` in contracts-v2.
4. Run `python3 -I ../analyze.py icu-dump.tsv <fold> ../vectors.json exemplars.tsv . TopicProfile.sol > ../figures.txt`
   in this folder.

The tables must come out byte-identical (the sha-256s above), and `figures.txt` carries the counts.
