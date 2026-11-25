// SPDX-License-Identifier: MIT
// Dump, for every code point: general category, NFKC_Casefold(c), NFC(c), full lowercase (root locale), and whether
// it is Default_Ignorable. One line per code point that is not unassigned (gc != Cn), tab-separated, hex sequences.
#include <unicode/normalizer2.h>
#include <unicode/uchar.h>
#include <unicode/ustring.h>
#include <unicode/unistr.h>
#include <unicode/uversion.h>
#include <unicode/locid.h>
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
  const Normalizer2* nfc = Normalizer2::getNFCInstance(e);
  if (U_FAILURE(e)) { fprintf(stderr, "icu: %s\n", u_errorName(e)); return 1; }
  UVersionInfo uv; u_getUnicodeVersion(uv);
  fprintf(stderr, "unicode %d.%d.%d\n", uv[0], uv[1], uv[2]);
  for (UChar32 c = 0; c <= 0x10FFFF; c++) {
    int8_t gc = u_charType(c);
    if (gc == U_UNASSIGNED) continue;
    if (gc == U_SURROGATE) continue;
    UnicodeString s(c);
    UnicodeString a = cf->normalize(s, e);
    UnicodeString b = nfc->normalize(s, e);
    UnicodeString l(s); l.toLower(Locale::getRoot());
    if (U_FAILURE(e)) { fprintf(stderr, "fail at %X\n", (unsigned)c); return 1; }
    printf("%04X\t%d\t%d\t", (unsigned)c, gc, (int)u_hasBinaryProperty(c, UCHAR_DEFAULT_IGNORABLE_CODE_POINT));
    hexseq(a, stdout); printf("\t"); hexseq(b, stdout); printf("\t"); hexseq(l, stdout); printf("\n");
  }
  return 0;
}
