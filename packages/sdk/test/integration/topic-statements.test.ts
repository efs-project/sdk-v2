// SPDX-License-Identifier: MIT
// Topic statements and names on a real chain: labels per language (planLabel), "same as" and "broader" (planSame,
// planBroader), each registering the topics it needs in the same save; and the names a reader sees (labelOf,
// topicName) under a Lens: a path label, else the word's label, else the word, in the reader's languages, with a
// label that is not a text skipped and any failed read UNKNOWN, never "no name".
// Two accounts of anvil's public development mnemonic (indexes 20 and 21, used by no other test file), funded here.
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionResult, keccak256 } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { ACTION, type ActionData, createWriter, memoryJournal } from "../../src/actions/index.ts";
import { type BindRow, type PlannedAction, publicationGas } from "../../src/actions/split.ts";
import { createEfs } from "../../src/client.ts";
import { type Address, type Hex, lower, type PrincipalId, ZERO_WORD } from "../../src/core/hex.ts";
import { planCreateFile, planRemoveEntries } from "../../src/files/entries.ts";
import { gasSetup, plain, publish } from "../../src/files/plan.ts";
import {
  bitmapStoreAbi,
  indexAbi,
  ledgerViewsAbi,
  topicLookupReaderAbi,
} from "../../src/generated/abis.ts";
import { PURPOSES } from "../../src/generated/constants.ts";
import { parseLink } from "../../src/names/links.ts";
import { keyPrincipal } from "../../src/protocol/keys.ts";
import { fileNames } from "../../src/tags/filenames.ts";
import { lensTagsOf } from "../../src/tags/lenstags.ts";
import { labelOf, topicName } from "../../src/tags/names.ts";
import { planDeny, planTag, planUntag } from "../../src/tags/plan.ts";
import { topicItems } from "../../src/tags/read.ts";
import { planBroader, planLabel, planSame } from "../../src/tags/statements.ts";
import { topicBroader, topicSynonyms } from "../../src/tags/synonyms.ts";
import {
  labelKey,
  pathId,
  propertyAction,
  sameAction,
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
const STRANGER = `0x${"0".repeat(24)}${"57".repeat(20)}` as PrincipalId;

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
    // A provider that refuses batches of more than 100 calls: a 32-word topic in 8 languages is 504 label reads,
    // which must go in batches it takes.
    const capped = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: (async (url: string, init: { body?: string }) => {
        const body = JSON.parse(init.body ?? "null");
        if (Array.isArray(body) && body.length > 100) {
          const text = JSON.stringify(
            body.map((b: { id: number }) => ({
              jsonrpc: "2.0",
              id: b.id,
              error: { code: -32005, message: "batch too large" },
            })),
          );
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => text,
            arrayBuffer: async () => new TextEncoder().encode(text).buffer,
          };
        }
        return fetch(url, init as RequestInit);
      }) as never,
    });
    const deep = Array.from({ length: 32 }, (_, i) => `nmdeep${i}`);
    const many = await topicName(capped, deep, {
      lens: lens(C),
      langs: ["en", "de", "fr", "es", "it", "pt", "nl", "sv"],
    });
    expect(many).toMatchObject({ status: "PRESENT" });
    expect(many.status === "PRESENT" && many.segments.map((x) => x.source)).toEqual(
      deep.map(() => "none"),
    );
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

  it("each statement is priced by its own measured row (planning only; eth_estimateGas decides)", async () => {
    // contracts 0fb4804's rows: a first label bindPropertyFresh (with a new text, the text/1 row too), a later label
    // bindPropertyRebind, a removal releaseProperty, a first SAME bindSameFreshWord (the dearer first-SAME row), a
    // first BROADER bindBroaderFresh. Each part's gas is recomputed with the row it must use.
    const g = gasSetup(efs.deployment, {});
    if (!g.ok) throw new Error(g.reason.detail);
    const m = g.gas.model;
    const check = async (
      planned: Promise<unknown>,
      rows: (BindRow | "text/1")[],
      first: boolean,
    ) => {
      const p = (await planned) as {
        status: string;
        parts?: { actions: ActionData[]; bodies: Hex[] }[];
        review?: unknown;
      };
      if (p.status !== "PLANNED" || !p.parts) throw new Error(p.status);
      expect(p.parts.length).toBe(1);
      const part = p.parts[0] as { actions: ActionData[]; bodies: Hex[] };
      expect(part.actions.length).toBe(rows.length);
      const acts: PlannedAction[] = part.actions.map((a, i) =>
        rows[i] === "text/1"
          ? { action: a, body: part.bodies[i] as Hex, shape: "text/1" }
          : { action: a, body: "0x", bindRow: rows[i] as BindRow, firstStatement: first },
      );
      expect((p.review as { gas: { perPart: number[] } }).gas.perPart[0]).toBe(
        publicationGas(acts, m, true),
      );
    };
    await check(
      planLabel(efs, wd, { topic: ["nmcars"], lang: "fr", text: "Cars" }),
      ["bindPropertyFresh"],
      true,
    );
    await check(
      planLabel(efs, wd, { topic: ["nmcars"], lang: "it", text: "Un nome nuovo" }),
      ["text/1", "bindPropertyFresh"],
      true,
    );
    await check(
      planLabel(efs, wd, { topic: ["nmcars"], lang: "de", text: "Cars" }),
      ["bindPropertyRebind"],
      false,
    );
    await check(
      planLabel(efs, wd, { topic: ["nmcars"], lang: "de", remove: true }),
      ["releaseProperty"],
      false,
    );
    await check(
      planSame(efs, wd, { topic: ["nmcars"], other: ["nmtesla"] }),
      ["bindSameFreshWord"],
      true,
    );
    await check(
      planBroader(efs, wd, { topic: ["nmtesla"], broader: ["nmcars"] }),
      ["bindBroaderFresh"],
      true,
    );
  });
});

