// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const in17 = new Set(
  readFileSync(`${dir}/assigned17.txt`, "utf8")
    .trim()
    .split("\n")
    .map((h) => parseInt(h, 16)),
);
const rows = new Map();
for (const line of readFileSync(`${dir}/icu-dump.tsv`, "utf8").trim().split("\n")) {
  const [cp, , , , nfc, low] = line.split("\t");
  rows.set(parseInt(cp, 16), { nfc, low });
}
const hex = (s) =>
  [...s].map((x) => x.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
let checked = 0,
  nfcDiff = 0,
  lowDiff = 0;
const ex = [];
for (const c of in17) {
  const r = rows.get(c);
  if (!r) continue;
  checked++;
  const s = String.fromCodePoint(c);
  if (hex(s.normalize("NFC")) !== r.nfc) {
    nfcDiff++;
    if (ex.length < 5) ex.push(["nfc", c.toString(16), hex(s.normalize("NFC")), r.nfc]);
  }
  if (hex(s.toLowerCase()) !== r.low) {
    lowDiff++;
    if (ex.length < 10) ex.push(["lower", c.toString(16), hex(s.toLowerCase()), r.low]);
  }
}
console.log(
  JSON.stringify({ engine: process.versions.unicode, checked, nfcDiff, lowDiff, examples: ex }),
);
