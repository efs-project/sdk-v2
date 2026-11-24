// SPDX-License-Identifier: MIT
// Packed-consumer check: a strict consumer typechecks against the published declarations.
import { type Basis, checkName, createEfs, type NameCheck, type PinResult } from "@efs/sdk";
import { type OpenResult, openFile } from "@efs/sdk/files";
import { fileJournal } from "@efs/sdk/node";
import { indexedDbJournal, type WebJournal } from "@efs/sdk/web";

const check: NameCheck = checkName("readme.txt");
export const ok: boolean = check.status === "VALID";
export type Shapes = [Basis, PinResult, OpenResult, WebJournal];
export const fns: readonly unknown[] = [createEfs, openFile, fileJournal, indexedDbJournal];
