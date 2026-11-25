// SPDX-License-Identifier: MIT
// Topic statements and names on a real chain: labels per language (planLabel), "same as" and "broader" (planSame,
// planBroader), each registering the topics it needs in the same save; and the names a reader sees (labelOf,
// topicName) under a Lens: a path label, else the word's label, else the word, in the reader's languages, with a
// label that is not a text skipped and any failed read UNKNOWN, never "no name".
// Two accounts of anvil's public development mnemonic (indexes 20 and 21, used by no other test file), funded here.
import { readFileSync } from "node:fs";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { createEfs } from "../../src/client.ts";
import { type PrincipalId, ZERO_WORD } from "../../src/core/hex.ts";
import { ledgerViewsAbi } from "../../src/generated/abis.ts";
import { labelOf, topicName } from "../../src/tags/names.ts";
import { planBroader, planLabel, planSame } from "../../src/tags/statements.ts";
import {
  labelKey,
  pathId,
  propertyAction,
  topicTypesOf,
  wordPageId,
} from "../../src/tags/topics.ts";
import { type Edit, sel, tampered } from "./tamper.ts";

const fixture = inject("fixture") as { rpcUrl: string; deployment: string };
const deployment = JSON.parse(readFileSync(fixture.deployment, "utf8")) as Record<string, unknown>;
const efs = createEfs({ rpcs: [fixture.rpcUrl], deployment });
const T = topicTypesOf(efs.deployment);
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public dev mnemonic
const cleo = mnemonicToAccount(MNEMONIC, { addressIndex: 20 });
const dov = mnemonicToAccount(MNEMONIC, { addressIndex: 21 });
const journal = memoryJournal();
const writerFor = (account: typeof cleo) =>
  createWriter(efs, { authorizer: { kind: "local", profile: "direct", account }, journal });
let wc: Awaited<ReturnType<typeof writerFor>>;
let wd: Awaited<ReturnType<typeof writerFor>>;
let C: PrincipalId;
let D: PrincipalId;
const lens = (...ps: PrincipalId[]) => ({ principals: ps });

const run = async (
  writer: typeof wc,
  planned: Promise<{ status: string } & Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  const p = (await planned) as { status: string; parts?: unknown[]; review?: unknown };
  if (p.status !== "PLANNED")
    throw new Error(
      `not planned: ${JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? `${v}` : v))}`,
    );
  expect((await writer.runSequence(p.parts as never)).state).toBe("COMPLETE");
  return p.review as Record<string, unknown>;
};

beforeAll(async () => {
  for (const a of [cleo, dov])
    await fetch(fixture.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "anvil_setBalance",
        params: [a.address, "0x56bc75e2d63100000"],
      }),
    });
  wc = await writerFor(cleo);
  wd = await writerFor(dov);
  C = wc.principal;
  D = wd.principal;
});

