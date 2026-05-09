import { defineConfig } from "vitest/config";

/**
 * UAT-only vitest config (epic #863). Runs scenarios in
 * `telegram-plugin/uat/scenarios/`. Hits real Telegram, real Claude
 * — never on the default CI critical path. Invoke via
 * `bun run test:uat` from `telegram-plugin/`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        // Sequential by default — Telegram rate limits are per-bot
        // global. Phase 2 may revisit if topic-isolation lets us go
        // wider safely.
        maxForks: 1,
        minForks: 1,
      },
    },
    include: ["telegram-plugin/uat/scenarios/**/*.test.ts"],
    // Eventual-assertion scenarios run long. Default vitest 5s
    // would trip every assertion. 2 min ceiling per test.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
