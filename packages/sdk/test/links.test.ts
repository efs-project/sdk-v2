// SPDX-License-Identifier: MIT
// Object and revision links: canonical, fragment-safe, never mistaken for a path.
import { describe, expect, it } from "vitest";
import type { RecordId, SubjectId } from "../src/core/hex.ts";
import { link, parseLink } from "../src/names/links.ts";
import { checkName } from "../src/names/name.ts";

const S = `0x${"ab".repeat(32)}` as SubjectId;
const R = `0x${"0c".repeat(32)}` as RecordId;

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
    expect(rule(`~efs/o/${S}?lens=0x1`)).toBe("unsupported-parameter");
  });
});
