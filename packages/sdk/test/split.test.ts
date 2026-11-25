// SPDX-License-Identifier: MIT
// The publication splitter against the contracts' measurements (an 8,192-byte chunk ≈ 6.09M: two per transaction),
// the kernel's batch limits (LedgerCore._bounds), atomic groups, and honest refusals.
import { describe, expect, it } from "vitest";
import {
  type GasModel,
  type PlannedAction,
  publicationGas,
  splitPublications,
} from "../src/actions/split.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import type { Hex } from "../src/core/hex.ts";
import { ZERO_WORD } from "../src/core/hex.ts";

/** The contracts dev's fitted prague constants (until release.json gasModel is vendored). */
const MODEL: GasModel = {
  schedule: "prague",
  fixed: 390_000,
  perWord: 22_100,
  perByte: 21,
  publishNew: { "files-bytes/1": 260_000, "files-span/1": 260_000, "files-root/1 form 1": 260_000 },
  publishExisting: 300_000,
  reuse: 100_000,
  create: 200_000,
  bind: 310_000,
  unbind: 450_000,
  release: 450_000,
  withdraw: 200_000,
};
const LIMITS = {
  maxActionsPerPublication: 64,
  maxBodyBytesPerPublication: 1 << 20,
  maxBindsPerPublication: 32,
  maxBodyBytes: 8192,
};
const CAP = 16_777_216n;

const action = (kind: number): ActionData => ({
  kind,
  typeId: ZERO_WORD,
  bodyHashOrRecordId: ZERO_WORD,
  purpose: ZERO_WORD,
  subject: ZERO_WORD,
  role: ZERO_WORD,
  target: ZERO_WORD,
  expectedRevision: 0n,
  salt: ZERO_WORD,
});
const body = (n: number): Hex => `0x${"ab".repeat(n)}` as Hex;
const publish = (
  n: number,
  shape = "files-bytes/1",
  extra: Partial<PlannedAction> = {},
): PlannedAction => ({
  action: action(ACTION.PUBLISH),
  body: body(n),
  shape,
  ...extra,
});
const plain = (kind: number, group?: number): PlannedAction => ({
  action: action(kind),
  body: "0x",
  ...(group !== undefined ? { group } : {}),
});
const split = (list: PlannedAction[], o = {}) =>
  splitPublications(list, { model: MODEL, limits: LIMITS, txGasCap: CAP, ...o });

describe("splitPublications", () => {
  it("prices an 8 KB chunk like the contracts measured, so two chunks fit one transaction", () => {
    const one = publicationGas([publish(8192)], MODEL) - publicationGas([], MODEL);
    expect(one).toBeGreaterThan(6_090_000); // 6.09M measured, plus its calldata
    expect(one).toBeLessThan(6_300_000);
    const r = split(Array.from({ length: 10 }, () => publish(8192)));
    expect(r.ok && r.parts.map((p) => p.actions.length)).toEqual([2, 2, 2, 2, 2]);
    expect(r.ok && r.parts.every((p) => p.gas <= r.budget)).toBe(true);
    expect(r.ok && r.budget).toBe(Math.floor(16_777_216 / 1.15));
  });

  it("keeps order and never splits a group: a file's finish moves to the next publication whole", () => {
    const finish = [ACTION.PUBLISH, ACTION.PUBLISH, ACTION.CREATE, ACTION.BIND, ACTION.BIND].map(
      (k, i) =>
        k === ACTION.PUBLISH ? publish(96, "files-root/1 form 1", { group: 7 }) : plain(k, 7),
    );
    expect(finish.length).toBe(5);
    const list = [publish(8192), publish(8192), ...finish];
    // With ~0.31M binds, two chunks and this finish fit together (~14.4M of a 14.59M budget) …
    const together = split(list);
    expect(together.ok && together.parts.map((p) => p.actions.length)).toEqual([7]);
    // … with 1M binds they do not, and the finish moves whole to a publication of its own.
    const r = split(list, { model: { ...MODEL, bind: 1_000_000 } });
    if (!r.ok) throw new Error(r.reason.detail);
    expect(r.parts.map((p) => p.actions.length)).toEqual([2, 5]); // the finish did not fit beside two chunks
    expect(r.parts.flatMap((p) => p.actions)).toEqual(list);
  });

  it("enforces the kernel's batch limits: BIND, UNBIND and RELEASE count as binds", () => {
    const binds = [
      ...Array.from({ length: 20 }, () => plain(ACTION.BIND)),
      ...Array.from({ length: 10 }, () => plain(ACTION.UNBIND)),
      ...Array.from({ length: 10 }, () => plain(ACTION.RELEASE)),
    ];
    const r = split(binds, { model: { ...MODEL, bind: 1, unbind: 1, release: 1 } });
    expect(r.ok && r.parts.map((p) => p.actions.length)).toEqual([32, 8]);
    const many = split(
      Array.from({ length: 100 }, () => plain(ACTION.CREATE)),
      { model: { ...MODEL, create: 1 } },
    );
    expect(many.ok && many.parts.map((p) => p.actions.length)).toEqual([64, 36]);
  });

  it("refuses honestly: a body over the record limit, or a group too big for any transaction", () => {
    const big = split([publish(10), publish(9000)]);
    expect(big).toMatchObject({
      ok: false,
      at: 1,
      reason: { code: "LIMIT_EXCEEDED", retry: "after-replan" },
    });
    const group = Array.from({ length: 3 }, () => publish(8192, "files-bytes/1", { group: 1 }));
    const r = split([publish(10), ...group]);
    expect(r).toMatchObject({ ok: false, at: 1, reason: { code: "OVER_TX_GAS_CAP" } });
  });

  it("prices existing records as publishExisting and unknown shapes at the most expensive known one", () => {
    expect(publicationGas([publish(8192, "files-bytes/1", { exists: true })], MODEL)).toBeLessThan(
      publicationGas([publish(8192)], MODEL),
    );
    expect(publicationGas([publish(96, "no-such-shape")], MODEL)).toBe(
      publicationGas([publish(96, "files-span/1")], MODEL),
    );
  });
});
