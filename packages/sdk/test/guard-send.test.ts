// SPDX-License-Identifier: MIT
// The read-set guard on the send path, without a chain: its bytes (abi.encode(ReadSet) in grid order, expectedHeads[j·n
// + i]), the snapshot hash, the guard a plan's bytes name (for the review's floor), the writer's guard modes, a
// re-split piece carrying exactly its own actions' heads (PM condition 2), and the hash a sequence records of its parts
// covering the guard. The chain's own checks are in test/integration/guard-send.test.ts.
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  EMPTY_GUARD,
  encodeGuard,
  type GuardHead,
  guardingOn,
  headSnapshotHash,
  headsOfGuardBytes,
  type PartGuardHead,
} from "../src/actions/guard.ts";
import type { PartUnit, SequencePart } from "../src/actions/journal.ts";
import { partsHashOf, resplit } from "../src/actions/sequence.ts";
import { ACTION, type ActionData } from "../src/actions/types.ts";
import { type Hex, type PrincipalId, ZERO_WORD } from "../src/core/hex.ts";
import { toJson } from "../src/core/json.ts";
import { utf8Encode } from "../src/core/platform.ts";
import { knownSnapshotTarget, readTerm, withGuard, writtenTerm } from "../src/files/guardheads.ts";
import { PURPOSES } from "../src/generated/constants.ts";
import { positionKey } from "../src/protocol/keys.ts";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const head = (p: number, pos: number, expected = word(0xe000 + p * 0x100 + pos)): GuardHead => ({
  principal: word(0xa0 + p) as PrincipalId,
  position: word(0x2000 + pos),
  expected,
  term: "written",
});
const READ_SET = [
  {
    type: "tuple",
    components: [
      { name: "principals", type: "bytes32[]" },
      { name: "positions", type: "bytes32[]" },
      { name: "expectedHeads", type: "bytes32[]" },
    ],
  },
] as const;

describe("the guard's bytes", () => {
  it("are abi.encode(ReadSet) over the heads' grid, position-major: expectedHeads[j·n + i]", () => {
    // given out of order: the grid keeps first-appearance order, and each cell its own head's expected value
    const heads = [head(1, 1), head(0, 0), head(0, 1), head(1, 0)];
    const g = encodeGuard(heads);
    const [rs] = decodeAbiParameters(READ_SET, g);
    expect(rs.principals).toEqual([word(0xa1), word(0xa0)]);
    expect(rs.positions).toEqual([word(0x2001), word(0x2000)]);
    expect(rs.expectedHeads).toEqual([
      head(1, 1).expected, // position 0x2001 (j 0): principal a1 (i 0), then a0 (i 1)
      head(0, 1).expected,
      head(1, 0).expected, // position 0x2000 (j 1)
      head(0, 0).expected,
    ]);
    expect((g.length - 2) / 2).toBe(224 + 32 * (2 + 2 + 4));
    // a function of the heads alone: the same heads, the same bytes
    expect(encodeGuard([...heads])).toBe(g);
  });
  it("no heads is the empty guard; heads that form no grid are a planner's error", () => {
    expect(encodeGuard([])).toBe(EMPTY_GUARD);
    expect(() => encodeGuard([head(0, 0), head(1, 1)])).toThrow(
      expect.objectContaining({ code: "INVARIANT" }),
    );
  });
  it("headsOfGuardBytes reads the grid back, every head at the dearest term", () => {
    const heads = [head(0, 0), head(0, 1)];
    const back = headsOfGuardBytes(encodeGuard(heads));
    expect(back?.map((h) => [h.principal, h.position, h.term])).toEqual([
      [word(0xa0), word(0x2000), "twoWords"],
      [word(0xa0), word(0x2001), "twoWords"],
    ]);
    expect(headsOfGuardBytes(EMPTY_GUARD)).toBeNull();
    expect(headsOfGuardBytes(undefined)).toBeNull();
    expect(headsOfGuardBytes("0x1234")).toBeNull();
  });
});

describe("headSnapshotHash", () => {
  it("is keccak256(abi.encode(uint8 state, uint64 revision, uint64 admission, bytes32 target))", () => {
    const want = keccak256(
      encodeAbiParameters(
        [{ type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }],
        [2, 7n, 41n, word(0xbeef)],
      ),
    );
    expect(headSnapshotHash(2, 7n, 41n, word(0xbeef))).toBe(want);
    // each field is bound: state, revision, admission, target
    const base = headSnapshotHash(1, 3n, 9n, word(1));
    expect(
      new Set([
        base,
        headSnapshotHash(2, 3n, 9n, word(1)),
        headSnapshotHash(1, 4n, 9n, word(1)),
        headSnapshotHash(1, 3n, 8n, word(1)),
        headSnapshotHash(1, 3n, 9n, word(2)),
      ]).size,
    ).toBe(5);
  });
});