describe("a file's name in a topic (fixture)", () => {
  const text = (x: string) => new TextEncoder().encode(x);
  /** Place an existing file at `name` in `parent` (a raw FOLDER bind: no planner places someone else's file). */
  const place = async (w: typeof wc, parentWord: Hex, name: string, file: Hex) => {
    const nameType = efs.deployment.typeIds["files-name/2"] as Hex;
    const p = await w.planActions({
      actions: [
        publish(nameType, text(name), "files-name/2").action,
        plain({
          kind: ACTION.BIND,
          purpose: PURPOSES.folder,
          subject: parentWord,
          role: keccak256(text(name)),
          target: file,
        }).action,
      ],
      bodies: [publish(nameType, text(name), "files-name/2").body, "0x"],
      effects: [{ code: "test.place", args: {} }],
    });
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect((await w.run(p.plan)).reconcile?.outcome).toBe("COMMITTED");
  };
  let F: Hex;
  const cleoHome = () => ({
    kind: "home" as const,
    address: cleo.address.toLowerCase() as Address,
  });

  it("the tagger's own name for it, else its creator's, else the first from the Lens", async () => {
    const made = await run(
      wc,
      planCreateFile(efs, wc, { folder: cleoHome(), name: "report.pdf", content: text("r") }),
    );
    F = (made["file"] as { subject: Hex }).subject;
    await place(wd, keyPrincipal(dov.address), "dovs-copy.pdf", F); // Dov's own home
    await place(wd, keyPrincipal(cleo.address), "dov-was-here.pdf", F); // newer, but in Cleo's home: not his own place
    const named = await fileNames(
      efs,
      [{ file: F, tagger: D }, { file: F }, { file: F, tagger: STRANGER }],
      {
        lens: lens(C),
      },
    );
    expect(named).toMatchObject({
      status: "PRESENT",
      rows: [
        {
          file: F,
          creator: C,
          complete: true,
          name: {
            text: "dovs-copy.pdf",
            author: D,
            why: "tagger",
            folder: { kind: "home", address: dov.address.toLowerCase() },
          },
        },
        { name: { text: "report.pdf", author: C, why: "creator" } },
        { name: { text: "report.pdf", why: "creator" } }, // a tagger with no entry of their own
      ],
    });
  });

  it("an entry counts only while its author still binds the file there; nothing is null, proven when complete", async () => {
    // Cleo removes her report.pdf: her backlink stays in the append-only list, but is no longer current.
    await run(
      wc,
      planRemoveEntries(efs, wc, { entries: [{ folder: cleoHome(), name: "report.pdf" }] }),
    );
    expect(await fileNames(efs, [{ file: F }], { lens: lens(D) })).toMatchObject({
      rows: [{ name: { author: D, why: "lens", text: "dov-was-here.pdf" } }], // Dov's newest
    });
    expect(await fileNames(efs, [{ file: F }], { lens: lens(STRANGER) })).toMatchObject({
      rows: [{ name: null, complete: true }],
    });
    // Reading fewer entries than the list holds: a null is not proven.
    expect(await fileNames(efs, [{ file: F }], { lens: lens(STRANGER), scan: 1 })).toMatchObject({
      rows: [{ name: null, complete: false }],
    });
  });

  it("a thing placed nowhere has no name, proven: its list is empty (no slice is read)", async () => {
    const nowhere = pathId(T, ["nmcars"]); // a topic: never a folder entry's target
    expect(await fileNames(efs, [{ file: nowhere }, { file: F }], { lens: lens(D) })).toMatchObject(
      {
        status: "PRESENT",
        rows: [{ name: null, creator: null, complete: true }, { name: { author: D } }],
      },
    );
  });

  it("a failed read is UNKNOWN, never no name", async () => {
    const fail: Edit = () => ({ error: { code: -32000, message: "the node is sick" } });
    const sick = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({ [sel(indexAbi, "postingSliceOf")]: fail }),
    });
    expect(await fileNames(sick, [{ file: F }])).toMatchObject({ status: "UNKNOWN" });
  });
});

