# Tag word characters outside ASCII

> **For the owner and the contracts dev to decide. Nothing is built.** Already ruled: the fold is NFKC_Casefold
> (planning fb17a41), and a word's ASCII is exactly `a-z 0-9 - _ .` with no trailing `.` (planning 424c1b6). This
> page evaluates the tag PM's proposal for everything outside ASCII, with the same method as
> [the fold evaluation](../fold-evaluation/README.md): ICU's own data (Unicode 18.0, ICU 79), every code point, plus
> CLDR's per-language letter lists. Vectors are in [`vectors.json`](vectors.json).

## The choice in one line

**Recommended: the proposal's classes, plus numbers, six contextual exceptions and a short list of cosmetic
refusals. The chain should refuse what its Unicode pin doesn't assign, rather than admit it.** Admitting unassigned
code points would let scripts and emoji assigned later work at once. But Unicode 18.0 alone assigned 88 characters
whose fold is not themselves, so admitting them early gives two ids to one word. It would also admit new
punctuation and symbols the rule refuses: 138 more in 18.0.

## The rule, as proposed

After the fold and the fold evaluation's whitespace and refusal steps, each character of a word must be:

- **in ASCII:** `a-z 0-9 - _ .` (ruled);
- **outside ASCII:** a letter (`L*`), a combining mark (`M*`) or a decimal digit (`Nd`) of any script, or an emoji;
- **never:** punctuation (`P*`), math, currency and other symbols (`Sm`, `Sc`, `Sk`, `So`, emoji aside), separators
  (`Z*`) or controls (`C*`).

Shape rules: no trailing `.` (ruled: auto-linkers trim it, so `/inc.` opens `/inc`; this also refuses `.` and `..`),
and no leading `-` (proposed). The chain's other shapes stay: 1–255 bytes, no leading combining mark, not an address
(`0x` and 40 hex digits).

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
| `don't`, `aujourd'hui`, `l'amour`, `o'brien`, `м'ясо`, `hawai'i` | English, French, Irish, Ukrainian, Hawaiian, typed with `'` | refused (ASCII ruling) | refused |
| `don’t` | any, typed with U+2019 | refused (`Pf`) | refused |
| `donʼt`, `мʼясо`, `hawaiʻi` | typed with U+02BC or U+02BB (modifier letters) | admitted | admitted |
| `डॉ॰`, a Gujarati abbreviation with `૰` | Devanagari and Gujarati abbreviation signs (`Po`) | refused | refused |
| `၏` (a word meaning "of") | Burmese: U+104C–U+104F are word-like but `Po` | refused | refused |
| Kuvi letters written with an ASCII `:` | Kuvi | refused (ASCII ruling) | refused |
| `كتـــاب` (with tatweel U+0640) | Arabic and Persian: cosmetic stretching, which CLDR lists among their letters | admitted | **refused**, as IDNA2008 does |
| `می‌خواهم` (with ZWNJ) | Persian | admitted: the fold removes the ZWNJ | admitted |

Beyond these, CLDR's lists also hold items that are not word letters, and the rule refuses them: Bengali currency
numerators, Syriac punctuation, Yi radicals and Ethiopic tonal marks. The full list is in `figures.txt`.

**Apostrophes stay refused.** The ASCII ruling refuses `'`, and U+2019 is punctuation. The two orthographic apostrophe
letters, U+02BC (Ukrainian, Belarusian, many Latin-script orthographies) and U+02BB (Hawaiian ʻokina), are letters
and already admitted. A client should say which character was refused and offer the word without it. It should never
rewrite the word silently.

## Contextual exceptions (recommended)

As in IDNA2008 (RFC 5892), each is a character that is only admitted where its language needs it. Each is tested on
the folded word.

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

The keycap U+20E3 is a combining mark (`Me`), so `1️⃣` is admitted as `1⃣`.

- **Not `Emoji`:** it includes ASCII `# * 0-9` (governed by the ASCII rule).
- **Not `Emoji_Presentation`:** it leaves out text-default emoji such as `❤` and `☺`.
- **Refused by the class rule** although `Extended_Pictographic`:
  - `〰` U+3030 (`Pd`, a dash lookalike) and `〽` U+303D (`Po`);
  - the arrows `↔` U+2194, `⤴` U+2934 and `⤵` U+2935 (`Sm`);
  - the squares `◻ ◼ ◽ ◾` U+25FB–25FE (`Sm`);
  - `‼` and `⁉`, which fold to ASCII `!!` and `!?` anyway.
