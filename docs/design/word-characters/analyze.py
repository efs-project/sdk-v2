#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Word-character evaluation: the tag PM's proposal for word characters outside ASCII (letters, combining marks and
# digits of any script, plus emoji; punctuation, math and currency symbols and separators refused) after the ruled fold
# (NFKC_Casefold), on ICU's data (icu-dump.tsv from dump.cpp) and ICU's string fold (the fold tool built from
# ../fold-evaluation/fold.cpp). Prints the figures README.md quotes and writes vectors.json.
# Usage: python3 -I analyze.py <icu-dump.tsv> <fold binary> <out vectors.json> <exemplars.tsv> [<generator dir>
#        [<TopicProfile.sol>]]
import json, subprocess, sys, unicodedata
from collections import Counter, defaultdict

DUMP, FOLD, OUT, EXEMPLARS = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
GC = {0: "Cn", 1: "Lu", 2: "Ll", 3: "Lt", 4: "Lm", 5: "Lo", 6: "Mn", 7: "Me", 8: "Mc", 9: "Nd", 10: "Nl", 11: "No", 12: "Zs",
      13: "Zl", 14: "Zp", 15: "Cc", 16: "Cf", 17: "Co", 18: "Cs", 19: "Pd", 20: "Ps", 21: "Pe", 22: "Pc", 23: "Po",
      24: "Sm", 25: "Sc", 26: "Sk", 27: "So", 28: "Pi", 29: "Pf"}
seq = lambda x: tuple(int(h, 16) for h in x.split()) if x else ()
U = {}
DI_UNASSIGNED = set()  # unassigned, but Default_Ignorable_Code_Point (reserved inside the default-ignorable blocks)
for line in open(DUMP):
    cp, gc, sc, xp, em, ri, mod, di, cf, sk = line.rstrip("\n").split("\t")
    if gc == "0":
        DI_UNASSIGNED.add(int(cp, 16))
        continue
    U[int(cp, 16)] = dict(gc=GC[int(gc)], sc=sc, xp=xp == "1", em=em == "1", ri=ri == "1", mod=mod == "1",
                          di=di == "1", cf=seq(cf), sk=seq(sk))

# ---- the pipeline shared with the fold evaluation (steps 1, 2 and 4), then the word rules
BIDI = {0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)}
INVISIBLE = {0x200B, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x00AD, 0x180E}
# Tag characters (subdivision flags): refused, never stripped, so a flag is refused with a reason rather than folded
# to a plain black flag (tag PM, 2026-11-26). The chain already refuses them.
TAGS = {0xE0001, *range(0xE0020, 0xE0080)}
WS = {0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F,
      0x3000}
def noncharacter(c): return (0xFDD0 <= c <= 0xFDEF) or (c & 0xFFFE) == 0xFFFE
def refused_early(c):
    u = U.get(c)
    if u is None: return "unassigned"
    if c in BIDI: return "bidi"
    if c in INVISIBLE: return "invisible"
    if c in TAGS: return "tag"
    if u["gc"] in ("Cc", "Co", "Cs") or noncharacter(c): return "control or private use"
    return None
def whitespace(s):
    out, run = [], False
    for ch in s:
        if ord(ch) in WS or (ch == "_" and run):
            run = True
            continue
        if run and out: out.append("_")
        if run and ch == "_": continue
        run = False
        out.append(ch)
    w = "".join(out).strip("_") if False else "".join(out)
    return w
def fold_all(words):
    p = subprocess.run([FOLD], input="\n".join(words) + "\n", capture_output=True, text=True, check=True)
    return [l.split("\t")[0] for l in p.stdout.rstrip("\n").split("\n")]

ASCII_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-_.")
PUNCT = {"Pd", "Ps", "Pe", "Pc", "Po", "Pi", "Pf"}
SEP = {"Zs", "Zl", "Zp"}
def emoji(c, u): return (u["xp"] and u["gc"] not in PUNCT | SEP | {"Sm", "Sc"}) or u["ri"] or u["mod"]
def klass(c, recommended=False):
    """The verdict for one code point after the fold: None when admitted, else the refused class. The proposal admits
    letters, marks, decimal digits and emoji; the recommendation also admits the other numbers (Nl, No)."""
    if c < 0x80: return None if chr(c) in ASCII_OK else "ascii"
    u = U.get(c)
    if u is None: return "unassigned"
    g = u["gc"]
    if g[0] in "LM" or g == "Nd": return None
    if recommended and g in ("Nl", "No"): return None
    if emoji(c, u): return None
    return g