describe("synonyms: gathering at both levels (fixture)", () => {
  const pid = (words: string[]) => pathId(T, words);
  it("word pages joined by same are word-level synonyms and joined places, found from either side, hop by hop", async () => {
    await run(wc, planSame(efs, wc, { topic: ["sycar"], other: ["sycars"] }));
    await run(wd, planSame(efs, wd, { topic: ["sycars"], other: ["syauto"] }));
    const both = await topicSynonyms(efs, ["sycar"], { lens: lens(C, D) });
    expect(both).toMatchObject({
      status: "PRESENT",
      topic: { words: ["sycar"] },
      places: [
        { id: pid(["sycars"]), kind: "word", hops: 1, author: C },
        { id: pid(["syauto"]), kind: "word", hops: 2, author: D },
      ],
      words: [
        {
          word: "sycar",
          synonyms: [
            { word: "sycars", hops: 1 },
            { word: "syauto", hops: 2 },
          ],
        },
      ],
      limited: false,
      complete: true,
    });
    // From the other end: the same edges, found through the lists that name it.
    expect(await topicSynonyms(efs, ["syauto"], { lens: lens(C, D) })).toMatchObject({
      places: [
        { id: pid(["sycars"]), hops: 1, author: D },
        { id: pid(["sycar"]), hops: 2, author: C },
      ],
    });
    // Only Cleo in the Lens: Dov's edge doesn't count.
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C) })).toMatchObject({
      places: [{ id: pid(["sycars"]) }],
    });
    // One hop: the gathering says it stopped early.
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C, D), maxHops: 1 })).toMatchObject({
      places: [{ id: pid(["sycars"]) }],
      limited: true,
    });
  });

  it("path to path and word page to path join places only, with no word-level effect", async () => {
    await run(
      wc,
      planSame(efs, wc, {
        topic: ["sybrands", "sytesla"],
        other: ["sycompanies", "sytesla_motors"],
      }),
    );
    await run(wd, planSame(efs, wd, { topic: ["sytsla"], other: ["sybrands", "sytesla"] }));
    const r = await topicSynonyms(efs, ["sybrands", "sytesla"], { lens: lens(C, D) });
    if (r.status !== "PRESENT") throw new Error(r.status);
    expect([...r.places].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        {
          id: pid(["sycompanies", "sytesla_motors"]),
          kind: "path",
          hops: 1,
          author: C,
          said: {
            subject: pid(["sybrands", "sytesla"]),
            other: pid(["sycompanies", "sytesla_motors"]),
          },
        },
        {
          id: pid(["sytsla"]),
          kind: "word",
          hops: 1,
          author: D,
          said: { subject: pid(["sytsla"]), other: pid(["sybrands", "sytesla"]) },
        },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(r.words.map((w) => [w.word, w.synonyms.length])).toEqual([
      ["sybrands", 0],
      ["sytesla", 0],
    ]);
    // From the word page's side: the path is a joined place, but not a word-level synonym of the word.
    expect(await topicSynonyms(efs, ["sytsla"], { lens: lens(C, D) })).toMatchObject({
      places: [{ id: pid(["sybrands", "sytesla"]), kind: "path", hops: 1, author: D }, { hops: 2 }],
      words: [{ word: "sytsla", synonyms: [] }],
    });
  });

  it("an earlier Lens author's 'not the same' (MASKED) decides that edge; a failed read is UNKNOWN", async () => {
    const notSame = await wd.planActions({
      actions: [
        {
          ...sameAction(pid(["sycar"]), pid(["sycars"]), 0n),
          kind: ACTION.UNBIND,
          target: ZERO_WORD,
        },
      ],
      bodies: ["0x"],
      effects: [{ code: "test.notSame", args: {} }],
    });
    if (notSame.status !== "PLANNED") throw new Error(notSame.status);
    expect((await wd.run(notSame.plan)).reconcile?.outcome).toBe("COMMITTED");
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(D, C) })).toMatchObject({ places: [] });
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C, D) })).toMatchObject({
      places: [{ id: pid(["sycars"]), author: C }, { id: pid(["syauto"]) }],
    });
    const fail: Edit = () => ({ error: { code: -32000, message: "the node is sick" } });
    const sick = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({ [sel(bitmapStoreAbi, "scopeHead")]: fail }),
    });
    expect(await topicSynonyms(sick, ["sycar"], { lens: lens(C) })).toMatchObject({
      status: "UNKNOWN",
    });
  });
});

