# Tag word characters outside ASCII

> **One question is left for the owner (unassigned code points); nothing is built.** Already ruled: the fold is
> NFKC_Casefold (planning fb17a41), and a word's ASCII is exactly `a-z 0-9 - _ .` with no trailing `.` (planning
> 424c1b6). This page evaluates the tag PM's proposal for everything outside ASCII, with the same method as
> [the fold evaluation](../fold-evaluation/README.md): ICU's own data (Unicode 18.0, ICU 79), every code point, plus
> CLDR's per-language letter lists. Vectors are in [`vectors.json`](vectors.json). The tag PM reviewed it (2026-11-26):
> accepted as the basis, with the rules split between the chain and the SDK, and unassigned code points put to the
> owner as two options.

## The choice in one line

**The proposal's classes, plus numbers, six contextual exceptions, a short list of cosmetic refusals, and refused
subdivision flags, in two layers.**
- **The chain** refuses only what no future rule could want inside a stored word. Its table is part of the word
  Type's id, so it can never be loosened.
- **The SDK** carries the exact rule and can loosen it in any release without moving a word id. Older clients just
  hide the newer words.

Whether the chain also refuses code points its Unicode pin doesn't assign is the owner's question:
[two options](#assigned-after-the-pin-two-options).

## The rule, as proposed

After the fold and the fold evaluation's whitespace and refusal steps, each character of a word must be:

- **in ASCII:** `a-z 0-9 - _ .` (ruled);
- **outside ASCII:** a letter (`L*`), a combining mark (`M*`) or a decimal digit (`Nd`) of any script, or an emoji;
- **never:** punctuation (`P*`), math, currency and other symbols (`Sm`, `Sc`, `Sk`, `So`, emoji aside), separators
  (`Z*`) or controls (`C*`).

Shape rules: no trailing `.` (ruled: auto-linkers trim it, so `/inc.` opens `/inc`; this also refuses `.` and `..`),
and no leading `-` (a PM default since 2026-11-26: it keeps `-word` free to mean "not" in link and search syntax).
The chain's other shapes stay: 1–255 bytes, no leading combining mark, not an address (`0x` and 40 hex digits).

| Outside ASCII, after the fold | Code points |
| --- | --- |
| Admitted | 163,522 |
| Refused | 8,786: `So` 5,376, `Sm` 999, `No` 809, `Po` 621, `Nl` 527, `Sk` 120, … |

These count single code points that the early refusals allow, by their class before the fold. A character that folds
to an admitted one is counted as admitted: `Ｔ` (fullwidth) folds to `t`, and `Ⓐ` to `a`.

## What real words it loses

Two sources, in [`vectors.json`](vectors.json):
- every letter CLDR lists for a language's ordinary words (its standard exemplars) or its common foreign words (its
  auxiliary exemplars), for 906 locales, folded as a word would be;
- a curated list of words people type.