# The recommended additions (README "Contextual exceptions"), each tested on the folded word.
HIRAKANA_HAN = {"Hira", "Kana", "Hani"}
def neighbours(w, i): return (w[i - 1] if i > 0 else None, w[i + 1] if i + 1 < len(w) else None)
def script(ch): return U.get(ord(ch), {}).get("sc") if ch else None
CONTEXT = {
    0x00B7: ("middle-dot", lambda w, i: neighbours(w, i) == ("l", "l")
             or all(ch is not None and script(ch) == "Hani" for ch in neighbours(w, i))),
    0x30FB: ("katakana-middle-dot", lambda w, i: all(
        ch is not None and (script(ch) in HIRAKANA_HAN or ord(ch) == 0x30FC) for ch in neighbours(w, i))),
    0x05F3: ("hebrew-geresh", lambda w, i: i > 0 and script(w[i - 1]) == "Hebr"),
    0x05F4: ("hebrew-gershayim", lambda w, i: i > 0 and script(w[i - 1]) == "Hebr"),
    0x0F0B: ("tibetan-tsheg", lambda w, i: i > 0 and script(w[i - 1]) == "Tibt"),
}
COSMETIC = {0x0640: "arabic-tatweel", 0x07FA: "nko-lajanyalan", **{c: "vertical-kana-repeat" for c in range(0x3031, 0x3036)},
            0x303B: "vertical-ideographic-iteration",
            # combining overlays drawn as a solidus, reverse solidus or vertical line through the letter before
            **{c: "delimiter-overlay" for c in (0x0337, 0x0338, 0x20D2, 0x20D3, 0x20E5, 0x20E6, 0x20EB)}}
ARABIC_INDIC = set(range(0x0660, 0x066A))
EXTENDED_ARABIC_INDIC = set(range(0x06F0, 0x06FA))

def verdict(typed, folded, recommended):
    """Refusal {rule, char?, class?} or None. `recommended`: with the README's contextual exceptions and refusals."""
    w = whitespace(typed)
    for ch in w:
        r = refused_early(ord(ch))
        if r: return {"rule": "refused-character", "char": f"U+{ord(ch):04X}", "class": r}
    f = whitespace(folded)
    for ch in f:
        r = refused_early(ord(ch))
        if r: return {"rule": "refused-character", "char": f"U+{ord(ch):04X}", "class": r}
    b = f.encode("utf-8")
    if not 1 <= len(b) <= 255: return {"rule": "length"}
    for i, ch in enumerate(f):
        c = ord(ch)
        if recommended and c in COSMETIC: return {"rule": COSMETIC[c], "char": f"U+{c:04X}"}
        k = klass(c, recommended)
        if k is None: continue
        if recommended and c in CONTEXT:
            name, ok = CONTEXT[c]
            if ok(f, i): continue
            return {"rule": name, "char": f"U+{c:04X}"}
        return {"rule": "ascii-character" if k == "ascii" else "character", "char": f"U+{c:04X}",
                **({} if k == "ascii" else {"class": k})}
    if recommended and any(ord(ch) in ARABIC_INDIC for ch in f) and any(ord(ch) in EXTENDED_ARABIC_INDIC for ch in f):
        return {"rule": "mixed-arabic-indic-digits"}
    if U.get(ord(f[0]), {}).get("gc", "")[:1] == "M": return {"rule": "leading-mark"}
    if f.endswith("."): return {"rule": "trailing-dot"}
    if f.startswith("-"): return {"rule": "leading-hyphen"}
    if len(f) == 42 and f.startswith("0x") and all(ch in "0123456789abcdef" for ch in f[2:]): return {"rule": "address"}
    return None

# ---- 1. what the proposal admits and refuses, by class, outside ASCII (single code points, after the fold)
print("== Unicode", "18.0 (ICU)", "; Python UCD", unicodedata.unidata_version)
admitted, refused = Counter(), Counter()
for c, u in U.items():
    if c < 0x80 or refused_early(c): continue
    f = u["cf"]
    if not f: continue  # folds to nothing (a default-ignorable)
    ks = [klass(x) for x in f]
    (refused if any(k for k in ks) else admitted)[u["gc"]] += 1
print("admitted by class:", dict(sorted(admitted.items())), "total", sum(admitted.values()))
print("refused by class:", dict(sorted(refused.items())), "total", sum(refused.values()))