describe("tag saves name what they touch (fixture)", () => {
  it("planTag, planUntag and planLabel saves carry their effect on the record, and resume reports it", async () => {
    const thing = pathId(T, ["nmcars"]); // a topic is a thing a tag can be about
    const tagged = await planTag(efs, wc, {
      topic: ["nmfx", "nmdeep"],
      targets: [{ kind: "topic", id: thing }],
      number: 2,
    });
    if (tagged.status !== "PLANNED") throw new Error(tagged.status);
    const done = await wc.runSequence(tagged.parts);
    expect(done).toMatchObject({
      state: "COMPLETE",
      effect: {
        kind: "tags.tag",
        topic: pathId(T, ["nmfx", "nmdeep"]),
        number: 2,
        targets: [lower(thing)],
      },
    });
    expect((await wc.resume(done.sequenceId)).effect).toEqual(done.effect);
    const untagged = await planUntag(efs, wc, {
      topic: ["nmfx", "nmdeep"],
      targets: [{ kind: "topic", id: thing }],
    });
    if (untagged.status !== "PLANNED") throw new Error(untagged.status);
    expect(await wc.runSequence(untagged.parts)).toMatchObject({
      effect: { kind: "tags.untag", topic: pathId(T, ["nmfx", "nmdeep"]), targets: [lower(thing)] },
    });
    const labelled = await planLabel(efs, wc, { topic: ["nmfx"], lang: "en", text: "Effects" });
    if (labelled.status !== "PLANNED") throw new Error(labelled.status);
    const l = await wc.runSequence(labelled.parts);
    expect(l.effect).toEqual({
      kind: "tags.label",
      subject: pathId(T, ["nmfx"]),
      lang: "en",
      remove: false,
    });
    expect((await wc.resume(l.sequenceId)).effect).toEqual(l.effect);
  });

  it("a list longer than `scan` is limited and not complete; so is a walk cut at its hop bound", async () => {
    // Cleo says sycar is the same as a second word too: her list for sycar now holds two statements.
    await run(wc, planSame(efs, wc, { topic: ["sycar"], other: ["syvehicle"] }));
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C), scan: 1 })).toMatchObject({
      limited: true,
      complete: false,
    });
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C, D), maxHops: 1 })).toMatchObject({
      limited: true,
      complete: false,
    });
    expect(await topicSynonyms(efs, ["sycar"], { lens: lens(C) })).toMatchObject({
      limited: false,
      complete: true,
    });
  });
});

