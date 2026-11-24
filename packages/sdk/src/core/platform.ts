// SPDX-License-Identifier: MIT
// The few runtime globals the portable core uses, reached through `globalThis` with structural types. Every
// supported runtime (browsers from the client's floor, Workers, Node ≥ 22) provides them. Nothing here runs at
// import time.

type Encoder = { encode(text: string): Uint8Array };
type Decoder = { decode(bytes: Uint8Array): string };
type G = {
  TextEncoder: new () => Encoder;
  TextDecoder: new (label?: string, o?: { fatal?: boolean; ignoreBOM?: boolean }) => Decoder;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const g = (): G => globalThis as unknown as G;

let encoder: Encoder | undefined;
export function utf8Encode(text: string): Uint8Array {
  encoder ??= new (g().TextEncoder)();
  return encoder.encode(text);
}
/** Lenient UTF-8 decode for display (malformed sequences become U+FFFD; the BOM is kept). */
export function utf8DecodeLossy(bytes: Uint8Array): string {
  return new (g().TextDecoder)("utf-8", { ignoreBOM: true }).decode(bytes);
}
export function setTimer(fn: () => void, ms: number): unknown {
  return g().setTimeout(fn, ms);
}
export function clearTimer(handle: unknown): void {
  g().clearTimeout(handle);
}
