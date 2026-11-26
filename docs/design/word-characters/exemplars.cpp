// SPDX-License-Identifier: MIT
// Dump CLDR's exemplar characters (ICU locale data) for every available locale: the standard set (the letters a
// language's ordinary words use), the auxiliary set (letters in common foreign words and names) and the punctuation
// set. One line per item: locale, set, the item as hex (an item can be a sequence, e.g. Catalan "l·l").
// Build: c++ -std=c++17 exemplars.cpp -I"$ICU/include" -L"$ICU/lib" -licui18n -licuuc -licudata -o exemplars
#include <unicode/ulocdata.h>
#include <unicode/uloc.h>
#include <unicode/uset.h>
#include <unicode/ustring.h>
#include <cstdio>
static void hexseq(const UChar* s, int32_t n) {
  for (int32_t i = 0; i < n;) {
    UChar32 c;
    U16_NEXT(s, i, n, c);
    printf(i == U16_LENGTH(c) ? "%04X" : " %04X", (unsigned)c);
  }
}
int main() {
  const ULocaleDataExemplarSetType kinds[] = {ULOCDATA_ES_STANDARD, ULOCDATA_ES_AUXILIARY,
                                              ULOCDATA_ES_PUNCTUATION};
  const char* names[] = {"standard", "auxiliary", "punctuation"};
  for (int32_t l = 0; l < uloc_countAvailable(); l++) {
    const char* loc = uloc_getAvailable(l);
    UErrorCode e = U_ZERO_ERROR;
    ULocaleData* d = ulocdata_open(loc, &e);
    if (U_FAILURE(e)) continue;
    for (int k = 0; k < 3; k++) {
      e = U_ZERO_ERROR;
      USet* s = ulocdata_getExemplarSet(d, nullptr, 0, kinds[k], &e);
      if (U_FAILURE(e) || !s) continue;
      // A locale's own data only: skip a set inherited unchanged from root.
      int32_t n = uset_getItemCount(s);
      for (int32_t i = 0; i < n; i++) {
        UChar32 a, b;
        UChar str[64];
        int32_t len = uset_getItem(s, i, &a, &b, str, 64, &e);
        if (U_FAILURE(e)) { e = U_ZERO_ERROR; continue; }
        if (len == 0) {
          for (UChar32 c = a; c <= b; c++) printf("%s\t%s\t%04X\n", loc, names[k], (unsigned)c);
        } else {
          printf("%s\t%s\t", loc, names[k]);
          hexseq(str, len);
          putchar('\n');
        }
      }
      uset_close(s);
    }
    ulocdata_close(d);
  }
  return 0;
}