describe("lensTagsOf: a thing's tags as a Lens sees them (fixture)", () => {
  const X = () => pathId(T, ["nmcars"]); // the thing: any id the chain tags
  const ofX = (r: { status: string; rows?: readonly { topic: Hex }[] }) =>
    r.status === "PRESENT" ? (r.rows ?? []).map((x) => x.topic) : r.status;
  const thing = () => ({ kind: "topic" as const, id: X() });
  it("the Lens tier and the public tier, apart; a Lens author's 'not this' hides it; Mine keeps the Lens only", async () => {
    await run(wc, planTag(efs, wc, { topic: ["lt1"], targets: [thing()], number: 5 }));
    await run(wd, planTag(efs, wd, { topic: ["lt2"], targets: [thing()], number: 1 }));
    await run(wd, planDeny(efs, wd, { topic: ["lt1"], targets: [thing()] }));
    const lt1 = lower(pathId(T, ["lt1"]));
    const lt2 = lower(pathId(T, ["lt2"]));
    const cleoView = await lensTagsOf(efs, X(), { lens: lens(C) });
    if (cleoView.status !== "PRESENT") throw new Error(cleoView.status);
    expect(cleoView.finished).toBe(true);
    const byTopic = Object.fromEntries(cleoView.rows.map((x) => [x.topic, x]));
    expect(byTopic[lt1]).toMatchObject({
      number: 5,
      decider: { kind: "lens", index: 0, author: C, number: 5 },
    });
    expect(byTopic[lt2]).toMatchObject({ number: 0, decider: { kind: "public" }, yes: 1n });
    // Dov first: his "not this" at lt1 decides it (hidden, counted); his own yes at lt2 is the Lens tier.
    const dovFirst = await lensTagsOf(efs, X(), { lens: lens(D, C) });
    if (dovFirst.status !== "PRESENT") throw new Error(dovFirst.status);
    expect(dovFirst.rows.map((x) => x.topic)).not.toContain(lt1);
    expect(dovFirst.rows.find((x) => x.topic === lt2)).toMatchObject({
      decider: { kind: "lens", author: D, number: 1 },
    });
    expect(dovFirst.counts.deniedByLens).toBeGreaterThanOrEqual(1);
    // Mine: only what a Lens author says yes to.
    const mine = await lensTagsOf(efs, X(), { view: "mine", lens: lens(C) });
    expect(ofX(mine)).toContain(lt1);
    expect(ofX(mine)).not.toContain(lt2);
  });

  it("pages of one row: never the end until the chain says so, and no place twice", async () => {
    await run(wc, planTag(efs, wc, { topic: ["lt3"], targets: [thing()] }));
    const all = await lensTagsOf(efs, X(), { lens: lens(C) });
    if (all.status !== "PRESENT") throw new Error(all.status);
    const got: Hex[] = [];
    let cursor: unknown;
    for (let i = 0; i < 20; i++) {
      const p = await lensTagsOf(efs, X(), {
        lens: lens(C),
        rows: 1,
        ...(cursor ? { cursor: cursor as never } : {}),
      });
      if (p.status !== "PRESENT") throw new Error(p.status);
      expect(p.rows.length).toBeLessThanOrEqual(1);
      got.push(...p.rows.map((x) => x.topic));
      if (p.finished) break;
      expect(p.next).toBeDefined();
      cursor = p.next;
    }
    expect(new Set(got).size).toBe(got.length);
    expect([...got].sort()).toEqual(all.rows.map((x) => x.topic).sort());
  });

  it("a forged reply is UNKNOWN, never a row: a place about another thing, a deciding yes about another thing", async () => {
    const edit =
      (abi: readonly unknown[], fn: string, f: (out: unknown[]) => unknown[]): Edit =>
      (result) =>
        encodeFunctionResult({
          abi: abi as never,
          functionName: fn,
          result: f(
            decodeFunctionResult({
              abi: abi as never,
              functionName: fn,
              data: result,
            } as never) as unknown[],
          ) as never,
        } as never) as Hex;
    const otherThing = `0x${"5e".repeat(32)}`;
    const placeLies = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({
        [sel(topicLookupReaderAbi, "about")]: edit(topicLookupReaderAbi, "about", (out) => [
          out[0],
          (out[1] as Record<string, unknown>[]).map((r) => ({ ...r, thing: otherThing })),
        ]),
      }),
    });
    expect(await lensTagsOf(placeLies, X(), { lens: lens(C) })).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
    // A reply that lists every place twice: each is returned once, the repeats counted.
    const twice = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({
        [sel(topicLookupReaderAbi, "about")]: edit(topicLookupReaderAbi, "about", (out) => [
          out[0],
          [...(out[1] as unknown[]), ...(out[1] as unknown[])],
        ]),
      }),
    });
    const once = await lensTagsOf(twice, X(), { lens: lens(C) });
    if (once.status !== "PRESENT") throw new Error(once.status);
    expect(new Set(once.rows.map((x) => x.topic)).size).toBe(once.rows.length);
    expect(once.counts.repeatsSkipped).toBe(once.rows.length);
    const headLies = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({
        [sel(ledgerViewsAbi, "headsAt")]: edit(ledgerViewsAbi, "headsAt", (out) =>
          out.map((x, i) =>
            i === 3
              ? (x as Record<string, unknown>[]).map((h) => ({ ...h, target: otherThing }))
              : x,
          ),
        ),
      }),
    });
    expect(await lensTagsOf(headLies, X(), { lens: lens(C) })).toMatchObject({
      status: "UNKNOWN",
      reason: { code: "RPC_ERROR" },
    });
    const fail: Edit = () => ({ error: { code: -32000, message: "the node is sick" } });
    const sick = createEfs({
      rpcs: [fixture.rpcUrl],
      deployment,
      fetch: tampered({ [sel(ledgerViewsAbi, "headsAt")]: fail }),
    });
    expect(await lensTagsOf(sick, X(), { lens: lens(C) })).toMatchObject({ status: "UNKNOWN" });
  });
});

