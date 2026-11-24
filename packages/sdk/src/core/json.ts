// SPDX-License-Identifier: MIT
// JSON codec for SDK data: bigint and Uint8Array survive a round trip; everything else is plain JSON.
// Tagged objects, not bare strings, so a decimal string field and a bigint field never get confused.

const BIG = "$efs:bigint";
const BYTES = "$efs:bytes";

/** Serialize SDK data (results, plans, journal records) to JSON text. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === "bigint") return { [BIG]: v.toString(10) };
      if (v instanceof Uint8Array) {
        let hex = "";
        for (const b of v) hex += b.toString(16).padStart(2, "0");
        return { [BYTES]: hex };
      }
      return v;
    },
    space,
  );
}

/** Parse JSON text produced by `toJson`. Unknown fields are preserved exactly. */
export function fromJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o[BIG] === "string" && /^-?\d+$/.test(o[BIG] as string))
        return BigInt(o[BIG] as string);
      if (
        keys.length === 1 &&
        typeof o[BYTES] === "string" &&
        /^([0-9a-f]{2})*$/.test(o[BYTES] as string)
      ) {
        const hex = o[BYTES] as string;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++)
          out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
      }
    }
    return v;
  }) as T;
}
