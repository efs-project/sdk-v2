// SPDX-License-Identifier: MIT
// Dump, for every assigned code point (gc != Cn) and every default-ignorable one, the facts the word-character
// evaluation needs, from ICU's own data:
// general category, script, Extended_Pictographic, Emoji, Regional_Indicator, Emoji_Modifier, Default_Ignorable,
// NFKC_Casefold(c), and the UTS 39 confusable skeleton of NFKC_Casefold(c). Tab-separated, hex sequences.
// Build: c++ -std=c++17 dump.cpp -I"$ICU/include" -L"$ICU/lib" -licui18n -licuuc -licudata -o dump
#include <unicode/normalizer2.h>
#include <unicode/uchar.h>
#include <unicode/uscript.h>
#include <unicode/uspoof.h>
#include <unicode/unistr.h>
#include <unicode/uversion.h>
#include <cstdio>
using namespace icu;
static void hexseq(const UnicodeString& s, FILE* f) {
  bool first = true;
  for (int32_t i = 0; i < s.length();) {
    UChar32 c = s.char32At(i);
    fprintf(f, first ? "%04X" : " %04X", (unsigned)c);
    first = false;
    i += U16_LENGTH(c);
  }
}
int main() {
  UErrorCode e = U_ZERO_ERROR;
  const Normalizer2* cf = Normalizer2::getNFKCCasefoldInstance(e);
  USpoofChecker* sc = uspoof_open(&e);
  if (U_FAILURE(e)) { fprintf(stderr, "icu: %s\n", u_errorName(e)); return 1; }
  UVersionInfo uv; u_getUnicodeVersion(uv);
  fprintf(stderr, "unicode %d.%d.%d\n", uv[0], uv[1], uv[2]);
  for (UChar32 c = 0; c <= 0x10FFFF; c++) {
    int8_t gc = u_charType(c);
    // Unassigned code points are skipped, except the default-ignorable ones (reserved inside the default-ignorable
    // blocks, e.g. U+2065, U+FFF0..FFF8, U+E0000..E0FFF): printed with category 0 (Cn) so a table can refuse them.
    if (gc == U_UNASSIGNED && !u_hasBinaryProperty(c, UCHAR_DEFAULT_IGNORABLE_CODE_POINT)) continue;
    UnicodeString s(c);
    UnicodeString f = cf->normalize(s, e);
    UChar buf[256];
    int32_t n = uspoof_getSkeleton(sc, 0, f.getBuffer(), f.length(), buf, 256, &e);
    UnicodeString sk(buf, n);
    if (U_FAILURE(e)) { e = U_ZERO_ERROR; sk = UnicodeString(); }
    fprintf(stdout, "%04X\t%d\t%s\t%d\t%d\t%d\t%d\t%d\t", (unsigned)c, gc,
            uscript_getShortName(uscript_getScript(c, &e)),
            (int)u_hasBinaryProperty(c, UCHAR_EXTENDED_PICTOGRAPHIC), (int)u_hasBinaryProperty(c, UCHAR_EMOJI),
            (int)u_hasBinaryProperty(c, UCHAR_REGIONAL_INDICATOR), (int)u_hasBinaryProperty(c, UCHAR_EMOJI_MODIFIER),
            (int)u_hasBinaryProperty(c, UCHAR_DEFAULT_IGNORABLE_CODE_POINT));
    hexseq(f, stdout);
    fputc('\t', stdout);
    hexseq(sk, stdout);
    fputc('\n', stdout);
  }
  // Extended_Pictographic code points not yet assigned: reserved for future emoji.
  int reserved = 0;
  for (UChar32 c = 0; c <= 0x10FFFF; c++)
    if (u_charType(c) == U_UNASSIGNED && u_hasBinaryProperty(c, UCHAR_EXTENDED_PICTOGRAPHIC)) reserved++;
  fprintf(stderr, "unassigned Extended_Pictographic: %d\n", reserved);
  uspoof_close(sc);
  return U_FAILURE(e) ? 1 : 0;
}