# ---- 2. delimiter lookalikes: admitted code points whose UTS 39 skeleton is a character the word rule refuses
DELIMS = "/\\?#%:|<>\"*;',.-@&+=!()[]{}~`^$"
looks = defaultdict(list)
for c, u in U.items():
    if c < 0x80 or refused_early(c) or not u["cf"]: continue
    if any(klass(x) for x in u["cf"]): continue
    sk = "".join(chr(x) for x in u["sk"])
    for d in DELIMS:
        if sk == d or (len(sk) <= 2 and d in sk and all(x == d or x.isalnum() is False for x in sk)):
            looks[d].append(c)
            break
print("admitted delimiter lookalikes (skeleton is the delimiter):")
for d in DELIMS:
    if looks[d]:
        print(f"  {d!r}: {len(looks[d])}:", " ".join(f"U+{c:04X}({U[c]['gc']},{U[c]['sc']})" for c in looks[d][:24]))

# The look-alikes the proposal names: refused, and why.
for c in [0x2044, 0x2215, 0x29F8, 0x2216, 0x29F5, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xFE63,
          0xFF0D, 0xFF0F, 0xFF3C, 0x3030, 0x30FC, 0x4E00, 0x30CE, 0x4E3F, 0x01C0, 0x0338, 0x02D0, 0xA4FD]:
    u = U[c]
    f = "".join(chr(x) for x in u["cf"])
    print(f"  U+{c:04X} {u['gc']} {u['sc']} folds to {' '.join(f'U+{x:04X}' for x in u['cf'])}: "
          f"{'admitted' if not any(klass(x) for x in u['cf']) else 'refused'}; skeleton {' '.join(f'U+{x:04X}' for x in u['sk'])}")

# ---- 3. emoji
xp = [c for c, u in U.items() if u["xp"] and c >= 0x80]
conf = [c for c in xp if U[c]["gc"] in PUNCT | SEP | {"Sm", "Sc"}]
fold_away = [c for c in xp if U[c]["cf"] != (c,)]
print("Extended_Pictographic assigned (non-ASCII):", len(xp), "; of them P*/Sm/Sc/Z* (refused):",
      " ".join(f"U+{c:04X}({U[c]['gc']})" for c in conf))
print("  fold to something else:", " ".join(f"U+{c:04X}->{''.join(chr(x) for x in U[c]['cf'])}" for c in fold_away))
em_not_xp = [c for c, u in U.items() if u["em"] and not u["xp"] and c >= 0x80]
print("Emoji but not Extended_Pictographic (non-ASCII):", len(em_not_xp), "classes",
      dict(Counter(U[c]["gc"] for c in em_not_xp)), "RI", sum(U[c]["ri"] for c in em_not_xp), "modifiers",
      sum(U[c]["mod"] for c in em_not_xp))
print("Emoji ASCII:", "".join(chr(c) for c, u in U.items() if u["em"] and c < 0x80))

# ---- 4. after the pin: what Unicode 18 assigned that 17 did not (Python's UCD is 17.0)
new = [c for c in U if unicodedata.category(chr(c)) == "Cn" and U[c]["gc"] not in ("Co", "Cs")]
by = Counter(U[c]["gc"] for c in new)
newly_refused = [c for c in new if klass(c)]
changes = [c for c in new if U[c]["cf"] != (c,)]
print("assigned in 18.0, not 17.0:", len(new), dict(sorted(by.items())))
print("  of them refused by the proposal's classes:", len(newly_refused), dict(Counter(U[c]["gc"] for c in newly_refused)))
print("  of them with NFKC_Casefold(c) != c:", len(changes), " ".join(f"U+{c:04X}({U[c]['gc']})" for c in changes[:20]))

sym18 = [c for c in new if U[c]["gc"] in ("Sm", "So", "Sk", "Sc") or U[c]["gc"] in PUNCT]
print("  new symbols and punctuation whose skeleton is an ASCII delimiter:",
      " ".join(f"U+{c:04X}({U[c]['gc']})->{''.join(chr(x) for x in U[c]['sk'])!r}" for c in sym18
               if len(U[c]["sk"]) == 1 and U[c]["sk"][0] < 0x80 and chr(U[c]["sk"][0]) in DELIMS) or "(none)")

