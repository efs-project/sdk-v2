// SPDX-License-Identifier: MIT
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.browser.test.ts", "test/integration/**"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/integration/setup.ts"],
          // The files share one fixture chain, and several switch its automine off and on: run them one at a time.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