- **What the ruled fold does to emoji:**
  - it removes variation selectors and zero-width joiners, so `❤️` and `❤` meet, and `👨‍👩‍👧` becomes three emoji;
  - **it removes tag characters, so the England, Scotland and Wales flags all fold to `🏴`, one word.** The display
    name, a label statement, can keep what was typed. This is a consequence of the ruled fold, flagged for the
    owner.

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

## Assigned after the pin: refuse, don't admit

The proposal makes the chain's rule a deny-list outside ASCII, so that scripts and emoji assigned after the pin
still work. Measured from Unicode 17.0 to 18.0 (Python's UCD 17.0 against ICU's 18.0):

- **13,007 code points were newly assigned.** 12,334 of them are `Lo`.
- **88 of them have a fold that is not themselves:** new case pairs (U+A7DD, U+A7E2, U+AB6C, U+AB6D …) and
  compatibility letters (U+0558, U+209D …). Suppose a chain pinned at 17.0 had admitted them while unassigned. A
  word typed with the capital form is then not canonical once 18.0 assigns it, so one word has two ids. That is what
  the fold exists to prevent.
- **138 of them are punctuation or symbols** the rule refuses (`Sm` 45, `So` 84, `Sc` 3, `Po` 2, `Ps` and `Pe` 2,
  `Sk` 2). A deny-list frozen at 17.0 would admit them all, including U+2E62 and U+2E63, new lookalikes of `(` and
  `)`. Every Unicode version adds punctuation for new scripts.

So the chain should refuse every code point its pin doesn't assign, as the fold evaluation's freeze rule already says
for the SDK. New scripts and emoji then arrive with a pin upgrade, which the fold evaluation's CI check guards (old
vectors give the same words).

**Option (not recommended):** admit the reserved, unassigned `Extended_Pictographic` ranges early, so future emoji
work before a pin upgrade. Emoji rarely have fold mappings, but 22 assigned ones do (`™` to `tm`, `🈁` to `ココ`,
`㊗` to `祝` …), and those enclosed ideographs sit in blocks with reserved slots. So this is not safe in principle.

## The chain's table

The chain checks a folded word against a table of refused code-point ranges. Today's table has 59 ranges. Under the
recommended rule, outside ASCII:

| What the table refuses | Ranges | Size as 3-byte lo/hi pairs |
| --- | --- | --- |
| The recommended classes and refusals, plus everything the pin doesn't assign | 982 | about 5.9 KB |
| The same, admitting unassigned code points | 483 | about 2.9 KB |
| The first, plus every code point the fold changes (enforcing canonical words on chain) | 1,438 | about 8.6 KB |

The contextual exceptions are checked by code, not by the table: four characters, each against its neighbour's
script, and a digit-set check. The storage form (bytecode, a data contract, or the Type's descriptor) is the
contracts dev's choice.

## Vectors

[`vectors.json`](vectors.json) has 70 cases. Each is a typed word, its fold, and the verdict under the proposal and
under the recommendation. A verdict is `null` (admitted) or names its rule:
- `character`, `ascii-character` or a contextual rule, each with the offending `char` and its `class`;
- `trailing-dot`, `leading-hyphen`, `leading-mark`, `length` or `address`;
- `mixed-arabic-indic-digits`.

These are proposals for the chain's refusal codes. The client needs the rule and the character to offer a fixed word.

## Questions

1. **Owner:** the five contextual exceptions and the middle dot between Han characters (yes, recommended). Also,
   numbers (`Nl`, `No`): admit them (recommended)?
2. **Owner:** refuse unassigned code points at the pin (recommended), or admit them for early emoji and scripts?
3. **Owner:** the England, Scotland and Wales flags fold to one word. Keep that as the ruled fold's consequence, or
   refuse tag characters in words instead, so subdivision flags can't be used as words?
4. **Contracts dev:** the table size above, and the refusal codes the vectors propose.

## Rerun

- Build `dump.cpp` and `exemplars.cpp` against ICU, and `../fold-evaluation/fold.cpp` as the fold tool. The build
  line is in each file's header.
- Then run `./dump > icu-dump.tsv` and `./exemplars > exemplars.tsv`.
- Then run `python3 -I analyze.py icu-dump.tsv <fold> vectors.json exemplars.tsv > figures.txt`, and format
  `vectors.json` with Biome (`pnpm exec biome format --write`).