# ---- 4a. the chain's table: ranges of code points a folded word may not hold, outside ASCII
def ranges_of(pred):
    out, start = 0, None
    for c in range(0x80, 0x110000):
        if pred(c):
            if start is None: start = c
        elif start is not None:
            out += 1; start = None
    return out + (start is not None)
def refused_rec(c):
    u = U.get(c)
    if u is None or refused_early(c): return True
    if c in COSMETIC: return True
    return klass(c, True) is not None and c not in CONTEXT
def not_canonical(c):
    u = U.get(c)
    return u is not None and u["cf"] != (c,)
for name, pred in [("refused (recommended, unassigned included)", refused_rec),
                   ("refused (recommended, unassigned admitted)", lambda c: c in U and refused_rec(c)),
                   ("refused or changed by the fold", lambda c: refused_rec(c) or not_canonical(c))]:
    n = ranges_of(pred)
    print(f"  chain table, {name}: {n} ranges (about {n * 6:,} bytes as 3-byte lo/hi pairs)")

# ---- 4b. CLDR exemplars: the letters each language's ordinary words (standard) and common foreign words (auxiliary)
# use, folded as a word would be; any refused item is a real-word loss for that language.
items = []
for line in open(EXEMPLARS):
    loc, kind, hx = line.rstrip("\n").split("\t")
    if kind in ("standard", "auxiliary"): items.append((loc, kind, "".join(chr(int(h, 16)) for h in hx.split())))
uniq = sorted({it for _, _, it in items})
fmap = dict(zip(uniq, fold_all(uniq)))
for rec in (False, True):
    lost = defaultdict(set)
    for loc, kind, it in items:
        f = fmap[it]
        bad = [ch for ch in f if (klass(ord(ch), rec) is not None and not (rec and ord(ch) in CONTEXT))
               or (rec and ord(ch) in COSMETIC)]
        if bad: lost[(it, f, bad[0])].add(f"{loc}:{kind[0]}")
    print(f"exemplar items refused ({'recommended' if rec else 'proposal'}): {len(lost)}")
    for (it, f, ch), locs in sorted(lost.items(), key=lambda kv: -len(kv[1])):
        langs = sorted({l.split(':')[0].split('_')[0] for l in locs})
        print(f"  {it!s} (U+{' U+'.join(f'{ord(x):04X}' for x in it)}) folds to {f!s}: U+{ord(ch):04X} {U[ord(ch)]['gc'] if ord(ch) in U else '?'};"
              f" {len(langs)} languages: {' '.join(langs[:18])}{' …' if len(langs) > 18 else ''}")
# The punctuation exemplars that the recommended contextual exceptions admit, by language.
for c in sorted(CONTEXT):
    langs = sorted({loc.split("_")[0] for loc, kind, it in
                    [(l.split("\t")[0], l.split("\t")[1], l.rstrip("\n").split("\t")[2]) for l in open(EXEMPLARS)]
                    if kind == "punctuation" and it == f"{c:04X}"})
    print(f"  U+{c:04X} {CONTEXT[c][0]} in the punctuation exemplars of: {' '.join(langs) or '(none)'}")

# ---- 4c. where each rule lives (tag PM, 2026-11-26): the chain refuses only what no future rule could want inside a
# stored word, and admits unassigned code points (its table is part of the word Type's id, so it can never be re-pinned);
# the SDK carries the exact rule and can loosen it in any release. Left to the SDK: the contextual characters, word-
# internal punctuation some orthography uses, and every letter-set exemplar item the class rule refuses.
WORD_INTERNAL = {0x22C5: "Occitan interior dot (CLDR oc)", 0x2027: "hyphenation point (CLDR blo, gd, yue)"}
left = {}
for loc, kind, it in items:
    for ch in fmap[it]:
        c = ord(ch)
        # a format character (Cf) is never a stored word's letter, and the chain refuses every one today
        if c >= 0x80 and c in U and klass(c, True) is not None and c not in COSMETIC and U[c]["gc"] != "Cf":
            left.setdefault(c, set()).add(loc.split("_")[0])
for c in list(CONTEXT) + list(WORD_INTERNAL):
    left.setdefault(c, set())
