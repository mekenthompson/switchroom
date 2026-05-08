/**
 * Switchroom fleet watchdog — Phase 3b-1.
 *
 * Subscribes to `docker events --format json --filter
 * label=switchroom.fleet=switchroom`, parses container lifecycle
 * transitions, and applies the restart policy in `policy.ts`.
 *
 * Scope:
 *   - Container lifecycle ONLY for Phase 1 fleet containers (anything
 *     carrying `switchroom.role` in {agent,broker,kernel,scheduler}).
 *   - NOT a port of `bin/bridge-watchdog.sh`. Host bridge / gateway
 *     supervision stays where it is.
 *   - NO migrate CLI, NO default-flip — those are Phase 3b-2 / 3b-3.
 *
 * Architecture (deliberately minimal):
 *
 *   docker events stream (long-running) ─┐
 *                                        ├─► classify → policy → action
 *   periodic health-poll (every 10s)  ───┘                       │
 *                                                                ▼
 *                              docker start <name>  +  state.recordRestart
 *
 * Restart action: `docker start <name>` (the containers are created
 * by compose with `restart: unless-stopped`, so they exist as
 * stopped images we can re-start without recreating).
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { WatchdogState, openWatchdogDb } from "./state.js";
import { WatchdogEvents, type WatchdogEventType } from "./events.js";
import {
  DEFAULT_POLICY,
  computeBackoffMs,
  isEscalationDue,
  shouldRestart,
  tallyHealthFails,
  type Observation,
  type WatchdogPolicy,
} from "./policy.js";
import { warnIfNotLinuxOnce } from "./journald.js";

/** Default db path. */
export const DEFAULT_DB_PATH = join(homedir(), ".switchroom", "watchdog.db");

/** Default health-poll interval. */
const HEALTH_POLL_INTERVAL_MS = 10_000;

/** Roles we watch. Anything else with `switchroom.fleet` label is ignored. */
const WATCHED_ROLES = new Set(["agent", "broker", "kernel", "scheduler"]);

export interface WatchdogOptions {
  dbPath?: string;
  policy?: WatchdogPolicy;
  /** Override `docker` binary path (mostly for tests). */
  dockerBin?: string;
  /** Override Date.now for deterministic tests. */
  now?: () => number;
}

interface DockerEventJson {
  Type?: string;
  status?: string;
  Action?: string;
  Actor?: { Attributes?: Record<string, string> };
  id?: string;
  time?: number;
}

interface DockerInspectJson {
  Id: string;
  Name: string;
  State: {
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
    Health?: { Status: string };
  };
  Config: { Labels?: Record<string, string> };
}

export class Watchdog {
  private readonly state: WatchdogState;
  private readonly events: WatchdogEvents;
  private readonly policy: WatchdogPolicy;
  private readonly dockerBin: string;
  private readonly now: () => number;
  private eventsProc: ChildProcess | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  // attempt counter per container (resets on healthy recovery)
  private attemptByContainer = new Map<string, number>();

