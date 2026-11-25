// SPDX-License-Identifier: MIT
// Read UTF-8 lines from stdin; for each, print NFKC_Casefold(s), NFC(s), and lowercase(NFC(s)) then NFC again, as
// UTF-8, tab-separated. Ground truth for the vectors (ICU's own implementation).
#include <unicode/normalizer2.h>
#include <unicode/unistr.h>
#include <unicode/locid.h>
#include <iostream>
#include <string>
using namespace icu;
int main() {
  UErrorCode e = U_ZERO_ERROR;
  const Normalizer2* cf = Normalizer2::getNFKCCasefoldInstance(e);
  const Normalizer2* nfc = Normalizer2::getNFCInstance(e);
  std::string line;
  while (std::getline(std::cin, line)) {
    UnicodeString s = UnicodeString::fromUTF8(line);
    UnicodeString a = cf->normalize(s, e);
    UnicodeString b = nfc->normalize(s, e);
    UnicodeString l(b); l.toLower(Locale::getRoot());
    UnicodeString l2 = nfc->normalize(l, e);
    std::string A, B, L; a.toUTF8String(A); b.toUTF8String(B); l2.toUTF8String(L);
    std::cout << A << "\t" << B << "\t" << L << "\n";
  }
  return U_FAILURE(e) ? 1 : 0;
}
