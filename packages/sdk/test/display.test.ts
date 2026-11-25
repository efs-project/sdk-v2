// SPDX-License-Identifier: MIT
// What a person should see for a principal: a key principal is its account's address (EIP-55 checksummed), a
// contract principal is the contract's address when the caller names it (recomputed in this Realm), and anything
// else is its id. Against the contracts' golden vectors (test/vectors/ids.json): no reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEfs } from "../src/client.ts";
import type { Address, Hex, PrincipalId } from "../src/core/hex.ts";
import { KEY_VECTORS } from "../src/generated/domains.ts";
import { contractPrincipal, principalDisplay } from "../src/protocol/keys.ts";

const i = KEY_VECTORS.inputs;
const o = KEY_VECTORS.outputs;
const origin = o.realmOrigin as Hex;

describe("principalDisplay", () => {
  it("a key principal is its account's checksummed address", () => {
    expect(principalDisplay(o.eoaPrincipal as PrincipalId, origin)).toEqual({
      kind: "address",
      address: "0x1111111111111111111111111111111111111111",
    });
    // anvil's account #0, which the client shows today as the padded "0x0000…2266"
    const anvil0 = `0x${"0".repeat(24)}f39fd6e51aad88f6f4ce6ab8827279cfffb92266` as PrincipalId;
    expect(principalDisplay(anvil0, origin)).toEqual({
      kind: "address",
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    });
  });

  it("a contract principal is the contract's address when you name it: recomputed in this Realm, never guessed", () => {
    const p = o.contractPrincipalOfOrigin as PrincipalId;
    const named = i.contractAddress as Address;
    expect(principalDisplay(p, origin, [named])).toEqual({ kind: "contract", address: named });
    // The same address in another Realm is another principal: no match, so the id.
    const otherRealm = `0x${"ab".repeat(32)}` as Hex;
    expect(principalDisplay(p, otherRealm, [named])).toEqual({ kind: "principal", id: p });
    // Not named, or another address named: the id (a contract principal is a hash, so it can't be read back).
    expect(principalDisplay(p, origin)).toEqual({ kind: "principal", id: p });
    expect(principalDisplay(p, origin, [i.eoa as Address])).toEqual({ kind: "principal", id: p });
  });

  it("anything else is its id: an unknown principal, and the zero word (never the zero address)", () => {
    const unknown = `0x${"5a".repeat(32)}` as PrincipalId;
    expect(principalDisplay(unknown, origin)).toEqual({ kind: "principal", id: unknown });
    const zero = `0x${"0".repeat(64)}` as PrincipalId;
    expect(principalDisplay(zero, origin)).toEqual({ kind: "principal", id: zero });
    // Uppercase input comes back lowercase as an id.
    expect(
      principalDisplay(unknown.toUpperCase().replace("0X", "0x") as PrincipalId, origin),
    ).toEqual({
      kind: "principal",
      id: unknown,
    });
  });

  it("is MISUSE for anything that is not a 32-byte word", () => {
    expect(() => principalDisplay("0x1234" as PrincipalId, origin)).toThrow(/32-byte/);
    expect(() => principalDisplay(i.eoa as PrincipalId, origin)).toThrow(/32-byte/);
  });
});

describe("efs.lens.displayOf", () => {
  const deployment = JSON.parse(
    readFileSync(join(import.meta.dirname, "../fixtures/rpc/deployment.json"), "utf8"),
  ) as { realmOrigin: Hex };
  const efs = createEfs({ rpcs: ["http://127.0.0.1:9/"], deployment });

  it("uses this deployment's Realm for contract principals", () => {
    const safe = "0x00000000000000000000000000000000000005af" as Address;
    const p = contractPrincipal(deployment.realmOrigin, safe);
    expect(efs.lens.displayOf(p, { contracts: [safe] })).toEqual({
      kind: "contract",
      address: "0x00000000000000000000000000000000000005AF",
    });
    expect(efs.lens.displayOf(p)).toEqual({ kind: "principal", id: p });
    expect(efs.lens.displayOf(o.eoaPrincipal as PrincipalId)).toMatchObject({ kind: "address" });
  });
});
