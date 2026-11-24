// SPDX-License-Identifier: MIT
/** A lowercase-or-mixed 0x-prefixed hex string. Ids in results are always lowercase. */
export type Hex = `0x${string}`;
export type Address = Hex;
/** Compile-time brands only: plain strings at runtime, so results stay structured-clone-safe. */
export type PrincipalId = Hex & { readonly __efs?: "principal" };
export type RecordId = Hex & { readonly __efs?: "record" };
export type SubjectId = Hex & { readonly __efs?: "subject" };
export type TypeId = Hex & { readonly __efs?: "type" };

const HEX = /^0x[0-9a-fA-F]*$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX.test(value) && value.length % 2 === 0;
}
export function isWord(value: unknown): value is Hex {
  return typeof value === "string" && WORD.test(value);
}
export function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS.test(value);
}
/** Lowercase canonical form of a hex string (ids are compared and stored lowercase). */
export function lower<T extends Hex>(value: T): T {
  return value.toLowerCase() as T;
}
export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}
export function hexToBytes(hex: Hex): Uint8Array {
  if (!isHex(hex))
    throw new TypeError(`not an even-length hex string: ${String(hex).slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}
export const ZERO_WORD: Hex = `0x${"0".repeat(64)}`;
