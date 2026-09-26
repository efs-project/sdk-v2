// SPDX-License-Identifier: MIT
// S0 placeholder example: a strict consumer typechecks against the published declarations.
import { smoke } from "@efs/sdk";
import { smoke as nodeSmoke } from "@efs/sdk/node";
import { smoke as webSmoke } from "@efs/sdk/web";

const root: "efs-sdk smoke placeholder" = smoke;
const web: "efs-sdk/web smoke placeholder" = webSmoke;
const node: "efs-sdk/node smoke placeholder" = nodeSmoke;
export const all: readonly string[] = [root, web, node];
