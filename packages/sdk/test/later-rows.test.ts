// SPDX-License-Identifier: MIT
// Later statements in the list release's gas model (contracts 04526b1 item 57; gas/model.json laterRows): each later
// row is measured at one position of its binding, and the planner corrects a statement at another position by the
// binding's history word, both ways (src/actions/split.ts historyWordAdds; tools/gas-plan.mjs historyWordAdds):
//   - a BIND on a head that never bound (a yes after a lone no) is priced by bind<Purpose>AfterNo, which carries the
//     kernel's fresh target slot and the history word of the yes directly after the no (revision 1);
//   - a FOLDER, PROPERTY or HEAD restore is priced as a restore to a NEW target (the kernel's rewrite in the row);
//   - the statement's own position is its `expectedRevision`, which the kernel checks exactly (E_CAS), so a
//     correction made from a stale revision is refused on chain, never admitted under-priced.
// Checked against the model's own validation composites where the SDK takes the model's tier (the long one; the SDK
// never passes an author's entry count), and offset by exactly the tier difference where the model took the short one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BindRow,
  type GasConstants,
  type GasModel,
  modelGas,
  opensHistoryWord,
  type PlannedAction,
  ruleGas,
} from "../src/actions/split.ts";
import { ACTION } from "../src/actions/types.ts";
import { type Hex, ZERO_WORD } from "../src/core/hex.ts";
import { PURPOSES } from "../src/generated/constants.ts";
import { GAS_LATER_ROWS, GAS_SCHEDULES } from "../src/generated/gas.ts";
import { neverBoundHead } from "../src/protocol/status.ts";

const IN = join(import.meta.dirname, "../../../protocol-inputs/contracts");
const model = JSON.parse(readFileSync(join(IN, "gas/model.json"), "utf8"));
const release = JSON.parse(readFileSync(join(IN, "release/release.json"), "utf8"));
const S = GAS_SCHEDULES as unknown as Record<
  string,
  { constants: GasConstants; executionGas?: GasConstants; floor: GasModel["floor"] }
>;
const modelOf = (schedule: string): GasModel => {
  const s = S[schedule] as (typeof S)[string];
  return {
    ...(s.executionGas ?? s.constants),
    schedule,
    ...(s.executionGas ? { total: s.constants } : {}),
    ...(s.floor ? { floor: s.floor } : {}),
  } as GasModel;
};
const P = modelOf("prague");
const A = modelOf("amsterdam");
const T = A.total as GasConstants;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const purposeOf = (row: string): Hex =>
  /Head/.test(row)
    ? PURPOSES.head
    : /Folder/.test(row)
      ? PURPOSES.folder
      : /Tag/.test(row)
        ? PURPOSES.tag
        : /Property/.test(row)
          ? PURPOSES.property
          : /Same/.test(row)
            ? PURPOSES.same
            : PURPOSES.broader;
const kindOf = (row: string) =>
  row.startsWith("unbind")
    ? ACTION.UNBIND
    : row.startsWith("release")
      ? ACTION.RELEASE
      : ACTION.BIND;
/** k later statements priced at `row`, at head revision `revision`: across places (k subjects) or at one place. */
const later = (row: BindRow, k: number, across: boolean, revision: bigint): PlannedAction[] =>
  Array.from({ length: k }, (_, i) => ({
    action: {
      kind: kindOf(row),
      typeId: ZERO_WORD,
      bodyHashOrRecordId: ZERO_WORD,
      purpose: purposeOf(row),
      subject: across ? word(1000 + i) : word(1000),
      role: word(5000 + i),
      target: word(5000 + i),
      expectedRevision: revision,
      saltOrStrength: ZERO_WORD,
    },
    body: "0x",
    bindRow: row,
    firstStatement: false,
  }));

