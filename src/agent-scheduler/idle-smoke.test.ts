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
 *   1. The child reaches the idle branch (waits for the deterministic
 *      "idling" stdout signal — NOT a wall-clock sleep, so loaded CI
 *      can't false-positive by timing past the regression's exit
 *      before the alive-check runs).
 *   2. The child stays alive briefly after the signal (proves the
 *      branch returned to setInterval, not exit-0).
 *   3. SIGTERM produces a clean exit (the cleanup handler at
 *      src/agent-scheduler/index.ts:247-252 releases the lock and
 *      exits 0).
 *
 * Fail loud (not skip) when dist/ isn't built — silently skipping
 * here is the exact antipattern tests/entry-guard-bundler.test.ts:113-121
 * documents and avoids. A fresh checkout running `npm test` without
 * `npm run build` would otherwise pass with the idle contract
 * un-verified.
 */

import { afterEach, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
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

// Track spawned children so afterEach can SIGKILL any survivors —
// belt-and-braces against a vitest timeout / unexpected throw between
// spawn and SIGTERM that would otherwise orphan the process.
const liveChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const c of liveChildren) {
    if (c.exitCode === null && c.signalCode === null) {
      try { c.kill("SIGKILL"); } catch { /* nothing to do */ }
    }
  }
  liveChildren.clear();
});

describe("agent-scheduler idle on empty schedule (#921 #928)", () => {
  it("dist/agent-scheduler/index.js exists after build (regression guard for skip-on-missing antipattern)", () => {
    expect(
      existsSync(distBundle),
      `expected ${distBundle} after \`npm run build\` — silent skip would defeat the test's purpose (see tests/entry-guard-bundler.test.ts:113-121).`,
    ).toBe(true);
  });

  it("reaches the idle branch and stays alive; SIGTERM exits 0", async () => {
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
      liveChildren.add(child);
      let stdoutBuf = "";
      let stderrBuf = "";
      child.stdout?.on("data", (d) => { stdoutBuf += d.toString(); });
      child.stderr?.on("data", (d) => { stderrBuf += d.toString(); });

      // Wait for the deterministic "idling" log line (emitted at
      // src/agent-scheduler/index.ts:228) — proves main() reached
      // the empty-entries branch. NOT a wall-clock sleep, so a
      // loaded CI runner can't false-positive by timing past the
      // regression's exit before the alive-check runs.
      const sawIdling = await new Promise<boolean>((res) => {
        const deadline = setTimeout(() => res(false), 10_000);
        const onData = (d: Buffer): void => {
          if (d.toString().includes("idling")) {
            clearTimeout(deadline);
            res(true);
          }
        };
        child.stdout?.on("data", onData);
        child.on("exit", () => {
          clearTimeout(deadline);
          res(false); // exited before idling — regression scenario
        });
      });
      expect(
        sawIdling,
        `expected "idling" stdout signal within 10s; stdout="${stdoutBuf}" stderr="${stderrBuf}"`,
      ).toBe(true);

      // Brief settle to make sure the branch actually returned to
      // setInterval (the regression scenario would have process.exit'd
      // BEFORE the idling line is flushed, so this is belt-and-braces).
      await new Promise((r) => setTimeout(r, 250));
      expect(
        child.exitCode,
        `expected child still alive after idling signal; stderr: ${stderrBuf}`,
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
  }, 20_000);
});