  constructor(opts: WatchdogOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    const db = openWatchdogDb(dbPath, Database as unknown as new (p: string) => Database);
    this.state = new WatchdogState(db);
    this.events = new WatchdogEvents(db, this.state);
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.dockerBin = opts.dockerBin ?? "docker";
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin watching. Resolves when the events subscription is up. */
  start(): void {
    warnIfNotLinuxOnce();
    this.events.emit({
      ts: this.now(),
      container: "_watchdog",
      type: "watchdog-start",
    });
    this.subscribeDockerEvents();
    this.healthTimer = setInterval(() => {
      this.pollHealthOnce().catch((err) => {
        process.stderr.write(`[watchdog] health-poll error: ${err}\n`);
      });
    }, HEALTH_POLL_INTERVAL_MS);
  }

  /** Stop the watchdog. Safe to call multiple times. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.eventsProc) {
      try {
        this.eventsProc.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      this.eventsProc = null;
    }
    this.events.emit({
      ts: this.now(),
      container: "_watchdog",
      type: "watchdog-stop",
    });
  }

  // ── docker events stream ────────────────────────────────────────────
  private subscribeDockerEvents(): void {
    const args = [
      "events",
      "--format", "{{json .}}",
      "--filter", "type=container",
      "--filter", "label=switchroom.fleet=switchroom",
    ];
    const proc = spawn(this.dockerBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.eventsProc = proc;
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          this.handleEventLine(line).catch((err) => {
            process.stderr.write(`[watchdog] event handler error: ${err}\n`);
          });
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[watchdog][docker events stderr] ${chunk.toString("utf8")}`);
    });
    proc.on("exit", (code) => {
      this.eventsProc = null;
      if (this.stopped) return;
      process.stderr.write(`[watchdog] docker events exited ${code}; resubscribing in 2s\n`);
      setTimeout(() => {
        if (!this.stopped) this.subscribeDockerEvents();
      }, 2000);
    });
  }

  private async handleEventLine(line: string): Promise<void> {
    let ev: DockerEventJson;
    try {
      ev = JSON.parse(line) as DockerEventJson;
    } catch {
      return;
    }
    const status = ev.status ?? ev.Action;
    const attrs = ev.Actor?.Attributes ?? {};
    const name = attrs.name ?? "";
    const role = attrs["switchroom.role"] ?? "";
    const agent = attrs["switchroom.agent"] ?? null;
    if (!WATCHED_ROLES.has(role) || !name) return;

    this.state.upsertContainer({
      name,
      role,
      agent,
      nowMs: this.now(),
    });

    if (status === "die" || status === "oom") {
      await this.onContainerDied(name, role, agent);
    } else if (status === "start") {
      this.events.emit({
        ts: this.now(),
        container: name,
        type: "container-start",
        detail: { role, agent },
      });
    }
  }

  private async onContainerDied(
    name: string,
    role: string,
    agent: string | null,
  ): Promise<void> {
    const inspect = this.dockerInspect(name);
    const exitCode = inspect?.State.ExitCode ?? -1;
    const oomKilled = inspect?.State.OOMKilled ?? false;
    const observation: Observation = {
      kind: "exit",
      exitCode,
      oomKilled,
    };
    this.events.emit({
      ts: this.now(),
      container: name,
      type: oomKilled ? "container-oom" : "container-exit",
      detail: { exitCode, oomKilled, role, agent },
    });
    const fails = this.state.getContainer(name)?.consecutive_health_fails ?? 0;
    const decision = shouldRestart({
      observation,
      consecutiveHealthFails: fails,
      policy: this.policy,
    });
    if (decision.action === "skip") return;
    await this.attemptRestart(name, decision.reason);
  }

  // ── restart action ──────────────────────────────────────────────────
  private async attemptRestart(name: string, reason: string): Promise<void> {
    if (this.state.isEscalated(name)) {
      this.events.emit({
        ts: this.now(),
        container: name,
        type: "restart-skipped-escalated",
        detail: { reason },
      });
      return;
    }
    const nowMs = this.now();
    if (
      isEscalationDue({
        state: this.state,
        container: name,
        nowMs,
        policy: this.policy,
      })
    ) {
      this.state.markEscalated(name, nowMs);
      this.events.emit({
        ts: nowMs,
        container: name,
        type: "escalated" as WatchdogEventType,
        detail: { reason, maxRestarts: this.policy.maxRestarts, windowMs: this.policy.windowMs },
      });
      return;
    }
    const attempt = (this.attemptByContainer.get(name) ?? 0) + 1;
    this.attemptByContainer.set(name, attempt);
    const backoffMs = computeBackoffMs({ attempt, policy: this.policy });
    this.state.recordRestart({ container: name, ts: nowMs, reason, attempt });
    this.events.emit({
      ts: nowMs,
      container: name,
      type: "restart-attempt",
      detail: { attempt, backoffMs, reason },
    });
    await delay(backoffMs);
    if (this.stopped) return;
    try {
      execSync(`${this.dockerBin} start ${shellQuote(name)}`, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[watchdog] docker start ${name} failed: ${msg}\n`);
    }
  }

  // ── healthcheck poll ────────────────────────────────────────────────
  private async pollHealthOnce(): Promise<void> {
    const list = this.listFleetContainers();
    for (const name of list) {
      const insp = this.dockerInspect(name);
      if (!insp) continue;
      const labels = insp.Config.Labels ?? {};
      const role = labels["switchroom.role"] ?? "";
      const agent = labels["switchroom.agent"] ?? null;
      if (!WATCHED_ROLES.has(role)) continue;
      this.state.upsertContainer({ name, role, agent, nowMs: this.now() });
      const health = insp.State.Health?.Status;
      if (!health) continue; // no healthcheck defined
      const healthy = health === "healthy";
      const prev = this.state.getContainer(name)?.consecutive_health_fails ?? 0;
      const tally = tallyHealthFails({ prev, healthy, policy: this.policy });
      this.state.setConsecutiveHealthFails(name, tally.newCount, this.now());
      if (healthy) {
        if (prev > 0) {
          this.events.emit({
            ts: this.now(),
            container: name,
            type: "healthcheck-recovery",
            detail: { previousFails: prev },
          });
          this.attemptByContainer.delete(name);
        }
        continue;
      }
      this.events.emit({
        ts: this.now(),
        container: name,
        type: "healthcheck-fail",
        detail: { count: tally.newCount, threshold: this.policy.healthFailThreshold },
      });
      if (tally.restartTriggered) {
        await this.attemptRestart(name, `health-fail-x${tally.newCount}`);
      }
    }
  }

  private listFleetContainers(): string[] {
    try {
      const out = execSync(
        `${this.dockerBin} ps --filter label=switchroom.fleet=switchroom --format "{{.Names}}"`,
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private dockerInspect(name: string): DockerInspectJson | null {
    try {
      const out = execSync(`${this.dockerBin} inspect ${shellQuote(name)}`, {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
      const arr = JSON.parse(out) as DockerInspectJson[];
      return arr[0] ?? null;
    } catch {
      return null;
    }
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_.-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── entry guard ───────────────────────────────────────────────────────
// Mirror the Phase 3a-1 hardened pattern in src/vault/broker/server.ts:
// require BOTH the import.meta.url match AND the bundle filename to look
// like the watchdog entry. Without the second predicate, bundling this
// module into another entry point (dist/cli/switchroom.js) causes the
// naive equality check to fire spuriously and the watchdog tries to
// boot from random CLI invocations.
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])(?:watchdog[/\\])?index\.(?:js|ts)$/.test(process.argv[1] ?? "")
) {
  const wd = new Watchdog();
  wd.start();
  process.on("SIGTERM", () => {
    wd.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    wd.stop();
    process.exit(0);
  });
  process.stdout.write(
    `switchroom-watchdog: started (db=${DEFAULT_DB_PATH})\n`,
  );
}

// Used for tests that import from the bundle path.
export { fileURLToPath as _fileURLToPath };