describe("labels: plan and read (fixture)", () => {
  it("a label registers its topic and text in one save; a path label, else the word's, else the word", async () => {
    const first = await run(
      wc,
      planLabel(efs, wc, { topic: ["nmcars"], lang: "en", text: "Cars" }),
    );
    expect(first).toMatchObject({
      kind: "efs.topicStatementReview",
      purpose: "label",
      lang: "en",
      text: "Cars",
      before: null,
      newTopics: [{ words: ["nmcars"] }],
      records: 2, // the word page and the text
    });
    await run(
      wc,
      planLabel(efs, wc, { topic: ["nmcars", "nmtesla"], lang: "en", text: "Tesla, Inc." }),
    );
    // The word "nmtesla" already has its page: only the text is new.
    expect(
      await run(wc, planLabel(efs, wc, { topic: ["nmtesla"], lang: "en", text: "Tesla" })),
    ).toMatchObject({ newTopics: [], records: 1 });

    const named = await topicName(efs, ["nmcars", "nmtesla"], { lens: lens(C), langs: ["en"] });
    expect(named).toMatchObject({
      status: "PRESENT",
      skipped: 0,
      segments: [
        { word: "nmcars", name: "Cars", source: "word", label: { author: C, lang: "en" } },
        { word: "nmtesla", name: "Tesla, Inc.", source: "path" },
      ],
    });
    // Another place using the word: no path label there, so the word's own label; a word nobody labels is itself.
    expect(
      await topicName(efs, ["nmpeople", "nmtesla"], { lens: lens(C), langs: ["en"] }),
    ).toMatchObject({
      segments: [
        { word: "nmpeople", name: "nmpeople", source: "none" },
        { word: "nmtesla", name: "Tesla", source: "word" },
      ],
    });
    // By id: the words are read back first.
    expect(
      await topicName(
        efs,
        { kind: "topic", id: pathId(T, ["nmcars", "nmtesla"]) },
        { lens: lens(C), langs: ["en"] },
      ),
    ).toMatchObject({ status: "PRESENT", segments: [{ name: "Cars" }, { name: "Tesla, Inc." }] });
  });

  it("languages in the reader's order, and the Lens per language", async () => {
    await run(wd, planLabel(efs, wd, { topic: ["nmcars"], lang: "de", text: "Autos" }));
    // Dov alone has no English label: his German one is the next language.
    expect(await labelOf(efs, ["nmcars"], { lens: lens(D), langs: ["en", "de"] })).toMatchObject({
      status: "PRESENT",
      label: { text: "Autos", lang: "de", author: D },
    });
    // The first language with a label wins, whoever in the Lens says it: German first gives Dov's.
    expect(await labelOf(efs, ["nmcars"], { lens: lens(C, D), langs: ["de", "en"] })).toMatchObject(
      {
        label: { text: "Autos", author: D },
      },
    );
    // English first: Dov said nothing in English, so Cleo's, though Dov comes first in the Lens.
    expect(await labelOf(efs, ["nmcars"], { lens: lens(D, C), langs: ["en"] })).toMatchObject({
      label: { text: "Cars", author: C },
    });
    // Nobody in the Lens labels it in these languages: proven, not unknown.
    expect(await labelOf(efs, ["nmcars"], { lens: lens(D), langs: ["fr"] })).toMatchObject({
      status: "ABSENT_PROVEN",
    });
  });

  it("the same label again is UNCHANGED; remove takes it back; a tag's case is folded", async () => {
    expect(await planLabel(efs, wc, { topic: ["nmcars"], lang: "EN", text: "Cars" })).toMatchObject(
      {
        status: "REFUSED",
        code: "UNCHANGED",
      },
    );
    const removed = await run(
      wc,
      planLabel(efs, wc, { topic: ["nmcars"], lang: "en", remove: true }),
    );
    expect(removed).toMatchObject({ remove: true, before: { state: "BOUND" } });
    expect(await labelOf(efs, ["nmcars"], { lens: lens(C), langs: ["en"] })).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    expect(await planLabel(efs, wc, { topic: ["nmcars"], lang: "en", remove: true })).toMatchObject(
      {
        status: "REFUSED",
        code: "NOT_STATED",
      },
    );
    // Back again, written in another case: the same key.
    await run(wc, planLabel(efs, wc, { topic: ["nmcars"], lang: "EN", text: "Cars" }));
    expect(await labelOf(efs, ["nmcars"], { lens: lens(C), langs: ["en"] })).toMatchObject({
      label: { text: "Cars", lang: "en" },
    });
    await expect(planLabel(efs, wc, { topic: ["nmcars"], lang: "e", text: "x" })).rejects.toThrow(
      /BCP 47/,
    );
    await expect(planLabel(efs, wc, { topic: ["nmcars"], lang: "en", text: "" })).rejects.toThrow(
      /text the chain admits/,
    );
  });

  it("a label that is not a text is skipped for the next Lens author; a failed read is UNKNOWN, never no name", async () => {
    // Dov binds his English label of nmcars to a record that is not a text/1 (the word's page): the chain allows it.
    const junk = await wd.planActions({
      actions: [
        propertyAction(wordPageId(T, "nmcars"), labelKey("en"), wordPageId(T, "nmcars"), 0n),
      ],
      bodies: ["0x"],
      effects: [{ code: "test.junkLabel", args: {} }],
    });
    if (junk.status !== "PLANNED") throw new Error(junk.status);
    expect((await wd.run(junk.plan)).reconcile?.outcome).toBe("COMMITTED");
    expect(await labelOf(efs, ["nmcars"], { lens: lens(D, C), langs: ["en"] })).toMatchObject({
      status: "PRESENT",
      label: { text: "Cars", author: C },
      skipped: 1,
    });
    // Dov's "no label" (a MASKED statement) at nmtesla's English label stops English for a Lens that puts him first:
    // Cleo's "Tesla" behind it is not shown, and the next language is tried.
    const mask = await wd.planActions({
      actions: [
        {
          ...propertyAction(wordPageId(T, "nmtesla"), labelKey("en"), wordPageId(T, "nmtesla"), 0n),
          kind: ACTION.UNBIND,
          target: ZERO_WORD,
        },
      ],
      bodies: ["0x"],
      effects: [{ code: "test.maskLabel", args: {} }],
    });
    if (mask.status !== "PLANNED") throw new Error(mask.status);
    expect((await wd.run(mask.plan)).reconcile?.outcome).toBe("COMMITTED");
    expect(await labelOf(efs, ["nmtesla"], { lens: lens(D, C), langs: ["en"] })).toMatchObject({
      status: "ABSENT_PROVEN",
    });
    expect(await labelOf(efs, ["nmtesla"], { lens: lens(C, D), langs: ["en"] })).toMatchObject({
      label: { text: "Tesla", author: C },
    });
    // Every label read failing: UNKNOWN.
    const fail: Edit = () => ({ error: { code: -32000, message: "the node is sick" } });
    const sick = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({ [sel(ledgerViewsAbi, "headsAt")]: fail }),
    });
    expect(await topicName(sick, ["nmcars"], { lens: lens(C), langs: ["en"] })).toMatchObject({
      status: "UNKNOWN",
    });
    expect(await labelOf(sick, ["nmcars"], { lens: lens(C), langs: ["en"] })).toMatchObject({
      status: "UNKNOWN",
    });
  });
});