/** The rows that are first statements, and the constants that price no bind-kind statement. */
const FIRST_ROWS = new Set([
  "bindHeadFresh",
  "bindFolderFreshFile",
  "bindFolderFreshDirectory",
  "bindTagFresh",
  "bindTagSecondAuthor",
  "unbindTagLone",
  "bindPropertyFresh",
  "bindSameFreshWord",
  "bindSameFreshPath",
  "bindBroaderFresh",
]);
const NOT_BINDS = new Set([
  "fixed",
  "perWord",
  "perByte",
  "publishNew",
  "publishExisting",
  "reuse",
  "create",
  "withdraw",
  "firstWriteSurcharge",
  "tagLevel",
  "historyWordOpen",
]);
/** Constants of the vendored model the SDK deliberately does not carry: each is a measurement, never a row it prices. */
const NOT_CARRIED = new Set(["restoreTagAtHistoryWord"]);

describe("the list release's later rows", () => {
  it("a never-bound head: not UNSET and targetKind 0 (served as stored), at any revision", () => {
    expect(neverBoundHead({ state: 0, targetKind: 0 })).toBe(false); // UNSET: a first statement
    expect(neverBoundHead({ state: 2, targetKind: 0 })).toBe(true); // a lone no, or a no then another no
    expect(neverBoundHead({ state: 3, targetKind: 0 })).toBe(true); // a no then a release
    expect(neverBoundHead({ state: 2, targetKind: 3 })).toBe(false); // a yes then a mask: the stored target is kept
    expect(neverBoundHead({ state: 3, targetKind: 1 })).toBe(false); // a yes then a release
    expect(neverBoundHead({ state: 7, targetKind: 0n })).toBe(true); // unrecognized: the dearer reading
  });

  it("a history word opens after 1 statement, then after every multiple of 5, forever", () => {
    const opens = Array.from({ length: 32 }, (_, r) => r).filter((r) =>
      opensHistoryWord(BigInt(r)),
    );
    expect(opens).toEqual([1, 5, 10, 15, 20, 25, 30]);
    expect(opensHistoryWord(1_000_000_000_000_000n)).toBe(true);
  });

  it("every constant of the vendored model is carried, or named here as a measurement the SDK never prices", () => {
    // The tripwire for a later release: a new row in gas/model.json fails here until the SDK prices it (the
    // generated table carries only the rows codegen lists, so this reads the vendored files themselves).
    for (const name of ["prague", "amsterdam"]) {
      const carried = new Set(Object.keys((S[name] as (typeof S)[string]).constants));
      const sources = [
        model.profiles[name].constants,
        model.profiles[name].floor.kernel,
        release.gasModel.schedules[name].constants,
        release.gasModel.schedules[name].floor.kernel,
        ...(release.gasModel.schedules[name].executionGas
          ? [release.gasModel.schedules[name].executionGas]
          : []),
      ] as Record<string, unknown>[];
      for (const c of sources)
        expect(
          Object.keys(c).filter((k) => !carried.has(k) && !NOT_CARRIED.has(k)),
          name,
        ).toEqual([]);
      // and nothing interim is left
      expect(
        [...carried].filter((k) => /interim/i.test(k)),
        name,
      ).toEqual([]);
    }
  });

  it("every later row and tier the SDK prices has a measured position (laterRows), and only those", () => {
    const keys = Object.keys(P).filter(
      (k) =>
        typeof (P as unknown as Record<string, unknown>)[k] === "number" &&
        !FIRST_ROWS.has(k) &&
        !NOT_BINDS.has(k),
    );
    expect(keys.length).toBe(79 - NOT_CARRIED.size);
    expect(keys.filter((k) => !(k in GAS_LATER_ROWS))).toEqual([]);
    expect(
      Object.keys(GAS_LATER_ROWS).filter((k) => !keys.includes(k) && !NOT_CARRIED.has(k)),
    ).toEqual([]);
    // the rule: masks, releases, re-binds and yeses after a lone no measured at revision 1, restores at 2
    for (const [k, opens] of Object.entries(GAS_LATER_ROWS))
      if (!NOT_CARRIED.has(k))
        expect(opens, k).toBe(!/^restore/.test(k) || /AtHistoryWord$/.test(k));
  });

  it("historyWordOpen: 17,100 on prague; 97,920 of state gas and no execution on amsterdam; no kernel share", () => {
    expect(P.historyWordOpen).toBe(17_100);
    expect(A.historyWordOpen).toBe(0);
    expect(T.historyWordOpen).toBe(97_920);
    expect(P.floor?.kernel.historyWordOpen).toBe(0);
    expect(A.floor?.kernel.historyWordOpen).toBe(0);
  });

  it("the correction is symmetric: + where a position opens a word its row did not, − the other way, K never", () => {
    /** E (prague all gas, amsterdam execution and all gas) and both Ks of k statements at `revision`, less at `base`. */
    const delta = (row: BindRow, revision: bigint, base: bigint, k = 10) => {
      const at = later(row, k, true, revision);
      const b = later(row, k, true, base);
      return {
        E: [modelGas(at, P) - modelGas(b, P), modelGas(at, A) - modelGas(b, A)],
        total: modelGas(at, T) - modelGas(b, T),
        K: [ruleGas(at, P).K - ruleGas(b, P).K, ruleGas(at, A).K - ruleGas(b, A).K],
      };
    };
    const k = 10;
    const plus = { E: [k * 17_100, 0], total: k * 97_920, K: [0, 0] };
    const minus = { E: [-k * 17_100, 0], total: -k * 97_920, K: [0, 0] };
    const none = { E: [0, 0], total: 0, K: [0, 0] };
    // a yes after a lone no is measured directly after the no (revision 1): no → release → yes saves the word
    expect(delta("bindTagAfterNo", 2n, 1n)).toEqual(minus);
    expect(delta("bindFolderAfterNo", 2n, 1n)).toEqual(minus);
    expect(delta("bindHeadAfterNo", 2n, 1n)).toEqual(minus);
    // ... and a yes after no → no → … → no at revision 5 opens one again
    expect(delta("bindTagAfterNo", 5n, 1n)).toEqual(none);
    // a restore is measured as the 3rd statement (revision 2): the 6th (revision 5) opens a word
    for (const row of [
      "restoreTag",
      "restoreFolder",
      "restoreProperty",
      "restoreSame",
      "restoreBroader",
      "restoreHead",
    ] as const) {
      expect(delta(row, 5n, 2n), row).toEqual(plus);
      expect(delta(row, 3n, 2n), row).toEqual(none);
      expect(delta(row, 4n, 2n), row).toEqual(none);
      expect(delta(row, 10n, 2n), row).toEqual(plus);
    }
    // masks, releases and re-binds are measured as the 2nd statement (revision 1): later ones save the word
    for (const row of [
      "unbindTag",
      "releaseTag",
      "releaseFolder",
      "unbindHead",
      "bindTagNumberChange",
      "bindFolderRebind",
      "bindHeadRebind",
      "bindPropertyRebind",
    ] as const) {
      expect(delta(row, 2n, 1n), row).toEqual(minus);
      expect(delta(row, 5n, 1n), row).toEqual(none);
    }
  });

  it("every later row is a later statement without being told (firstStatement absent): its tier and class", () => {
    const LATER = Object.keys(GAS_LATER_ROWS).filter(
      (k) => !/(NewPlace|LongSamePlace|AtHistoryWord)$/.test(k),
    ) as BindRow[];
    expect(LATER.length).toBe(28);
    for (const row of LATER) {
      const told = later(row, 1, true, 2n);
      const { firstStatement: _, ...untold } = told[0] as PlannedAction;
      for (const m of [P, A]) {
        const a = ruleGas(told, m);
        const b = ruleGas([untold], m);
        expect({ E: b.E, K: b.K, quote: b.quote }, row).toEqual({ E: a.E, K: a.K, quote: a.quote });
      }
    }
  });

  it("first statements are never corrected, and a later statement with no revision is priced at its row", () => {
    const first: PlannedAction = {
      ...(later("bindTagFresh", 1, true, 7n)[0] as PlannedAction),
      firstStatement: true,
    };
    expect(modelGas([first], P)).toBe(P.fixed + P.bindTagFresh);
    expect(modelGas(later("unbindTag", 1, true, 0n), P)).toBe(P.fixed + P.unbindTagLongNewPlace);
  });

  // [validation key, row, k, across places, revision before, the model's tier: "long" (as the SDK) or "short"]
  const COMPOSITES: [string, BindRow, number, boolean, bigint, "long" | "short"][] = [
    [
      "validate tag yeses after lone noes across 16 topics of 1025",
      "bindTagAfterNo",
      16,
      true,
      1n,
      "long",
    ],
    [
      "validate tag yeses after lone noes of 32 entries of 1025 at one topic",
      "bindTagAfterNo",
      32,
      false,
      1n,
      "long",
    ],
    [
      "validate folder yeses after hides at entry 1024 across 16 folders",
      "bindFolderAfterNo",
      16,
      true,
      1n,
      "long",
    ],
    [
      "validate folder yeses after hides of 8 entries of 1025 in one folder",
      "bindFolderAfterNo",
      8,
      false,
      1n,
      "long",
    ],
    [
      "validate head yeses after lone noes across 32 files",
      "bindHeadAfterNo",
      32,
      true,
      1n,
      "long",
    ],
    [
      "validate head restores to new revisions across 32 files",
      "restoreHead",
      32,
      true,
      2n,
      "long",
    ],
    [
      "validate tag yeses after no then release across 32 topics",
      "bindTagAfterNo",
      32,
      true,
      2n,
      "short",
    ],
    ["validate tag restores at revision 5 across 32 topics", "restoreTag", 32, true, 5n, "short"],
    [
      "validate folder yeses after hide then release across 32 folders",
      "bindFolderAfterNo",
      32,
      true,
      2n,
      "short",
    ],
    [
      "validate folder restores to new targets across 32 folders",
      "restoreFolder",
      32,
      true,
      2n,
      "short",
    ],
  ];
  for (const [key, row, k, across, revision, tier] of COMPOSITES) {
    it(`${key}: the model's prediction${tier === "short" ? ", plus the long tier's price" : ""}`, () => {
      for (const [name, m, total] of [
        ["prague", P, P],
        ["amsterdam", A, T],
      ] as const) {
        const v = (model.profiles[name].validation as Record<string, number & string>[]).find(
          (x) => x["key"] === key,
        ) as unknown as Record<string, number>;
        expect(v, `${name}: ${key}`).toBeDefined();
        const acts = later(row, k, across, revision);
        // where the model knew a short list, the SDK (which never knows) pays the long tier's difference per statement
        const offset = (c: GasConstants) => {
          if (tier === "long") return 0;
          const r = row as string;
          const longNew = c[`${r}LongNewPlace` as keyof GasConstants] as number;
          const shortNew =
            (c[`${r}NewPlace` as keyof GasConstants] as number | undefined) ??
            (c[r as keyof GasConstants] as number);
          return k * (longNew - shortNew);
        };
        expect(modelGas(acts, total), `${name} all gas`).toBe(
          (v["predicted"] as number) + offset(total),
        );
        if (name === "amsterdam")
          expect(modelGas(acts, m), "amsterdam execution").toBe(
            (v["predictedExecutionGas"] as number) + offset(m),
          );
        const kc = (m.floor as NonNullable<GasModel["floor"]>).kernel;
        expect(ruleGas(acts, m).K, `${name} K`).toBe(
          (v["predictedKernelGas"] as number) + offset(kc),
        );
      }
    });
  }
});
