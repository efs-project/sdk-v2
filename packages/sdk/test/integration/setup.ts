// SPDX-License-Identifier: MIT
// Vitest global setup: one fresh contracts fixture per test run, stopped afterwards.
import type { TestProject } from "vitest/node";
// @ts-expect-error tools/fixture.mjs is plain JS without declarations
import { down, up } from "../../../../tools/fixture.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    fixture: Record<string, unknown>;
  }
}

export default function setup(project: TestProject): () => void {
  const name = `sdk-it-${process.pid}`;
  const ready = up(name, { ttlSeconds: 600 }) as Record<string, unknown>;
  project.provide("fixture", ready);
  return () => {
    down(name);
  };
}
