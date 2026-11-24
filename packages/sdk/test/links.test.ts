// SPDX-License-Identifier: MIT
// Object and revision links: canonical, fragment-safe, never mistaken for a path.
import { describe, expect, it } from "vitest";
import type { PrincipalId, RecordId, SubjectId } from "../src/core/hex.ts";
import { formatRealm, link, parseLink, splitRealm } from "../src/names/links.ts";
import { checkName } from "../src/names/name.ts";

const S = `0x${"ab".repeat(32)}` as SubjectId;
const R = `0x${"0c".repeat(32)}` as RecordId;
const A = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"; // an account
const KEY = `0x${"0".repeat(24)}${A.slice(2)}` as PrincipalId; // its key principal
const CONTRACT = `0x${"5e".repeat(32)}` as PrincipalId; // a contract principal (not address-shaped)

describe("links", () => {
  it("formats objects and revisions canonically, from link targets or file refs", () => {
    expect(link({ kind: "object", subject: S })).toBe(`~efs/o/${S}`);
    expect(link({ kind: "file", subject: S })).toBe(`~efs/o/${S}`);
    expect(link({ kind: "revision", recordId: R })).toBe(`~efs/v/${R}`);
    expect(link({ kind: "revision", recordId: R, file: S })).toBe(`~efs/v/${R}`);
    expect(
      link({ kind: "object", subject: S.toUpperCase().replace("0X", "0x") as SubjectId }),
    ).toBe(`~efs/o/${S}`);
    expect(() => link({ kind: "object", subject: "0x12" as SubjectId })).toThrow(/64 hex/);
  });

  it("round-trips, and reports a canonical form for routers to redirect to", () => {
    for (const target of [
      { kind: "object", subject: S },
      { kind: "revision", recordId: R },
    ] as const) {
      const p = parseLink(link(target));
      expect(p).toEqual({ status: "OK", target, canonical: link(target) });
      expect(parseLink(`/${link(target)}`)).toEqual(p);
    }
    const loud = parseLink(`~efs/o/0x${"AB".repeat(32)}`);
    expect(loud.status === "OK" && loud.canonical).toBe(`~efs/o/${S}`);
  });

  it("survives a URL fragment unchanged, and percent-encoded forms parse to the same target", () => {
    const l = link({ kind: "object", subject: S });
    const url = new URL(`https://app.example/#/files/${l}`);
    expect(url.hash).toBe(`#/files/${l}`);
    expect(parseLink(url.hash.slice("#/files/".length))).toMatchObject({ status: "OK" });
    expect(encodeURIComponent(l).replaceAll("%2F", "/")).toBe(l); // nothing to escape
    expect(parseLink(`%7Eefs/o/${S}`)).toEqual(parseLink(l));
    expect(parseLink(`~efs/%6F/${S}`)).toEqual(parseLink(l)); // one decode per segment
    // An escaped slash is part of a segment, never a separator.
    expect(parseLink(`%7Eefs%2Fo%2F${S}`)).toEqual({ status: "INVALID", rule: "reserved-name" });
  });

  it("carries an ordered Lens on object links: accounts as addresses, other principals as ids", () => {
    const target = { kind: "object" as const, subject: S, lens: { principals: [KEY, CONTRACT] } };
    const l = link(target);
    expect(l).toBe(`~efs/o/${S}?lens=${A},${CONTRACT}`);
    expect(parseLink(l)).toEqual({ status: "OK", target, canonical: l });
    const url = new URL(`https://app.example/#/r/sepolia/${l}`);
    expect(parseLink(url.hash.slice("#/r/sepolia/".length))).toEqual(parseLink(l));
    // encodeURIComponent'd commas decode once to the same Lens
    expect(parseLink(`~efs/o/${S}?lens=${encodeURIComponent(`${A},${CONTRACT}`)}`)).toEqual(
      parseLink(l),
    );
    expect(() =>
      link({ kind: "revision", recordId: R, lens: { principals: [KEY] } } as never),
    ).not.toThrow();
    expect(link({ kind: "revision", recordId: R, lens: { principals: [KEY] } } as never)).toBe(
      `~efs/v/${R}`,
    );
    expect(() => link({ ...target, lens: { principals: [KEY, KEY] } })).toThrow(/once/);
    expect(() => link({ ...target, lens: { principals: [] } })).toThrow(/1 to 64/);
  });

  it("never mistakes a path for a link, nor a link for a path", () => {
    expect(parseLink("docs/readme.txt")).toEqual({ status: "UNSUPPORTED", kind: "path" });
    expect(parseLink(`o/${S}`)).toEqual({ status: "UNSUPPORTED", kind: "path" }); // a root folder named "o"
    expect(parseLink("~efsfoo/x")).toEqual({ status: "INVALID", rule: "reserved-name" });
    // The prefix is reserved by the name profile, so no real segment can start a path with it.
    expect(checkName("~efs").status).toBe("INVALID");
  });

  it("refuses malformed links with a rule", () => {
    const rule = (s: string) => {
      const p = parseLink(s);
      return p.status === "INVALID" ? p.rule : p.status;
    };
    expect(rule("")).toBe("empty");
    expect(rule(`~efs/o/${S}#x`)).toBe("fragment");
    expect(rule("~efs/o/%zz")).toBe("bad-escape");
    expect(rule(`~efs/x/${S}`)).toBe("unknown-link-kind");
    expect(rule(`~efs/o/${S}/extra`)).toBe("bad-id");
    expect(rule("~efs/o/0x1234")).toBe("bad-id");
    expect(rule("~efs/o")).toBe("bad-id");
    expect(rule(`~efs/v/${R}?lens=${A}`)).toBe("unsupported-parameter"); // a revision needs no Lens
    expect(rule(`~efs/o/${S}?view=1`)).toBe("unsupported-parameter");
    expect(rule(`~efs/o/${S}?lens=${A}&x=1`)).toBe("unsupported-parameter");
    expect(rule(`~efs/o/${S}?lens=0x1`)).toBe("bad-lens");
    expect(rule(`~efs/o/${S}?lens=`)).toBe("bad-lens");
    expect(rule(`~efs/o/${S}?lens=${A},${A}`)).toBe("bad-lens");
    expect(rule(`~efs/o/${S}?lens=alice.eth,${A}`)).toBe("lens-name-unsupported");
  });
});