def chain_refuses(c):
    """The chain's table (default): early refusals, then assigned code points the classes refuse, outside the set
    left to the SDK, and the cosmetic letters and overlay marks. Unassigned code points are admitted."""
    if c < 0x80: return chr(c) not in ASCII_OK
    if noncharacter(c): return True  # unassigned by category (Cn), refused for good (chain class 5)
    if c in DI_UNASSIGNED: return True  # reserved default-ignorables, refused today (classes 3 and 4)
    u = U.get(c)
    if u is None: return False
    if u["di"]: return True  # every default-ignorable, letters and marks among them: a folded word never holds one
    if refused_early(c): return True
    if c in COSMETIC: return True
    return klass(c, True) is not None and c not in left
print("left to the SDK:", len(left), "code points")
for c in sorted(left):
    note = CONTEXT.get(c, (None,))[0] or WORD_INTERNAL.get(c) or ""
    print(f"  U+{c:04X} {U[c]['gc']} {U[c]['sc']} {note} {' '.join(sorted(left[c]))}")
json.dump({"schema": "efs-sdk/word-characters-left-to-sdk/1", "unicode": "18.0.0 (ICU 79)",
           "note": "Code points the chain's table leaves alone and the SDK's word rule decides: the contextual "
                   "characters, word-internal punctuation some orthography uses, and every item of a language's CLDR "
                   "standard or auxiliary exemplars that the class rule refuses. The SDK refuses them today (the "
                   "contextual ones outside their context) and can admit one later without moving any word id.",
           "codePoints": [{"cp": f"U+{c:04X}", "gc": U[c]["gc"], "script": U[c]["sc"],
                           "why": CONTEXT.get(c, (None,))[0] or WORD_INTERNAL.get(c) or "CLDR letters",
                           "languages": sorted(left[c])} for c in sorted(left)]},
          open(OUT.replace("vectors.json", "left-to-sdk.json"), "w"), ensure_ascii=False, indent=1)
def ranges_list(pred):
    out, start = [], None
    for c in range(0x80, 0x110000):
        if pred(c):
            if start is None: start = c
        elif start is not None:
            out.append((start, c - 1)); start = None
    if start is not None: out.append((start, 0x10FFFF))
    return out
def chain_refuses_fold(c): return chain_refuses(c) or (c in U and U[c]["cf"] != (c,))
for name, pred in [("default (unassigned admitted)", lambda c: chain_refuses(c)),
                   ("plus every assigned code point the fold changes", chain_refuses_fold)]:
    n = ranges_of(lambda c, p=pred: p(c))
    print(f"  chain table under the two-layer rule, {name}: {n} ranges (about {n * 6:,} bytes as 3-byte pairs)")