describe("the writer's guard mode", () => {
  it('"auto" guards exactly when the Realm has the guard; "always" refuses without it; "never" never guards', () => {
    expect(guardingOn("auto", true)).toEqual({ ok: true, on: true });
    expect(guardingOn("auto", false)).toEqual({ ok: true, on: false });
    expect(guardingOn("never", true)).toEqual({ ok: true, on: false });
    expect(guardingOn("always", true)).toEqual({ ok: true, on: true });
    expect(guardingOn("always", false)).toMatchObject({
      ok: false,
      reason: { code: "NOT_VERIFIED_DEPLOYMENT", retry: "never" },
    });
  });
});

describe("a re-split part's pieces each carry their own actions' heads (PM condition 2)", () => {
  const action = (n: number): ActionData => ({
    kind: 3,
    typeId: ZERO_WORD,
    bodyHashOrRecordId: ZERO_WORD,
    purpose: ZERO_WORD,
    subject: ZERO_WORD,
    role: word(n),
    target: ZERO_WORD,
    expectedRevision: 1n,
    saltOrStrength: ZERO_WORD,
  });
  /** Four entries of two actions each (a move: the source and the destination head), every head guarded. */
  const part = (): SequencePart => {
    const units: PartUnit[] = Array.from({ length: 4 }, (_, u) => ({
      actions: 2,
      effect: { code: "files.move", args: { entry: String(u) } },
    }));
    const guard: PartGuardHead[] = Array.from({ length: 8 }, (_, i) => ({
      ...head(0, i),
      action: i,
    }));
    return {
      actions: Array.from({ length: 8 }, (_, i) => action(i)),
      bodies: Array.from({ length: 8 }, () => "0x" as Hex),
      effects: units.map((u) => u.effect),
      units,
      guard,
    };
  };
  it("each piece's guard is exactly the heads of its own actions, re-indexed to the piece", () => {
    const p = part();
    const [a, b] = resplit(p, 2) as SequencePart[];
    expect(a?.guard?.map((h) => [h.position, h.action])).toEqual(
      [0, 1, 2, 3].map((i) => [word(0x2000 + i), i]),
    );
    expect(b?.guard?.map((h) => [h.position, h.action])).toEqual(
      [4, 5, 6, 7].map((i) => [word(0x2000 + i), i - 4]),
    );
    // never the parent's: each piece encodes its own read set, and together they are the parent's heads, once each
    expect(encodeGuard(a?.guard ?? [])).not.toBe(encodeGuard(p.guard ?? []));
    expect([...(a?.guard ?? []), ...(b?.guard ?? [])].map((h) => h.position)).toEqual(
      (p.guard ?? []).map((h) => h.position),
    );
    // a piece with no guarded action carries no guard
    const unguarded = { ...p, guard: (p.guard ?? []).filter((h) => h.action < 4) };
    expect((resplit(unguarded, 2) as SequencePart[])[1]?.guard).toBeUndefined();
  });
  it("the parts hash a sequence records covers the guard: a changed head, value or action index changes it", () => {
    const p = part();
    const h = partsHashOf([p]);
    const g = p.guard as PartGuardHead[];
    const changed = (f: (x: PartGuardHead) => PartGuardHead) =>
      partsHashOf([{ ...p, guard: g.map((x, i) => (i === 3 ? f(x) : x)) }]);
    expect(changed((x) => ({ ...x, expected: word(1) }))).not.toBe(h);
    expect(changed((x) => ({ ...x, action: 2 }))).not.toBe(h);
    expect(changed((x) => ({ ...x, term: "twoWords" }))).not.toBe(h);
    expect(partsHashOf([{ ...p, guard: g.slice(1) }])).not.toBe(h);
    const { guard: _, ...bare } = p;
    expect(partsHashOf([bare])).not.toBe(h);
  });
  it("a part without a guard hashes exactly as before the guard, so a sequence journaled then still resumes", () => {
    const { guard: _, ...bare } = part();
    // the formula as it was (SDK main 4fda1fe): no guard key at all
    const before = keccak256(
      utf8Encode(
        toJson([
          {
            actions: bare.actions,
            bodies: bare.bodies,
            effects: bare.effects,
            units: bare.units ?? null,
            splitDepth: 0,
            deadlineSeconds: null,
            gas: null,
            total: null,
          },
        ]),
      ),
    );
    expect(partsHashOf([bare])).toBe(before);
  });
});