| Words | Language | Proposal | Recommended |
| --- | --- | --- | --- |
| `col·lecció`, `coŀlecció` (U+0140 folds to `l·`) | Catalan | refused (U+00B7) | **admitted**: `·` between `l` and `l` |
| `ジョン・スミス`, `ﾊﾘｰ･ﾎﾟｯﾀｰ` (folds to `ハリー・ポッター`) | Japanese foreign names | refused (U+30FB) | **admitted**: `・` between kana or Han |
| `列夫·托尔斯泰`, `列夫・托尔斯泰` | Chinese foreign names | refused (U+00B7, U+30FB) | **admitted**: either dot between Han |
| `צה״ל` (gershayim), `ג׳ירפה` (geresh) | Hebrew | refused (U+05F4, U+05F3) | **admitted** after a Hebrew letter |
| `བོད་ཡིག` (the Tibetan language), `ལྷ་ས` (Lhasa) | Tibetan: every word of two or more syllables | refused (U+0F0B tsheg) | **admitted** after a Tibetan letter |
| `二〇二六` | Chinese and Japanese numerals with `〇` (U+3007, `Nl`) | refused | **admitted**: numbers (`Nl`, `No`) |
| `n⋅h`, `s⋅h` (U+22C5, CLDR's Occitan interior dot) | Occitan | refused (`Sm`) | refused by the SDK, left alone by the chain |
| `s·ciàvo` (U+00B7 between `s` and `c`) | Venetian | refused | refused by the SDK (not `l·l`), left alone by the chain |
| `🏴` with tag characters (England, Scotland, Wales) | subdivision flags | admitted, folded to `🏴` | **refused**: tag characters |
| `don't`, `aujourd'hui`, `l'amour`, `o'brien`, `м'ясо`, `hawai'i` | English, French, Irish, Ukrainian, Hawaiian, typed with `'` | refused (ASCII ruling) | refused |
| `don’t` | any, typed with U+2019 | refused (`Pf`) | refused |
| `donʼt`, `мʼясо`, `hawaiʻi` | typed with U+02BC or U+02BB (modifier letters) | admitted | admitted |
| `डॉ॰`, a Gujarati abbreviation with `૰` | Devanagari and Gujarati abbreviation signs (`Po`) | refused | refused |
| `၏` (a word meaning "of") | Burmese: U+104C–U+104F are word-like but `Po` | refused | refused |
| Kuvi letters written with an ASCII `:` | Kuvi | refused (ASCII ruling) | refused |
| `كتـــاب` (with tatweel U+0640) | Arabic and Persian: cosmetic stretching, which CLDR lists among their letters | admitted | **refused**, as IDNA2008 does |
| `میخواهم`, typed with a ZWNJ (U+200C) after `می` | Persian | admitted: the fold removes the ZWNJ | admitted |

Beyond these, CLDR's lists also hold items that are not word letters, and the rule refuses them: Bengali currency
numerators, Syriac punctuation, Yi radicals and Ethiopic tonal marks. The full list is in `figures.txt`.

**Apostrophes stay refused.** The ASCII ruling refuses `'`, and U+2019 is punctuation. The two orthographic apostrophe
letters, U+02BC (Ukrainian, Belarusian, many Latin-script orthographies) and U+02BB (Hawaiian ʻokina), are letters
and already admitted. A client should say which character was refused and offer the word without it. It should never
rewrite the word silently.

## Contextual exceptions (recommended)

As in IDNA2008 (RFC 5892), each is a character that is only admitted where its language needs it. Each is tested on
the folded word, **by the SDK only**: the chain leaves these characters out of its table, so a later SDK can widen a
context without moving any word id. IDNA's `l·l`-only rule, frozen on chain, would lock out more than Catalan's
neighbours:
- **Occitan:** CLDR lists U+22C5 `⋅` as its interior dot, for `n⋅h` and `s⋅h`.
- **Venetian** (`s·c`), Sardinian and Gaelic, and Chinese and Cantonese names, list U+00B7 among their punctuation.
- **Anii, Gaelic and Cantonese** list U+2027 `‧` (the hyphenation point).

U+22C5 and U+2027 are left to the SDK for the same reason, and the SDK refuses them today.

| Character | Admitted when | IDNA2008 |
| --- | --- | --- |
| U+00B7 `·` middle dot | between `l` and `l` (Catalan), or between two Han characters (Chinese names) | CONTEXTO, Catalan only |
| U+30FB `・` katakana middle dot | between two characters of Hiragana, Katakana or Han, or `ー` | CONTEXTO, anywhere in a label with one of those scripts |
| U+05F3 `׳` geresh, U+05F4 `״` gershayim | after a Hebrew letter | CONTEXTO, the same |
| U+0F0B `་` tsheg | after a Tibetan letter | PVALID, unconditional |
| U+0660–0669 and U+06F0–06F9 | never both sets in one word | CONTEXTO, the same |

The middle dot between Han characters is not in IDNA. It is the standard way to write a foreign name in Chinese, and
a Chinese keyboard types U+00B7. The cost is a lookalike: `列夫.托尔斯泰`, with an ASCII `.`, is admitted too.

Not given an exception:
- apostrophes (above);
- the Greek lower numeral sign U+0375 (numerals, not words);
- Burmese U+104C–U+104F;
- the Devanagari and Gujarati abbreviation signs.
These are small losses, and IDNA2008 refuses them too.

**Recommended refusals beyond the classes:**
- the cosmetic `Lm` characters IDNA2008 also refuses: U+0640 tatweel, U+07FA NKo lajanyalan, U+3031–U+3035 vertical
  kana repeat marks (`〳` looks like `/`), and U+303B;
- the combining overlays drawn as a slash, backslash or vertical line through the letter before them: U+0337,
  U+0338, U+20D2, U+20D3, U+20E5, U+20E6 and U+20EB (`a̸b`).

**Numbers:** admit `Nl` and `No` as well as `Nd`. They are not delimiters, and `〇` needs it. Fractions stay refused
anyway: `½` folds to `1⁄2`, and U+2044 is `Sm`.

## Emoji: the exact property set

**Admit a code point outside ASCII when:**
- it is `Extended_Pictographic` and not `P*`, `Sm`, `Sc` or `Z*`;
- or it is `Regional_Indicator` (the 26 flag letters, U+1F1E6–1F1FF);
- or it is `Emoji_Modifier` (the 5 skin tones, U+1F3FB–1F3FF, which are `Sk`).

The keycap U+20E3 is a combining mark (`Me`), so the keycap `1` + U+FE0F + U+20E3 is admitted as `1⃣` (the fold
removes the variation selector).

- **Not `Emoji`:** it includes ASCII `# * 0-9` (governed by the ASCII rule).
- **Not `Emoji_Presentation`:** it leaves out text-default emoji such as `❤` and `☺`.
- **Refused by the class rule** although `Extended_Pictographic`:
  - `〰` U+3030 (`Pd`, a dash lookalike) and `〽` U+303D (`Po`);
  - the arrows `↔` U+2194, `⤴` U+2934 and `⤵` U+2935 (`Sm`);
  - the squares `◻ ◼ ◽ ◾` U+25FB–25FE (`Sm`);
  - `‼` and `⁉`, which fold to ASCII `!!` and `!?` anyway.
- **What the ruled fold does to emoji:**
  - it removes variation selectors and zero-width joiners, so `❤` with or without its variation selector (U+FE0F) is
    one word, and a family emoji (`👨`, `👩` and `👧` joined by ZWJs, U+200D) becomes three emoji;
  - it would remove tag characters, folding the England, Scotland and Wales flags to a plain `🏴`, a silent change of
    meaning. **So tag characters (U+E0001, U+E0020–E007F) are refused** in the step before the fold, with a reason, as
    the chain already does (class 3). The plain black flag stays admitted.

1,404 `Extended_Pictographic` code points are assigned in 18.0. 1,426 more are reserved, unassigned, for future emoji.

## Lookalikes: what the classes close, and what they can't

Every lookalike the proposal names is refused by class:
- the slashes and backslashes: U+2044, U+2215, U+29F8, U+2216, U+29F5;
- the hyphens and dashes: U+2010–U+2015, and U+2212.

Fullwidth `／` and `－` fold to ASCII `/` (refused) and `-` (admitted). U+2011 folds to U+2010 (refused).

What the classes can't close: about 100 admitted letters, marks, digits and emoji whose confusable skeleton (UTS 39)
is a refused ASCII character. Examples:
- `/`: Katakana `ノ`, Han `丿`;
- `'`: Hebrew `י` and the modifier-letter primes `ʹ ʺ ˈ`;
- `?`: the glottal stop `ʔ`;
- `:`: the Devanagari visarga `ः` and the IPA length mark `ː`;
- `.`: the Arabic-Indic zero `٠`;
- `-`: the `➖` emoji.

Most are ordinary letters of their scripts and can't be refused. They are visual only: a URL or a file system sees
different bytes, so none of them is a delimiter. The defence belongs in display (showing a non-ASCII word as typed,
and mixed-script warnings), not in the chain's grammar. The full list by delimiter is in `figures.txt`.

## Where each rule lives

A refusal on the chain can never be taken back: the table is a constant of the word rule's code, that code is the
word Type's id, and a word's id hashes the Type's id. A refusal in the SDK can be loosened in any release; an older
client then just hides the newer words, as readers hide any word that isn't its own fold.

| Rule | Chain | SDK |
| --- | --- | --- |
| ASCII `a-z 0-9 - _ .` | exact | exact |
| Controls, bidi, invisibles, private use, noncharacters, tag characters, every default-ignorable | refused | refused |
| Punctuation, symbols, separators, format characters (`P*`, `S*` but emoji, `Z*`, `Cf`), assigned at the pin | refused, except the set left to the SDK | refused |
| Cosmetic letters (tatweel and the others), the delimiter overlay marks | refused | refused |
| The contextual characters (U+00B7, U+30FB, U+05F3, U+05F4, U+0F0B) | left alone | in context only |
| Word-internal punctuation some orthography uses (U+22C5 Occitan, U+2027) | left alone | refused for now |
| Items of a language's CLDR letters that the classes refuse | left alone | refused for now |
| Code points the pin doesn't assign | **the owner's question** (below) | refused at the SDK's pin |
| Code points the fold changes (enforcing canonical words on chain) | option for the contracts dev | never produced |

[`left-to-sdk.json`](left-to-sdk.json) is the generator's "left to the SDK" set: 93 code points, each with its class,
why it is left, and the languages whose CLDR letters hold it. It contains:
- the five contextual characters and the two word-internal marks;
- what CLDR lists among languages' letters:
  - Burmese U+104C–U+104F (only U+104F is in CLDR's set);
  - the Devanagari and Gujarati abbreviation signs;
  - Syriac and Shan marks, Bengali currency numerators, Yi radicals and Ethiopic tonal marks.

Format characters (`Cf`) are not left to the SDK, even where CLDR lists them (the Arabic number signs U+0600–U+0603 in
Urdu's letters, U+070F in Syriac's). A format character is never a word's letter, and the chain refuses every one
today.

The tatweel is in Arabic and Persian CLDR letters too. It is refused on chain as a cosmetic letter, as IDNA2008 does,
and that decision is the tag PM's.

## Assigned after the pin: two options

Measured from Unicode 17.0 to 18.0 (Python's UCD 17.0 against ICU's 18.0):

- **13,007 code points were newly assigned.** 12,334 of them are `Lo`.
- **88 of them have a fold that is not themselves:** new case pairs (U+A7DD, U+A7E2, U+AB6C, U+AB6D …) and
  compatibility letters (U+0558, U+209D …).
- **138 of them are punctuation or symbols** the classes refuse (`Sm` 45, `So` 84, `Sc` 3, `Po` 2, `Ps` and `Pe` 2,
  `Sk` 2). They include U+2E62 and U+2E63, new lookalikes of `(` and `)`. Every Unicode version adds punctuation for
  new scripts.

**(i) The chain admits unassigned code points.** This is the working default; the tag PM, the PM and the contracts
dev recommend it, and I agree.
- New scripts and emoji can become words without touching the chain. Only the SDK's pin moves, and that pin moves no
  word id.
- The SDK refuses unassigned code points at its own pin (the fold evaluation's freeze rule). So the 88 fold-changing
  characters and the 138 new marks reach the chain only through a writer that bypasses the SDK.
- Such a word is never its own fold, or breaks the SDK's rule, so readers hide it (tag spec 2.1). Two honest SDKs at
  different pins never give one word two ids.
- The owner's two tests are untouched: every URI-reserved character and EFS delimiter is ASCII, and the chain's ASCII
  rule is exact.

**(ii) The chain refuses unassigned code points.** The chain then holds only what Unicode 18.0 knew, **for the life
of the word Type.** A later pin would change the table, and so the Type's id, every word id and every path id. No
script or emoji assigned after 18.0 could ever be a word.

## The chain's table

The chain checks a folded word against a table of refused code-point ranges. Today's table has 59 ranges. Outside
ASCII:

| What the table refuses | Ranges | Size as 3-byte lo/hi pairs |
| --- | --- | --- |
| (i): the chain's column above, unassigned admitted | 492 | about 3.0 KB |
| (i), plus every assigned code point the fold changes: **the working default** | 1,183 | about 7.1 KB |
| (ii): the working default, also refusing every unassigned code point | 1,440 | about 8.6 KB |

The agreed definition, the three tables, their vectors and a diff against today's table (the new table loosens
nothing) are the contracts' generator inputs, in [`generator/`](generator/README.md). The contracts dev measured the
working default: about 2,110 gas per non-ASCII character against 1,515 today (eleven probes of the table), and the
table is about 7.1 KB without class bytes. An ASCII word pays nothing for it. Refusing every code point the fold changes is safe for good: a folded word never holds one, and the fold of an
assigned code point never changes. It also closes the gap that the chain can't check case outside ASCII. The
storage form (bytecode, a data contract, or the Type's descriptor) is the contracts dev's choice. The chain needs no
contextual code under either option.

## Vectors

[`vectors.json`](vectors.json) has 75 cases. Each has:
- a typed word and its fold;
- the verdict under the proposal and under the recommended SDK rule;
- the first character of the typed word that the chain's table (option (i), the chain's column) refuses. This is the
  word as a writer that skips the fold would send it, so the subdivision flags show the chain refusing tag characters.

A verdict is `null` (admitted) or names its rule:
- `character`, `ascii-character`, `refused-character` or a contextual rule, each with the offending `char` and its
  `class`;
- `trailing-dot`, `leading-hyphen`, `leading-mark`, `length` or `address`;
- `mixed-arabic-indic-digits`.

These are proposals for the refusal codes. The client needs the rule and the character to offer a fixed word.

## Questions

1. **Owner, the only one left:** does the chain admit unassigned code points, (i), or refuse them, (ii)?
2. **Settled by the tag PM (2026-11-26):**
   - the exceptions and numbers as recommended, in the SDK;
   - subdivision flags refused, not folded;
   - no leading `-`;
   - apostrophes refused, with U+02BC and U+02BB admitted as letters;
   - the emoji set as specified.
3. **Contracts dev:** the table under (i), with or without refusing every code point the fold changes, and the refusal
   codes the vectors propose.

## Rerun

- Build `dump.cpp` and `exemplars.cpp` against ICU, and `../fold-evaluation/fold.cpp` as the fold tool. The build
  line is in each file's header.
- Then run `./dump > icu-dump.tsv` and `./exemplars > exemplars.tsv`.
- Then run `python3 -I analyze.py icu-dump.tsv <fold> vectors.json exemplars.tsv [<dir>] > figures.txt`. It also writes
  `left-to-sdk.json` beside `vectors.json`, and with `<dir>` the two candidate chain tables (`ranges-i.txt`,
  `ranges-i-fold.txt`). Format the JSON with Biome (`pnpm exec biome format --write`).
