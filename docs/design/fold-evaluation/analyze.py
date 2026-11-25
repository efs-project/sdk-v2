#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Fold evaluation: NFC + lowercase (rule A) against NFKC_Casefold (rule B), on ICU's data (icu-dump.tsv).
# Prints table sizes, idempotence, where the rules differ, and writes the candidate vectors (with ICU's string fold).
import base64, gzip, json, os, re, subprocess, sys, unicodedata
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
rows = {}
for line in open(os.path.join(HERE, "icu-dump.tsv")):
    cp, gc, di, cf, nfc, low = line.rstrip("\n").split("\t")
    seq = lambda x: tuple(int(h, 16) for h in x.split()) if x else ()
    rows[int(cp, 16)] = (int(gc), int(di), seq(cf), seq(nfc), seq(low))

GC_CO = 17  # private use (ICU UCharCategory: U_PRIVATE_USE_CHAR = 17)
def noncharacter(c): return (0xFDD0 <= c <= 0xFDEF) or (c & 0xFFFE) == 0xFFFE
BIDI = {0x061C, 0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)}
INVISIBLE = {0x200B, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x00AD, 0x180E}
JOINERS = {0x200C, 0x200D}  # ZWNJ, ZWJ: needed by Persian, Indic scripts and emoji sequences
WS = {0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000}

def allowed(c):
    r = rows.get(c)
    return r is not None and r[0] != GC_CO and not noncharacter(c)

# ---- tables and their sizes
def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n: return bytes(out)
def zigzag(n): return (n << 1) ^ (n >> 63) if n < 0 else n << 1
def ranges(pred):
    out, start, prev = [], None, None
    for c in range(0x110000):
        ok = pred(c)
        if ok and start is None: start = c
        if not ok and start is not None: out.append((start, c - start)); start = None
    if start is not None: out.append((start, 0x110000 - start))
    return out
def enc_ranges(rs):
    b, last = bytearray(), 0
    for s, n in rs: b += varint(s - last) + varint(n); last = s + n
    return bytes(b)
def enc_map(m):
    b, last = bytearray(), 0
    for c in sorted(m):
        v = m[c]
        b += varint(c - last) + varint(len(v)) + b"".join(varint(zigzag(x - c)) for x in v)
        last = c
    return bytes(b)
def shipped(blob):  # as embedded in JS (base64 text), then served gzip -9
    return {"raw": len(blob), "base64": len(base64.b64encode(blob)), "gzip": len(gzip.compress(base64.b64encode(blob), 9))}

assigned = ranges(allowed)
lower = {c: r[4] for c, r in rows.items() if r[4] != (c,)}
nfkccf = {c: r[2] for c, r in rows.items() if r[2] != (c,)}
# NFC data (decompositions + combining classes) from Python's UCD (17.0), for "if the engine cannot be trusted".
decomp = {}
for c in range(0x110000):
    d = unicodedata.decomposition(chr(c))
    if 0xAC00 <= c <= 0xD7A3: continue  # Hangul syllables decompose algorithmically: no table
    if d and not d.startswith("<"): decomp[c] = tuple(int(h, 16) for h in d.split())
ccc = ranges(lambda c: unicodedata.combining(chr(c)) != 0)
ccc_blob = enc_ranges(ccc) + bytes(unicodedata.combining(chr(s)) for s, _ in ccc)

sizes = {
    "assigned (refuse unassigned, private use, noncharacters)": shipped(enc_ranges(assigned)),
    "lowercase mappings (rule A without the engine's toLowerCase)": shipped(enc_map(lower)),
    "NFKC_Casefold mappings (rule B)": shipped(enc_map(nfkccf)),
    "NFC decompositions + combining classes (either rule, without the engine's normalize)": shipped(enc_map(decomp) + ccc_blob),
}
counts = {"assigned ranges": len(assigned), "lowercase entries": len(lower), "nfkc_cf entries": len(nfkccf), "canonical decompositions": len(decomp)}

# ---- per-code-point comparison (single code points, refusals aside)
def ruleA_cp(c):  # lowercase of NFC(c), code point by code point (recomposition is a string step)
    out = []
    for x in rows[c][3]: out += list(rows[x][4]) if x in rows else [x]
    return tuple(out)
def nfd_tuple(t): return tuple(ord(x) for x in unicodedata.normalize("NFD", "".join(map(chr, t))))
def ruleB_cp(c): return rows[c][2]
diff = Counter()
examples = {}
for c, r in rows.items():
    if not allowed(c) or c in BIDI or c in INVISIBLE: continue
    a, b = ruleA_cp(c), ruleB_cp(c)
    if a == b or nfd_tuple(a) == nfd_tuple(b): continue
    if r[1]: k = "default-ignorable: B removes it, A keeps it"
    elif unicodedata.decomposition(chr(c)).startswith("<"): k = "compatibility form (fullwidth, ligature, circled, super/subscript, …): B folds it"
    else: k = "case: B case-folds, A lowercases (ß, ς, Cherokee, …)"
    diff[k] += 1
    examples.setdefault(k, []).append(chr(c))

# ---- string vectors (ICU ground truth)
def pre(s):
    """Whitespace, then refusals. Returns (string, None) or (None, rule)."""
    cps = [ord(x) for x in s]
    while cps and cps[0] in WS: cps.pop(0)
    while cps and cps[-1] in WS: cps.pop()
    out, i = [], 0
    while i < len(cps):
        if cps[i] in WS or (cps[i] == 0x5F and i + 1 < len(cps) and cps[i + 1] in WS):
            j, saw = i, False
            while j < len(cps) and (cps[j] in WS or cps[j] == 0x5F):
                saw = saw or cps[j] in WS; j += 1
            if saw:
                while out and out[-1] == 0x5F: out.pop()
                out.append(0x5F); i = j; continue
        out.append(cps[i]); i += 1
    if not out: return None, "empty"
    for c in out:
        if c in BIDI: return None, "bidi-control"
        if c in INVISIBLE: return None, "invisible"
        if c < 0x20 or c == 0x7F: return None, "control"
        if not allowed(c): return None, "unassigned-or-private"
    return "".join(map(chr, out)), None