describe("the realm part of a route", () => {
  const LEDGER = "0x984bf266ea4f907afe58b5c25e31d3e0ba503373";
  const l = link({ kind: "object", subject: S });
  it("formats the full form, and splits it off a route, leaving the link", () => {
    expect(
      formatRealm({
        chainId: 11155111,
        ledger: LEDGER.toUpperCase().replace("0X", "0x") as `0x${string}`,
      }),
    ).toBe(`eip155:11155111/${LEDGER}`);
    const r = splitRealm(`eip155:11155111/${LEDGER}/${l}`);
    expect(r).toEqual({
      status: "FULL",
      realm: { chainId: 11155111, ledger: LEDGER },
      canonical: `eip155:11155111/${LEDGER}`,
      rest: l,
    });
    expect(r.status === "FULL" && parseLink(r.rest).status).toBe("OK");
    expect(splitRealm(`/eip155:1/${LEDGER}`)).toMatchObject({ status: "FULL", rest: "" });
    expect(splitRealm(`eip155%3A1/${LEDGER}/x`)).toMatchObject({ status: "FULL", rest: "x" });
  });
  it("passes aliases through for the app to resolve", () => {
    expect(splitRealm(`sepolia/${l}`)).toEqual({ status: "ALIAS", alias: "sepolia", rest: l });
    expect(splitRealm("local-1")).toEqual({ status: "ALIAS", alias: "local-1", rest: "" });
  });
  it("survives a URL fragment", () => {
    const url = new URL(
      `https://app.example/#/r/${formatRealm({ chainId: 1, ledger: LEDGER })}/${l}`,
    );
    const r = splitRealm(url.hash.slice("#/r/".length));
    expect(r.status === "FULL" && r.rest).toBe(l);
  });
  it("refuses malformed realms with a rule", () => {
    const rule = (s: string) => {
      const r = splitRealm(s);
      return r.status === "INVALID" ? r.rule : r.status;
    };
    expect(rule("")).toBe("empty");
    expect(rule("solana:abc/x")).toBe("unsupported-namespace");
    expect(rule(`eip155:01/${LEDGER}`)).toBe("bad-chain-id");
    expect(rule(`eip155:0x1/${LEDGER}`)).toBe("bad-chain-id");
    expect(rule(`eip155:99999999999999999/${LEDGER}`)).toBe("bad-chain-id");
    expect(rule("eip155:1")).toBe("bad-ledger");
    expect(rule("eip155:1/0x1234")).toBe("bad-ledger");
    expect(rule("Sepolia/x")).toBe("bad-alias");
    expect(rule("%zz/x")).toBe("bad-escape");
    expect(() => formatRealm({ chainId: 0, ledger: LEDGER })).toThrow(/positive/);
  });
});