describe("synonym direction and broader reads (fixture)", () => {
  const pid = (words: string[]) => lower(pathId(T, words));
  it("a joined place says which way its deciding statement points", async () => {
    // Dov said sycars is the same as syauto; Cleo said sycar is the same as sycars.
    const r = await topicSynonyms(efs, ["syauto"], { lens: lens(C, D) });
    if (r.status !== "PRESENT") throw new Error(r.status);
    const at = (id: string) => r.places.find((x) => x.id === id);
    expect(at(pid(["sycars"]))).toMatchObject({
      hops: 1,
      author: D,
      said: { subject: pid(["sycars"]), other: pid(["syauto"]) },
    });
    expect(at(pid(["sycar"]))).toMatchObject({
      hops: 2,
      author: C,
      said: { subject: pid(["sycar"]), other: pid(["sycars"]) },
    });
  });

  it("topicBroader lists what a topic is under and what is under it, each decided by the Lens", async () => {
    // Dov said /nmcars/nmtesla is narrower than /nmcars (an earlier test).
    const up = await topicBroader(efs, ["nmcars", "nmtesla"], { lens: lens(D) });
    expect(up).toMatchObject({
      status: "PRESENT",
      broader: [
        {
          id: pid(["nmcars"]),
          kind: "word",
          author: D,
          said: { subject: pid(["nmcars", "nmtesla"]), other: pid(["nmcars"]) },
        },
      ],
      narrower: [],
      limited: false,
      complete: true,
    });
    const down = await topicBroader(efs, ["nmcars"], { lens: lens(D) });
    if (down.status !== "PRESENT") throw new Error(down.status);
    expect(down.narrower.find((x) => x.id === pid(["nmcars", "nmtesla"]))).toMatchObject({
      kind: "path",
      author: D,
      said: { subject: pid(["nmcars", "nmtesla"]), other: pid(["nmcars"]) },
    });
    // Nobody in the Lens said it: nothing, proven.
    expect(await topicBroader(efs, ["nmcars", "nmtesla"], { lens: lens(STRANGER) })).toMatchObject({
      broader: [],
      narrower: [],
      complete: true,
    });
    // The release a row offers its author: planBroader with the row's own ends.
    expect(
      await planBroader(efs, wd, {
        topic: ["nmcars", "nmtesla"],
        broader: ["nmcars"],
        remove: true,
      }),
    ).toMatchObject({ status: "PLANNED" });
  });
});