# ---- 5. vectors
CASES = [
    # [typed, note]
    ("col·lecció", "Catalan, U+00B7 between l and l"), ("coŀlecció", "Catalan, U+0140 (folds to l + U+00B7)"),
    ("paral·lel", "Catalan"), ("a·b", "U+00B7 outside l·l"),
    ("ジョン・スミス", "Japanese foreign name, U+30FB"), ("ﾊﾘｰ･ﾎﾟｯﾀｰ", "halfwidth katakana and U+FF65 (fold to U+30FB)"),
    ("列夫·托尔斯泰", "Chinese foreign name with U+00B7"), ("列夫・托尔斯泰", "Chinese foreign name with U+30FB"),
    ("a・b", "U+30FB between Latin letters"),
    ("צה״ל", "Hebrew acronym, gershayim U+05F4"), ("ג׳ירפה", "Hebrew, geresh U+05F3"),
    ("צה\"ל", "Hebrew acronym typed with ASCII \""), ("a׳", "geresh after Latin"),
    ("བོད་ཡིག", "Tibetan, tsheg U+0F0B"), ("ལྷ་ས", "Tibetan, Lhasa"),
    ("don't", "ASCII apostrophe"), ("don’t", "U+2019"), ("donʼt", "U+02BC modifier letter apostrophe"),
    ("aujourd'hui", "French"), ("l'amour", "French"), ("o'brien", "Irish name"),
    ("м'ясо", "Ukrainian, ASCII apostrophe"), ("мʼясо", "Ukrainian, U+02BC"),
    ("hawaiʻi", "Hawaiian, okina U+02BB"), ("hawai'i", "Hawaiian, ASCII apostrophe"),
    ("كتاب", "Arabic"), ("كتـــاب", "Arabic with tatweel U+0640"),
    ("می‌خواهم", "Persian with ZWNJ (the fold removes it)"), ("डॉ॰", "Devanagari abbreviation sign U+0970"),
    ("٤٥", "Arabic-Indic digits"), ("٤۵", "mixed Arabic-Indic and extended Arabic-Indic digits"),
    ("二〇二六", "CJK numerals with U+3007 (Nl)"), ("Ⅻ", "Roman numeral (folds to xii)"),
    ("🎉", "emoji"), ("❤️", "emoji with VS16 (the fold removes it)"), ("👍🏽", "emoji with a skin tone"),
    ("🇺🇸", "flag (regional indicators)"), ("👨‍👩‍👧", "ZWJ sequence (the fold removes the joiners)"),
    ("1️⃣", "keycap"), ("©", "copyright sign"), ("™", "trade mark (folds to tm)"), ("〰", "wavy dash U+3030 (emoji, Pd)"),
    ("↔", "left right arrow U+2194 (emoji, Sm)"), ("🏴", "black flag"),
    ("🏴\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F", "Scotland flag (tag characters: refused)"),
    ("🏴\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F", "England flag (tag characters: refused)"),
    ("🏴\U000E0067\U000E0062\U000E0077\U000E006C\U000E0073\U000E007F", "Wales flag (tag characters: refused)"),
    ("n⋅h", "Occitan interior dot U+22C5 (Sm)"), ("s·ciàvo", "Venetian, U+00B7 between s and c"),
    ("c♯", "music sharp U+266F (So)"), ("25℃", "folds to 25°c"), ("€uro", "euro sign (Sc)"), ("½", "folds to 1⁄2"),
    ("x²", "folds to x2"), ("µm", "micro sign (folds to μ)"),
    ("a⁄b", "fraction slash U+2044"), ("a∕b", "division slash U+2215"), ("a⧸b", "big solidus U+29F8"),
    ("a∖b", "set minus U+2216"), ("a⧵b", "reverse solidus operator U+29F5"), ("e‐mail", "hyphen U+2010"),
    ("e‑mail", "non-breaking hyphen U+2011 (folds to U+2010)"), ("a－b", "fullwidth hyphen-minus (folds to -)"),
    ("a／b", "fullwidth solidus (folds to /)"), ("aノb", "katakana no U+30CE, a slash lookalike"),
    ("aǀb", "U+01C0 dental click, a | lookalike"), ("aːb", "U+02D0 length mark, a : lookalike"),
    ("a̸b", "U+0338 combining long solidus overlay"),
    ("inc.", "trailing dot"), (".net", "leading dot"), ("-x", "leading hyphen"), ("x-", "trailing hyphen"),
    ("c++", "ASCII +"), ("mercury_(planet)", "ASCII parentheses"), ("node.js", "ASCII dot inside"),
]
folded = fold_all([t for t, _ in CASES])
vectors = []
for (typed, note), f in zip(CASES, folded):
    # what the chain's table refuses of the typed word as a writer that skips the fold would send it
    chain = next(({"char": f"U+{ord(ch):04X}"} for ch in whitespace(typed) if chain_refuses(ord(ch))), None)
    vectors.append({"typed": typed, "note": note, "folded": whitespace(f), "proposal": verdict(typed, f, False),
                    "recommended": verdict(typed, f, True), "chainTable": chain})
text = json.dumps({"schema": "efs-sdk/word-characters-evaluation/1", "unicode": "18.0.0 (ICU 79)",
                   "note": "Typed word, its fold (NFKC_Casefold after the whitespace step), and the verdict under the "
                           "proposal and under the recommended SDK rule (null: admitted), and the first character of the "
                           "typed word (as a writer that skips the fold would send it) that the chain's table refuses "
                           "(null: none; the chain also applies its shape rules). "
                           "Invisible characters are written as escapes.",
                   "vectors": vectors}, ensure_ascii=False, indent=1)
def visible(ch):
    """JSON text with its invisible characters (format and default-ignorable) escaped."""
    u = U.get(ord(ch))
    if u is None or not (u["gc"] == "Cf" or u["di"]): return ch  # json.dumps already escapes controls
    b = ch.encode("utf-16-be")
    return "".join(f"\\u{b[i] << 8 | b[i + 1]:04x}" for i in range(0, len(b), 2))
open(OUT, "w").write("".join(visible(ch) for ch in text) + "\n")
for v in vectors:
    p, r = v["proposal"], v["recommended"]
    fmt = lambda x: "ok" if x is None else f"{x['rule']}{' ' + x['char'] if 'char' in x else ''}{' ' + x['class'] if 'class' in x else ''}"
    print(f"  {v['typed']!s:22} -> {v['folded']!s:20} proposal: {fmt(p):34} recommended: {fmt(r)}")