describe("same as and broader (fixture)", () => {
  it("a first SAME registers both ends earlier in the same save, and the chain admits it", async () => {
    const r = await run(wc, planSame(efs, wc, { topic: ["nmx", "nmy"], other: ["nmz"] }));
    expect(r).toMatchObject({
      purpose: "same",
      other: { words: ["nmz"], id: pathId(T, ["nmz"]) },
      newTopics: [{ words: ["nmx"] }, { words: ["nmx", "nmy"] }, { words: ["nmz"] }],
      records: 4, // the pages nmx, nmy and nmz, and the path record nmx/nmy
    });
    expect(await planSame(efs, wc, { topic: ["nmx", "nmy"], other: ["nmz"] })).toMatchObject({
      status: "REFUSED",
      code: "UNCHANGED",
    });
    await run(wc, planSame(efs, wc, { topic: ["nmx", "nmy"], other: ["nmz"], remove: true }));
    expect(
      await planSame(efs, wc, { topic: ["nmx", "nmy"], other: ["nmz"], remove: true }),
    ).toMatchObject({
      status: "REFUSED",
      code: "NOT_STATED",
    });
  });

  it("broader between registered topics; a topic is never the same as, or narrower than, itself", async () => {
    expect(
      await run(wd, planBroader(efs, wd, { topic: ["nmcars", "nmtesla"], broader: ["nmcars"] })),
    ).toMatchObject({ purpose: "broader", newTopics: [], records: 0 });
    expect(
      await planBroader(efs, wd, { topic: ["nmcars", "nmtesla"], broader: ["nmcars"] }),
    ).toMatchObject({
      code: "UNCHANGED",
    });
    await expect(planSame(efs, wc, { topic: ["nmcars"], other: ["nmcars"] })).rejects.toThrow(
      /itself/,
    );
    await expect(
      planSame(efs, wc, { topic: { kind: "home" } as never, other: ["nmcars"] }),
    ).rejects.toThrow();
  });

  it("the planned gas covers the contracts' measured figures (planning only; eth_estimateGas decides)", async () => {
    // contracts step 2, each alone: label with a new text 983,001, with an existing one 684,437; SAME 689,400;
    // BROADER 694,701.
    const gasOf = (p: { status: string; review?: { gas: { perPart: readonly number[] } } }) => {
      if (p.status !== "PLANNED" || !p.review) throw new Error(p.status);
      return p.review.gas.perPart.reduce((a, b) => a + b, 0);
    };
    expect(
      gasOf(
        (await planLabel(efs, wd, { topic: ["nmcars"], lang: "en", text: "A new name" })) as never,
      ),
    ).toBeGreaterThanOrEqual(983_001);
    expect(
      gasOf((await planLabel(efs, wd, { topic: ["nmcars"], lang: "fr", text: "Cars" })) as never),
    ).toBeGreaterThanOrEqual(684_437);
    expect(
      gasOf((await planSame(efs, wd, { topic: ["nmcars"], other: ["nmtesla"] })) as never),
    ).toBeGreaterThanOrEqual(689_400);
    expect(
      gasOf((await planBroader(efs, wd, { topic: ["nmtesla"], broader: ["nmcars"] })) as never),
    ).toBeGreaterThanOrEqual(694_701);
  });
});