describe("the interim fold on a real chain (fixture)", () => {
  it("a typed word saves and reads as its fold: My Notes is my_notes everywhere, and a mixed word is judged as typed", async () => {
    const fileRef = (
      (await run(
        wc,
        planCreateFile(efs, wc, {
          folder: { kind: "home", address: cleo.address },
          name: "fold.txt",
          content: new TextEncoder().encode("fold"),
          lens: lens(C),
        }) as never,
      )) as { file: { kind: "file"; subject: Hex } }
    ).file;
    const p = await planTag(efs, wc, { topic: ["My Notes", "  Todo "], targets: [fileRef] });
    if (p.status !== "PLANNED") throw new Error(p.status);
    expect(p.review.place).toMatchObject({ kind: "topic", words: ["my_notes", "todo"] });
    expect((await wc.runSequence(p.parts)).state).toBe("COMPLETE");
    const typed = await topicItems(efs, ["MY NOTES", "Todo"], { view: "mine", lens: lens(C) });
    const folded = await topicItems(efs, ["my_notes", "todo"], { view: "mine", lens: lens(C) });
    expect(typed.status === "PRESENT" && typed.place).toBe(pathId(T, ["my_notes", "todo"]));
    expect(typed.status === "PRESENT" && typed.rows.map((r) => r.thing)).toEqual(
      folded.status === "PRESENT" ? folded.rows.map((r) => r.thing) : null,
    );
    // A word that mixes ASCII capitals with other text is left as typed, and the grammar refuses it as today.
    await expect(planTag(efs, wc, { topic: ["Straße"], targets: [fileRef] })).rejects.toThrow(
      /not a word the chain admits/,
    );
    // Until the fold is ruled, a write refuses a word a ruling could fold differently (here É): an app can show the
    // copy. Reads and links still take it as typed, so nothing written earlier becomes unreachable.
    await expect(planTag(efs, wc, { topic: ["École"], targets: [fileRef] })).rejects.toMatchObject({
      code: "MISUSE",
      details: { rule: "unstable-until-ruled", check: "lowercase" },
    });
    await expect(planTag(efs, wc, { topic: ["École"], targets: [fileRef] })).rejects.toThrow(
      /can't be used until the tag text rule is chosen/,
    );
    expect((await topicItems(efs, ["École"], { view: "mine", lens: lens(C) })).status).toBe(
      "PRESENT",
    );
    expect(parseLink("École")).toMatchObject({ status: "OK", target: { words: ["École"] } });
  });
});
