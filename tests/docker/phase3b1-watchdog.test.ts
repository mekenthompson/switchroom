/**
 * Phase 3b-1 — fleet watchdog integration test.
 *
 * Boots a small synthetic fleet (3 alpine containers labelled like
 * Phase 1 fleet agents) and the watchdog as a host process. Verifies:
 *
 *   1. Killing a "fleet" container deliberately → watchdog observes
 *      the `die` event and restarts within ~10s.
 *   2. Forcing repeated kill loops → watchdog escalates after R
 *      restarts within W seconds (R=3, W=60s for a tight test
 *      configuration so the suite stays under 60s).
 *
 * Production-host safety: every container labelled
 * `switchroom.test=phase3b1` + per-run UUID. Pre/post sudo-docker-ps
 * snapshot HARD-asserted via `expectNoProdDrift`.
 *
 * The test does NOT require any of the switchroom phase images — it
 * uses `alpine:3.19` (already on the test host) plus a long-running
 * shell loop. That keeps the suite hermetic from Phase 1b/1c image
 * presence.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  captureProdSnapshot,
  expectNoProdDrift,
  type ProdSnapshot,
} from "./_prod-snapshot";

const RUN_ID = randomUUID();
const PHASE_LABEL = "switchroom.test=phase3b1";
const FLEET_LABEL = "switchroom.fleet=switchroom"; // watchdog selector
const ROLE_LABEL = "switchroom.role=agent";

// Containers we boot. Names must NOT match the production switchroom-
// agent-X scheme to avoid colliding with anything else; the
// `phase3b1-` prefix is unique to this test.
const C1 = `phase3b1-${RUN_ID.slice(0, 8)}-c1`;
const C2 = `phase3b1-${RUN_ID.slice(0, 8)}-c2`;
const C3 = `phase3b1-${RUN_ID.slice(0, 8)}-c3`;
const ALL = [C1, C2, C3];

const ALPINE = "alpine:3.19";

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureAlpine(): boolean {
  if (hasImage(ALPINE)) return true;
  try {
    execSync(`docker pull ${ALPINE}`, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = hasDocker();
const imageOk = dockerOk && ensureAlpine();

function safeLabelTeardown(): void {
  for (const filter of [
    `label=switchroom.test.run=${RUN_ID}`,
    `label=switchroom.test=phase3b1`,
  ]) {
    try {
      const ids = execSync(`docker ps -aq --filter ${filter}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (ids.length === 0) continue;
      execSync(`docker rm -f ${ids.split(/\s+/).join(" ")}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

function startFleetContainer(name: string): void {
  // -d (detached, no --rm) because we want the container to stay around
  // after a `docker kill` so the watchdog can `docker start` it. This
  // fits the CLAUDE.md "detached for inter-call inspection" exception:
  //   (a) carries the standard labels,
  //   (b) finally-block + afterAll teardown by explicit name,
  //   (c) covered by safeLabelTeardown in afterAll.
  const r = spawnSync(
    "docker",
    [
      "run", "-d",
      "--name", name,
      "--label", PHASE_LABEL,
      "--label", `switchroom.test.run=${RUN_ID}`,
      "--label", FLEET_LABEL,
      "--label", ROLE_LABEL,
      "--label", `switchroom.agent=${name}`,
      ALPINE,
      "sh", "-c", "while true; do sleep 5; done",
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`docker run ${name} failed: ${r.stderr}`);
  }
}

function isRunning(name: string): boolean {
  try {
    const out = execSync(`docker inspect -f '{{.State.Running}}' ${name}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

interface Fixture {
  prod: ProdSnapshot;
  workdir: string;
  dbPath: string;
  watchdog: ChildProcess | null;
}

let fx: Fixture | null = null;

beforeAll(() => {
  if (!imageOk) return;
  const prod = captureProdSnapshot();
  const workdir = mkdtempSync(join(tmpdir(), "phase3b1-wd-"));
  const dbDir = join(workdir, "wd");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "watchdog.db");
  fx = { prod, workdir, dbPath, watchdog: null };
});

afterAll(async () => {
  if (fx?.watchdog) {
    try {
      fx.watchdog.kill("SIGTERM");
    } catch {
      /* best */
    }
    await delay(200);
  }
  for (const n of ALL) {
    try {
      execSync(`docker rm -f ${n}`, { stdio: "ignore" });
    } catch {
      /* best */
    }
  }
  safeLabelTeardown();
  if (fx?.workdir) {
    try {
      rmSync(fx.workdir, { recursive: true, force: true });
    } catch {
      /* best */
    }
  }
  if (fx) {
    const after = captureProdSnapshot();
    expectNoProdDrift(fx.prod, after);
  }
});

