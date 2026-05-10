/**
 * Smoke test for the empty-schedule idle path (#921).
 *
 * Why a smoke test rather than a unit test: the load-bearing behavior
 * is "process stays alive when entries.length === 0". A pure-function
 * classifier alone wouldn't catch the regression we're guarding
 * against — if a future refactor swaps `setInterval` for
 * `process.exit(0)`, the classifier's return value doesn't change,
 * but the supervisor restart-cap regression returns silently
 * (#928 issue body has the full diagnosis).
 *
 * Approach: spawn the bundled `dist/agent-scheduler/index.js` with
 * env that produces zero schedule entries for the named agent.
 * Assert:
 *   1. The process stays alive after a generous settle window.
 *   2. SIGTERM produces a clean exit (the cleanup handler at
 *      src/agent-scheduler/index.ts:247 releases the lock and
 *      exits 0).
 *
 * Skip when dist/ isn't built — the test exercises the published
 * artifact, not the src/ TypeScript directly. Match the pattern in
 * tests/autoaccept-poll-bundled.test.ts and
 * tests/entry-guard-bundler.test.ts.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const distBundle = resolve(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "agent-scheduler",
  "index.js",
);

function bundleAvailable(): boolean {
  return existsSync(distBundle);
}

describe.skipIf(!bundleAvailable())(
  "agent-scheduler idle on empty schedule (#921 #928)",
  () => {
    it("stays alive past the supervisor restart-cap window when the named agent has no schedule entries", async () => {
      const dir = mkdtempSync(join(tmpdir(), "as-idle-"));
      try {
        // Minimal config: forum chat present (so resolveChannelTarget
        // doesn't bounce us out at line 218 with EX_CONFIG), but
        // `test-no-sched` has zero entries — exactly the case the
        // idle path defends against.
        const configPath = join(dir, "switchroom.yaml");
        writeFileSync(
          configPath,
          [
            "switchroom:",
            "  version: 1",
            "telegram:",
            "  bot_token: x",
            "  forum_chat_id: \"-1009999999999\"",
            "agents:",
            "  test-no-sched:",
            "    topic_name: test",
            "",
          ].join("\n"),
        );
        const lockPath = join(dir, "scheduler.lock");
        const jsonlPath = join(dir, "scheduler.jsonl");
        const child = spawn(
          process.execPath,
          [distBundle],
          {
            env: {
              ...process.env,
              SWITCHROOM_AGENT_NAME: "test-no-sched",
              SWITCHROOM_CONFIG: configPath,
              SWITCHROOM_AGENT_SCHEDULER_LOCK: lockPath,
              SWITCHROOM_AGENT_SCHEDULER_JSONL: jsonlPath,
              // Point the gateway socket at a path that won't be used
              // (idle path returns before any socket connect).
              SWITCHROOM_GATEWAY_SOCKET: join(dir, "gateway.sock"),
              // Quiet the boot-replay defaults; idle path doesn't
              // run replay anyway.
              SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        // Capture stderr for diagnostic on failure.
        let stderrTail = "";
        child.stderr?.on("data", (d) => { stderrTail += d.toString(); });
        // Wait past the supervisor's restart-cap window (10 restarts
        // in 60s pre-#921; if main() exit-0'd we'd see the child gone
        // well before the 2.5s settle).
        await new Promise((r) => setTimeout(r, 2500));
        // The process should be alive (idling on setInterval).
        expect(
          child.exitCode,
          `expected child still alive but exited; stderr: ${stderrTail}`,
        ).toBeNull();
        // SIGTERM should trigger the cleanup handler at
        // src/agent-scheduler/index.ts:247-252 which releases the
        // lock and exits 0.
        const exitPromise = new Promise<number>((res) => {
          child.on("exit", (code) => res(code ?? -1));
        });
        child.kill("SIGTERM");
        const code = await Promise.race([
          exitPromise,
          new Promise<number>((res) => setTimeout(() => res(-2), 5000)),
        ]);
        expect(code, `expected clean exit on SIGTERM; got ${code}`).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