def post(w):
    b = w.encode("utf-8")
    if not 1 <= len(b) <= 255: return "length"
    if "/" in w: return "slash"
    if w in (".", ".."): return "dot"
    if w.startswith("~"): return "reserved-tilde"
    if re.fullmatch(r"0x[0-9a-fA-F]{40}", w): return "address-shaped"
    if any(ord(x) < 0x20 or ord(x) == 0x7F or x == " " or "A" <= x <= "Z" for x in w): return "chain-ascii"
    return None

CASES = [
    ("ascii", "Tesla"), ("ascii-lower", "tesla"), ("digits", "model3"), ("underscore", "model_y"),
    ("qualifier", "Mercury_(planet)"), ("sharp-s", "Straße"), ("capital-sharp-s", "STRASSE"), ("final-sigma", "ΟΔΟΣ"),
    ("greek-tonos", "Άλφα"), ("turkish-dotted-I", "İstanbul"), ("dotless-i", "ıi"), ("kelvin", "K"),
    ("angstrom", "Å"), ("long-s", "ſtar"), ("ligature-fi", "ﬁle"), ("fullwidth", "Ｔｅｓｌａ"),
    ("circled", "Ⓐⓑ"), ("superscript", "x²"), ("roman-numeral", "Ⅻ"), ("cherokee", "ᏣᎳᎩ"), ("cherokee-lower", "ꮳꮃꭹ"),
    ("georgian-mtavruli", "ᲛᲐᲠᲗᲚᲘ"), ("decomposed-e", "café"), ("precomposed-e", "café"),
    ("hangul-jamo", "가"), ("cjk-compat", "豈"), ("arabic-presentation", "ﻷ"),
    ("persian-zwnj", "می‌خواهم"), ("devanagari-zwj", "क्‍ष"), ("emoji", "❤️"), ("emoji-plain", "❤"),
    ("emoji-zwj", "👨‍👩‍👧"), ("emoji-skin", "👍🏽"), ("cjk", "東京"), ("thai", "ภาษาไทย"),
    ("leading-space", "  tesla"), ("trailing-space", "tesla  "), ("inner-space", "model y"), ("inner-spaces", "model   y"),
    ("tab", "model\ty"), ("nbsp", "model y"), ("ideographic-space", "東京　都"),
    ("space-and-underscore", "model _ y"), ("double-underscore", "model__y"), ("leading-underscore", "_tesla"),
    ("only-spaces", "   "), ("bidi-override", "abc‮def"), ("rlm", "abc‏"), ("zwsp", "te​sla"),
    ("soft-hyphen", "te­sla"), ("word-joiner", "te⁠sla"), ("private-use", ""), ("unassigned", "͸"),
    ("noncharacter", "﷐"), ("slash", "cars/tesla"), ("dot", "."), ("dotdot", ".."), ("tilde", "~efs"),
    ("address", "0x" + "ab" * 20), ("address-upper", "0X" + "AB" * 20), ("too-long", "a" * 256), ("max-length", "a" * 255),
]
fold = os.path.join(HERE, "fold")
env = dict(os.environ, DYLD_LIBRARY_PATH="/opt/homebrew/opt/icu4c/lib")
inputs, prepped = [], []
for label, s in CASES:
    p, rule = pre(s)
    prepped.append((label, s, p, rule))
    inputs.append(p if p is not None else "")
outs = subprocess.run([fold], input="\n".join(inputs) + "\n", capture_output=True, text=True, env=env, check=True).stdout.split("\n")
vectors = []
for (label, s, p, rule), line in zip(prepped, outs):
    v = {"label": label, "input": s, "inputHex": " ".join(f"{ord(x):04X}" for x in s)}
    if rule:
        v["A"] = v["B"] = {"refused": rule}
    else:
        b_out, _nfc, a_out = line.split("\t")
        for k, w in (("A", a_out), ("B", b_out)):
            r = post(w)
            v[k] = {"refused": r} if r else {"word": w, "hex": " ".join(f"{ord(x):04X}" for x in w)}
    v["same"] = v["A"] == v["B"]
    vectors.append(v)

# ---- idempotence over single code points (and their folded outputs)
def idem(col):
    bad = 0
    for c, r in rows.items():
        if not allowed(c): continue
        out = r[col]
        again = []
        for x in out: again += list(rows[x][col]) if x in rows else [x]
        if tuple(again) != out: bad += 1
    return bad

summary = {
    "unicode": {"icu": "79.1 (Unicode 18.0)", "python": unicodedata.unidata_version},
    "counts": counts, "sizes": sizes,
    "differ (single code points)": {k: {"count": n, "examples": "".join(examples[k][:24])} for k, n in diff.items()},
    "idempotence failures (single code points)": {"A lowercase": idem(4), "B nfkc_cf": idem(2)},
    "vectors": len(vectors), "vectors where A and B differ": sum(1 for v in vectors if not v["same"]),
}
json.dump({"summary": summary, "vectors": vectors}, open(os.path.join(HERE, "fold-eval.json"), "w"), ensure_ascii=False, indent=1)
print(json.dumps(summary, ensure_ascii=False, indent=1))