const skip = !imageOk;

describe.skipIf(skip)("Phase 3b-1 — watchdog restarts a killed fleet container", () => {
  it("watchdog detects `die` and restarts within ~10s", async () => {
    if (!fx) throw new Error("fixture missing");

    // Boot 3 fleet containers (one is the kill target).
    for (const name of ALL) startFleetContainer(name);
    for (const name of ALL) expect(isRunning(name)).toBe(true);

    // Spawn the watchdog as a host bun process. Use the source entry
    // (not dist) because the test env doesn't always have npm-built
    // dist. We override DEFAULT_DB_PATH via env-driven indirection:
    // the test harness imports the Watchdog class instead and runs
    // it in-process for tighter control.
    const repoRoot = join(import.meta.dirname ?? "", "..", "..");
    const entry = join(repoRoot, "src", "watchdog", "index.ts");
    // Inline-launch via a tiny bun shim that imports the class with a
    // custom dbPath. This avoids touching ~/.switchroom/watchdog.db.
    const shim = `
import { Watchdog } from ${JSON.stringify(entry)};
const wd = new Watchdog({
  dbPath: ${JSON.stringify(fx.dbPath)},
  policy: {
    baseBackoffMs: 200,
    maxBackoffMs: 1000,
    jitter: 0.1,
    maxRestarts: 3,
    windowMs: 60_000,
    healthFailThreshold: 3,
  },
});
wd.start();
process.on("SIGTERM", () => { wd.stop(); process.exit(0); });
`;
    const shimPath = join(fx.workdir, "shim.ts");
    writeFileSync(shimPath, shim);
    fx.watchdog = spawn("bun", [shimPath], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: repoRoot,
    });
    fx.watchdog.stderr?.on("data", (chunk: Buffer) => {
      // Surface watchdog logs into the test runner stream for forensics.
      process.stderr.write(`[watchdog-test-stderr] ${chunk.toString("utf8")}`);
    });

    // Give the watchdog a moment to subscribe to docker events.
    await delay(2000);

    // Kill the target.
    execSync(`docker kill ${C2}`, { stdio: "ignore" });
    expect(isRunning(C2)).toBe(false);

    // Poll for restart up to 10s.
    let restarted = false;
    for (let i = 0; i < 25; i++) {
      await delay(400);
      if (isRunning(C2)) {
        restarted = true;
        break;
      }
    }
    expect(restarted).toBe(true);
  }, 30_000);

  it("escalates after R kill cycles within W", async () => {
    if (!fx) throw new Error("fixture missing");

    // Use C3 as the escalation target. Kill it in tight succession
    // R+1 times — by the (R+1)'th the watchdog should have marked it
    // escalated and stop restarting.
    //
    // Tight policy in the shim: maxRestarts=3, windowMs=60s, base
    // backoff 200ms. Each kill→restart cycle is ~400ms; 4 kills in
    // ~3s easily fits the window.
    for (let i = 0; i < 4; i++) {
      // Wait for it to be running first (the watchdog may still be
      // bringing it back from the previous kill).
      let up = isRunning(C3);
      for (let w = 0; w < 30 && !up; w++) {
        await delay(400);
        up = isRunning(C3);
      }
      if (!up) {
        // If the watchdog already gave up bringing it back, that IS
        // the escalation — start it manually so we can keep killing,
        // OR break out if escalation is already visible. We break.
        break;
      }
      try {
        execSync(`docker kill ${C3}`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      await delay(300);
    }

    // After the loop, give the watchdog a generous window to either
    // restart C3 (if not yet escalated) or leave it down (if
    // escalated). At maxRestarts=3 we expect the 4th attempt to be
    // suppressed → C3 stays down.
    await delay(5000);

    // The escalated event should have been written to the watchdog
    // SQLite db. We don't query the db directly from the test (it's
    // bun:sqlite, vitest worker can't open it); instead we assert
    // the state by observing that C3 is NOT running 5s after the
    // last kill, while a NON-killed container (C1) IS still running.
    expect(isRunning(C1)).toBe(true);
    expect(isRunning(C3)).toBe(false);
  }, 60_000);
});
