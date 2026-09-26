// SPDX-License-Identifier: MIT
// Minimal deterministic USTAR writer and (gzip-aware) reader. Files only, no
// directories, links or extended headers are written. Used for the Solidity source
// archive and for comparing the unpacked contents of two builds.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
const FIXED_MTIME = 499162500; // 1985-10-26T08:15:00Z, the same fixed time npm uses.

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function splitName(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const cut = path.lastIndexOf("/", 155);
  if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) {
    throw new Error(`tar: path too long for USTAR: ${path}`);
  }
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
}

function header(path, size) {
  const h = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(path);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii");
  h.write(octal(0, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(FIXED_MTIME, 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

/** @param {{path: string, data: Buffer}[]} entries */
export function writeTar(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts = [];
  for (const { path, data } of sorted) {
    parts.push(header(path, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** @returns {Map<string, Buffer>} regular files by path */
export function readTar(buffer) {
  const buf = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
  const files = new Map();
  let offset = 0;
  let paxPath = null;
  while (offset + BLOCK <= buf.length) {
    const h = buf.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    const str = (start, len) =>
      h
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(str(124, 12).trim() || "0", 8);
    const type = str(156, 1) || "0";
    const prefix = str(345, 155);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const data = buf.subarray(offset + BLOCK, offset + BLOCK + size);
    if (type === "x") {
      const match = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      paxPath = match ? match[1] : null;
    } else if (type === "0") {
      files.set(paxPath ?? name, Buffer.from(data));
      paxPath = null;
    } else {
      paxPath = null;
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function npmIntegrity(data) {
  return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}