# ---- 6. the generator's inputs, and today's table against them
if len(sys.argv) > 5:  # the generator's inputs (generator/README.md says what each file is)
    GEN = sys.argv[5]
    table = ranges_list(chain_refuses_fold)
    open(f"{GEN}/chain-table.txt", "w").write("".join(f"{a:04X} {b:04X}\n" for a, b in table))
    open(f"{GEN}/chain-table-without-fold.txt", "w").write(
        "".join(f"{a:04X} {b:04X}\n" for a, b in ranges_list(chain_refuses)))
    # Option (ii), should the owner choose it: the same table, also refusing every code point Unicode 18.0 leaves
    # unassigned.
    open(f"{GEN}/chain-table-refuse-unassigned.txt", "w").write(
        "".join(f"{a:04X} {b:04X}\n" for a, b in ranges_list(lambda c: chain_refuses_fold(c) or c not in U)))
    # The table's vectors: "a" then one code point (a leading "a" keeps every other rule out of the way), as UTF-8 hex,
    # and the expected refusal: 7 (a scalar of the table) or 0. Each range's first and last scalar, its neighbours
    # outside it, every code point left to the SDK, and the curated words whose ASCII is all admitted.
    SURR = range(0xD800, 0xE000)
    lines, seen = [], set()
    def add(word, code, why):
        h = word.encode("utf-8").hex()
        if h in seen: return
        seen.add(h)
        lines.append(f"{h} {code} {why}\n")
    def one(c): return "a" + chr(c)
    for a, b in table:
        lo = a if a not in SURR else max(a, 0xE000)
        hi = b if b not in SURR else min(b, 0xD7FF)
        for c in sorted({lo, hi}):
            if a <= c <= b and c not in SURR: add(one(c), 7, f"U+{c:04X} first or last of {a:04X}-{b:04X}")
        for c in (a - 1, b + 1):
            if 0x80 <= c <= 0x10FFFF and c not in SURR and not chain_refuses_fold(c):
                add(one(c), 0, f"U+{c:04X} beside {a:04X}-{b:04X}")
    for c in sorted(left): add(one(c), 0, f"U+{c:04X} left to the SDK")
    for (typed, note), f in zip(CASES, folded):
        for w, form in ((whitespace(f), "folded"), (whitespace(typed), "typed")):
            if not w or any(ord(ch) < 0x80 and ch not in ASCII_OK for ch in w) or len(w.encode()) > 255: continue
            bad = next((ch for ch in w if chain_refuses_fold(ord(ch))), None)
            add(w, 7 if bad else 0, f"{form}: {note}" + (f" (U+{ord(bad):04X})" if bad else ""))
    open(f"{GEN}/table-vectors.txt", "w").write(
        "# <word as UTF-8 hex> <expected: 7 a scalar of chain-table.txt, 0 none of it> <why>\n" + "".join(lines))
    print("generator: chain-table.txt", len(table), "ranges;", "table-vectors.txt", len(lines), "vectors")
if len(sys.argv) > 6:  # today's table (contracts src/profiles/TopicProfile.sol REFUSED), against the new one
    import re
    today = {}
    for lo, hi, cls in re.findall(r'hex"([0-9a-f]{6})([0-9a-f]{6})([0-9a-f]{2})"', open(sys.argv[6]).read()):
        for c in range(int(lo, 16), int(hi, 16) + 1): today[c] = int(cls, 16)
    loosened = sorted(c for c in today if c >= 0x80 and not chain_refuses_fold(c))
    tightened = Counter()
    for c in range(0x80, 0x110000):
        if chain_refuses_fold(c) and c not in today:
            u = U.get(c)
            why = ("unassigned" if u is None else "fold changes it" if (u["cf"] != (c,) and not chain_refuses(c))
                   else u["gc"])
            tightened[why] += 1
    print("today's table:", len(set(re.findall(r'hex"([0-9a-f]{14})"', open(sys.argv[6]).read()))), "ranges,",
          len(today), "scalars")
    print("  refused today, admitted by chain-table.txt:", len(loosened),
          " ".join(f"U+{c:04X}({U[c]['gc'] if c in U else 'unassigned'})" for c in loosened[:40]))
    print("  admitted today, refused by chain-table.txt, by class:", dict(sorted(tightened.items())),
          "total", sum(tightened.values()))