describe("the target a head's snapshot is over, and how a guarded head is priced (guardheads.ts)", () => {
  const T = word(0x7777);
  const R = word(0x4242);
  const h = (state: number, targetKind: number) => ({
    state,
    revision: state === 0 ? 0n : 3n,
    admission: 9n,
    targetKind,
    target: state === 1 ? T : ZERO_WORD,
  });
  it("BOUND: its target; never bound: 0; removed TAG, SAME, BROADER: the role; removed FOLDER, HEAD, PROPERTY: read", () => {
    expect(knownSnapshotTarget(h(1, 2), PURPOSES.folder, R)).toBe(T);
    expect(knownSnapshotTarget(h(0, 0), PURPOSES.folder, R)).toBe(ZERO_WORD);
    expect(knownSnapshotTarget(h(2, 0), PURPOSES.tag, R)).toBe(ZERO_WORD); // a lone no: never bound
    for (const p of [PURPOSES.tag, PURPOSES.same, PURPOSES.broader])
      for (const state of [2, 3]) expect(knownSnapshotTarget(h(state, 1), p, R)).toBe(R);
    for (const p of [PURPOSES.folder, PURPOSES.head, PURPOSES.property])
      for (const state of [2, 3]) expect(knownSnapshotTarget(h(state, 1), p, R)).toBeNull();
  });
  it("an UNBIND or RELEASE of a removed head that once bound is writtenUnread; every other write is written", () => {
    expect(writtenTerm(ACTION.UNBIND, h(2, 1))).toBe("writtenUnread");
    expect(writtenTerm(ACTION.RELEASE, h(2, 1))).toBe("writtenUnread");
    expect(writtenTerm(ACTION.UNBIND, h(3, 1))).toBe("writtenUnread");
    expect(writtenTerm(ACTION.UNBIND, h(2, 0))).toBe("written"); // a lone no again: no kept target
    expect(writtenTerm(ACTION.BIND, h(2, 1))).toBe("written"); // a restore reads the kept word itself
    expect(writtenTerm(ACTION.RELEASE, h(1, 1))).toBe("written");
    expect(writtenTerm(ACTION.BIND, h(0, 0))).toBe("written");
    expect(readTerm(h(1, 1))).toBe("twoWords");
    expect(readTerm(h(2, 1))).toBe("twoWords");
    expect(readTerm(h(0, 0))).toBe("oneWord");
  });
});

describe("withGuard: a guarded plan guards every head it writes, or refuses to plan", () => {
  const position = (role: Hex) => positionKey(PURPOSES.folder, word(0x1000), role);
  const bind = (kind: number, role: Hex) => ({
    action: {
      kind,
      typeId: ZERO_WORD,
      bodyHashOrRecordId: ZERO_WORD,
      purpose: PURPOSES.folder,
      subject: word(0x1000),
      role,
      target: ZERO_WORD,
      expectedRevision: 1n,
      saltOrStrength: ZERO_WORD,
    },
    body: "0x" as Hex,
  });
  const me = word(0xa0) as PrincipalId;
  const head = { state: 2, revision: 1n, admission: 4n, targetKind: 1, target: ZERO_WORD };
  const read = new Map([
    [position(word(0x31)).toLowerCase() as Hex, { expected: word(0xe1), target: word(0x77), head }],
  ]);
  it("attaches the written head's guard, priced by the action and the head", () => {
    const g = withGuard(bind(ACTION.UNBIND, word(0x31)), me, read);
    expect(g.guard).toEqual([
      {
        principal: me,
        position: position(word(0x31)).toLowerCase(),
        expected: word(0xe1),
        term: "writtenUnread",
      },
    ]);
    expect(withGuard(bind(ACTION.BIND, word(0x31)), me, read).guard?.[0]?.term).toBe("written");
  });
  it("leaves an action that writes no head as it is", () => {
    const publish = bind(ACTION.PUBLISH, word(0x31));
    expect(withGuard(publish, me, read)).toBe(publish);
  });
  it("a written head that was not read for its guard is INVARIANT, never sent bare", () => {
    expect(() => withGuard(bind(ACTION.RELEASE, word(0x32)), me, read)).toThrow(
      expect.objectContaining({ code: "INVARIANT" }),
    );
  });
});
