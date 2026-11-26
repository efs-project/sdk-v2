// SPDX-License-Identifier: MIT
// Types for tools/api-index.mjs (the export index of @efs/sdk), for packages/sdk/test/docs-api.test.ts.
export interface ExportRow {
  name: string;
  kind: "function" | "const" | "let" | "class" | "interface" | "type" | "enum";
  summary: string;
}
export const API_DOC: string;
export function entryPoints(): Record<string, string>;
export function summaryOf(doc: string | null): string;
export function exportIndex(): Record<string, ExportRow[]>;
export function isValue(kind: string): boolean;
export function renderIndex(index?: Record<string, ExportRow[]>): string;
export function withIndex(doc: string, block: string): string;
