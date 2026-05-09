import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { connect } from "node:net";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveStatePath } from "../config/paths.js";
import { resolveAgentConfig } from "../config/merge.js";
import { loadConfig } from "../config/loader.js";
import { sendAgentInterrupt } from "./tmux.js";
import { resolveSwitchroomHome } from "./docker-fleet.js";

/**
 * Resolve the per-agent gateway clean-shutdown marker path.
 *
 * Mirrors `GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH` in
 * `telegram-plugin/gateway/gateway.ts` — the gateway runs with
 * `TELEGRAM_STATE_DIR=<agentDir>/telegram` and writes the marker as
 * `clean-shutdown.json` inside that directory. Callers that want to
 * stamp WHY a restart happened (so the next greeting card can show it)
 * write to the same path BEFORE issuing the restart.
 */
export function cleanShutdownMarkerPathForAgent(name: string): string {
  const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
  return join(agentsDir, name, "telegram", "clean-shutdown.json");
}

/**
 * Atomically write a clean-shutdown marker for `name` annotated with a
 * human-readable `reason`. Intended for the CLI/watchdog/IPC paths that
 * initiate a restart — they call this BEFORE the restart so the file is
 * on disk by the time the next gateway/agent boots.
 *
 * Best-effort: if the directory doesn't exist or the write fails, we
 * swallow. The restart still proceeds; the next greeting will just omit
 * the Restarted row (the same as a cold start).
 */
export function writeRestartReasonMarker(
  name: string,
  reason: string,
  opts: { preserveExisting?: boolean } = {},
): void {
  const path = cleanShutdownMarkerPathForAgent(name);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    if (opts.preserveExisting && existsSync(path)) {
      try {
        const prev = JSON.parse(readFileSync(path, "utf-8")) as {
          ts?: number;
          reason?: string;
        };
        if (prev && typeof prev.ts === "number" && Date.now() - prev.ts < 30_000 && prev.reason) {
          return;
        }
      } catch {
        /* fall through and overwrite */
      }
    }
    const marker = { ts: Date.now(), signal: "SIGTERM", reason };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(marker), "utf-8");
    renameSync(tmp, path);
  } catch {
    /* best effort — restart proceeds even if we can't stamp the reason */
  }
}

/**
 * Build a deploy-aware "cli: …" reason for `switchroom agent restart`.
 */
export function buildCliRestartReason(opts: {
  buildCommit: string | null;
  cwd?: string;
}): string {
  const { buildCommit, cwd } = opts;
  if (!buildCommit) return "cli: restart";
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const headShort = head.slice(0, 7);
    const buildShort = buildCommit.slice(0, 7);
    if (headShort === buildShort) return "cli: restart";
    let subject = "";
    try {
      subject = execFileSync(
        "git",
        ["log", "-1", "--pretty=%s", head],
        {
          cwd: cwd ?? process.cwd(),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      /* subject is optional */
    }
    if (subject.length > 60) subject = `${subject.slice(0, 57)}…`;
    return subject ? `cli: deploying ${headShort} ${subject}` : `cli: deploying ${headShort}`;
  } catch {
    return "cli: restart";
  }
}

export interface AgentStatus {
  active: string;
  uptime: string | null;
  memory: string | null;
  pid: number | null;
}

/**
 * Compose project name. Matches what `bringUpAgentService` uses — we
 * pass the same `-p` and `-f` flags so `docker compose` joins the
 * already-running fleet rather than spawning a parallel project.
 */
const COMPOSE_PROJECT = "switchroom";

/** Container name for an agent (set via `container_name:` in compose.ts). */
function containerName(name: string): string {
  return `switchroom-${name}`;
}

/** Compose service name (the YAML key under `services:`). */
function serviceKey(name: string): string {
  return `agent-${name}`;
}

/**
 * Resolve the compose file path. Allows `SWITCHROOM_COMPOSE_FILE` to
 * override for tests / non-default installs.
 */
function composeFilePath(): string {
  const override = process.env.SWITCHROOM_COMPOSE_FILE;
  if (override && override.length > 0) return override;
  return resolve(resolveSwitchroomHome(), "compose", "docker-compose.yml");
}

/**
 * Run `docker` synchronously, capturing stdout. Throws with stderr
 * included on non-zero exit so callers see honest failure reasons.
 */
function dockerSync(args: string[]): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    const base = e.message ?? String(err);
    throw new Error(stderr ? `${base}: ${stderr}` : base);
  }
}

/**
 * Build a `docker compose -p <project> -f <file>` argv prefix.
 */
function composeArgs(extra: string[]): string[] {
  return ["compose", "-p", COMPOSE_PROJECT, "-f", composeFilePath(), ...extra];
}

/**
 * Returns true if the agent's container exists (running or stopped).
 */
function containerExists(name: string): boolean {
  try {
    const out = dockerSync(["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${containerName(name)}$`]);
    return out.split("\n").some((l) => l.trim() === containerName(name));
  } catch {
    return false;
  }
}

export function startAgent(name: string): void {
  try {
    // If the container has never been created, `compose start` errors
    // out — fall back to `up -d --no-deps` to bring it online.
    if (containerExists(name)) {
      dockerSync(composeArgs(["start", serviceKey(name)]));
    } else {
      dockerSync(composeArgs(["up", "-d", "--no-deps", serviceKey(name)]));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start agent "${name}": ${message}`);
  }
}

export function stopAgent(name: string): void {
  try {
    dockerSync(composeArgs(["stop", serviceKey(name)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop agent "${name}": ${message}`);
  }
}

export function restartAgent(name: string, reason?: string): void {
  // Stamp WHY before killing so the next agent boot can render it in
  // the greeting card. Best-effort — if the dir is missing we swallow.
  if (reason) writeRestartReasonMarker(name, reason);
  try {
    dockerSync(composeArgs(["restart", serviceKey(name)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to restart agent "${name}": ${message}`);
  }
}

/**
 * Schedule a graceful restart via the gateway IPC. If the agent is idle,
 * restart immediately. If a turn is in flight, wait for completion then restart.
 */
export function gracefulRestartAgent(name: string): Promise<{ restartedImmediately: boolean; waitingForTurn: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
    const agentDir = resolve(agentsDir, name);
    const socketPath = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(agentDir, "telegram", "gateway.sock");

    if (!existsSync(socketPath)) {
      reject(new Error("Gateway socket not found. Is the gateway running?"));
      return;
    }

    const client = connect({ path: socketPath });
    let buffer = "";
    let responseReceived = false;

    client.on("connect", () => {
      const msg = {
        type: "schedule_restart",
        agentName: name,
      };
      client.write(JSON.stringify(msg) + "\n");
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.type === "schedule_restart_result") {
            responseReceived = true;
            client.destroy();

            if (response.success) {
              resolvePromise({
                restartedImmediately: response.restartedImmediately ?? false,
                waitingForTurn: response.waitingForTurn ?? false,
              });
            } else {
              reject(new Error(response.error || "Graceful restart failed"));
            }
            return;
          }
        } catch (err) {
          // Ignore JSON parse errors, wait for more data
        }
      }
    });

    client.on("error", (err) => {
      if (!responseReceived) {
        reject(new Error(`Failed to connect to gateway: ${err.message}`));
      }
    });

    client.on("close", () => {
      if (!responseReceived) {
        reject(new Error("Gateway closed connection without responding"));
      }
    });

    const timeout = setTimeout(() => {
      if (!responseReceived) {
        responseReceived = true;
        client.destroy();
        reject(new Error("Graceful restart request timed out"));
      }
    }, 5000);

    client.once("data", () => {
      if (timeout) clearTimeout(timeout);
    });
  });
}

/**
 * Send SIGINT to the agent currently running its turn. Used by the
 * `!`-prefix Telegram interrupt marker and the `switchroom agent
 * interrupt` CLI.
 *
 * Docker mode policy:
 *   - tmux supervisor (default): try `sendAgentInterrupt` (host-side
 *     tmux send-keys via the host-mounted socket if available). If that
 *     fails, fall back to `docker kill --signal=SIGINT <container>`,
 *     which delivers SIGINT to PID 1 inside the container — tini, which
 *     forwards to its child (claude/tmux supervisor).
 *   - legacy_pty: skip tmux send-keys, go straight to `docker kill`.
 */
export function interruptAgent(
  name: string,
  opts: { config?: SwitchroomConfig } = {},
): { pid: number } {
  const status = getAgentStatus(name);
  if (!status.pid) {
    throw new Error(
      `Agent "${name}" has no running PID (status: ${status.active})`
    );
  }

  let useTmuxSendKeys = false;
  try {
    const config = opts.config ?? loadConfig();
    const agentDef = config.agents[name];
    if (agentDef) {
      const resolved = resolveAgentConfig(
        config.defaults,
        config.profiles,
        agentDef,
      );
      useTmuxSendKeys = resolved.experimental?.legacy_pty !== true;
    }
  } catch {
    useTmuxSendKeys = false;
  }

  if (useTmuxSendKeys) {
    const sendResult = sendAgentInterrupt({ agentName: name });
    if ("ok" in sendResult) {
      console.log(
        `[interrupt] ${name}: delivered SIGINT via tmux send-keys C-c`,
      );
      return { pid: status.pid };
    }
    console.error(
      `[interrupt] ${name}: tmux send-keys failed (${sendResult.error}); ` +
        `falling back to docker kill --signal=SIGINT`,
    );
  }

  try {
    dockerSync(["kill", "--signal=SIGINT", containerName(name)]);
    console.log(
      `[interrupt] ${name}: delivered SIGINT via docker kill --signal=SIGINT`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to send SIGINT to agent "${name}": ${message}`
    );
  }
  return { pid: status.pid };
}

/**
 * Parse SWITCHROOM_AGENT_START_SHA out of a systemd `Environment=` block.
 * Retained because pre-v0.7 tests and external callers may still hand us
 * systemd-shaped output. The new docker code path uses
 * {@link parseAgentStartShaFromEnv}.
 */
export function parseAgentStartShaFromSystemctl(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith("Environment=")) continue;
    const envBlock = line.slice("Environment=".length);
    const match = envBlock.match(/(?:^|\s)SWITCHROOM_AGENT_START_SHA=(\S+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Parse a `KEY=VALUE` env array (the shape `docker inspect
 * --format '{{json .Config.Env}}'` returns) for SWITCHROOM_AGENT_START_SHA.
 */
export function parseAgentStartShaFromEnv(env: string[]): string | null {
  for (const entry of env) {
    if (!entry.startsWith("SWITCHROOM_AGENT_START_SHA=")) continue;
    const v = entry.slice("SWITCHROOM_AGENT_START_SHA=".length).trim();
    if (v.length > 0) return v;
  }
  return null;
}

/**
 * Read the agent's start SHA from the running container. Resolution order:
 *
 *   1. Container env var SWITCHROOM_AGENT_START_SHA (set in compose.ts at
 *      install time once #850-style wiring lands).
 *   2. Container label `switchroom.commit` (compose-level override).
 *   3. Image label `org.opencontainers.image.revision` (the standard
 *      OCI "what git ref was this image built from" label, set by the
 *      GHCR publish workflow).
 *
 * Returns null if none are present (or the container isn't running).
 * Logs a one-line warning to stderr on the null path so operators can
 * correlate "? in version output" with the missing-label state.
 */
export function getAgentStartSha(name: string): string | null {
  const cn = containerName(name);

  // 1. container env
  try {
    const out = dockerSync([
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      cn,
    ]);
    const env = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const fromEnv = parseAgentStartShaFromEnv(env);
    if (fromEnv) return fromEnv;
  } catch {
    // container missing — nothing more to try
    return null;
  }

  // 2. container labels
  try {
    const labelVal = dockerSync([
      "inspect",
      "--format",
      "{{index .Config.Labels \"switchroom.commit\"}}",
      cn,
    ]);
    if (labelVal && labelVal !== "<no value>") return labelVal;
  } catch {
    /* fall through */
  }

  // 3. image label (org.opencontainers.image.revision)
  try {
    const image = dockerSync(["inspect", "--format", "{{.Config.Image}}", cn]);
    if (image) {
      const rev = dockerSync([
        "inspect",
        "--format",
        "{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
        image,
      ]);
      if (rev && rev !== "<no value>") return rev;
    }
  } catch {
    /* fall through */
  }

  process.stderr.write(
    `[switchroom] getAgentStartSha: no SWITCHROOM_AGENT_START_SHA env, ` +
      `no switchroom.commit label, and no org.opencontainers.image.revision ` +
      `label found for container=${cn}; version row will show "?"\n`,
  );
  return null;
}

/**
 * Resolve the agent process PID inside its container.
 *
 * `docker inspect --format '{{.State.Pid}}'` returns the host-namespace
 * PID of the container's PID 1 (tini under our docker image). For the
 * tmux supervisor case this is good enough for "is the agent up" — we
 * don't try to reach into the container's PID namespace to find the
 * heaviest-RSS claude process the way the systemd path used to (cgroup
 * walk semantics differ inside containers, and the value isn't surfaced
 * in any UI as "claude RSS specifically"). Returns null if the container
 * is missing; returns 0 (per the v0.7 PR-C1 spec) if the container
 * exists but is stopped.
 */
export function resolveAgentPid(name: string): number {
  try {
    const out = dockerSync([
      "inspect",
      "--format",
      "{{.State.Pid}}",
      containerName(name),
    ]);
    const parsed = parseInt(out, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

/**
 * Per-agent status row used by `switchroom version` and the web
 * dashboard. The shape is preserved from the systemd-era contract; the
 * field meanings translate as:
 *
 *   - `active`: docker container State.Status, normalised so
 *     "running" → "active" (preserving the systemd-era convention so
 *     downstream `s.active === "active"` checks keep working). Other
 *     statuses pass through verbatim ("exited", "restarting", "paused",
 *     "created", "dead", "inactive").
 *   - `uptime`: container State.StartedAt (ISO-8601). The CLI/web
 *     formatters parse this into "5m"/"4h"/"2d" the same way they did
 *     for systemd's ActiveEnterTimestamp.
 *   - `memory`: usage from `docker stats --no-stream` (best-effort —
 *     returns null if stats are unavailable, e.g. container stopped).
 *   - `pid`: container PID 1 in host namespace, via State.Pid.
 *
 * The second `tmuxSupervisor` arg is retained for source-compat with
 * the systemd-era signature; under docker we ignore it (the pid we
 * return is always the container's PID 1).
 */
export function getAgentStatus(name: string, _tmuxSupervisor = true): AgentStatus {
  const cn = containerName(name);

  let active = "inactive";
  let uptime: string | null = null;
  let pid: number | null = null;

  try {
    // Bundle the inspect into a single call for speed.
    const out = dockerSync([
      "inspect",
      "--format",
      "{{.State.Status}}|{{.State.StartedAt}}|{{.State.Pid}}",
      cn,
    ]);
    const [status, startedAt, pidStr] = out.split("|");
    if (status) {
      active = status === "running" ? "active" : status;
    }
    if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
      uptime = startedAt;
    }
    if (pidStr) {
      const parsed = parseInt(pidStr, 10);
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    }
  } catch {
    // No container — return inactive shell.
    return { active: "inactive", uptime: null, memory: null, pid: null };
  }

  let memory: string | null = null;
  if (active === "active") {
    try {
      const stats = dockerSync([
        "stats",
        "--no-stream",
        "--format",
        "{{.MemUsage}}",
        cn,
      ]);
      // docker stats prints e.g. "12.34MiB / 4GiB" — take the first token.
      const first = stats.split("/")[0]?.trim();
      if (first) {
        // Normalise "12.34MiB" → "12MB" to match the systemd-era format.
        const m = first.match(/([\d.]+)\s*([KMG]i?B)/i);
        if (m) {
          const val = parseFloat(m[1]);
          const unit = m[2].toUpperCase();
          let mb = val;
          if (unit.startsWith("K")) mb = val / 1024;
          else if (unit.startsWith("G")) mb = val * 1024;
          memory = `${Math.round(mb)}MB`;
        } else {
          memory = first;
        }
      }
    } catch {
      // stats unavailable — leave null
    }
  }

  return { active, uptime, memory, pid };
}

export function getAllAgentStatuses(
  config: SwitchroomConfig
): Record<string, AgentStatus> {
  const statuses: Record<string, AgentStatus> = {};
  for (const agentName of Object.keys(config.agents)) {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      config.agents[agentName],
    );
    const tmuxSupervisor = resolved.experimental?.legacy_pty !== true;
    statuses[agentName] = getAgentStatus(agentName, tmuxSupervisor);
  }
  return statuses;
}

/**
 * Attach to the agent — under docker this means dropping into the
 * container's tmux session (the supervisor case) or tailing
 * `docker logs -f` (legacy_pty).
 */
export function attachAgent(name: string, tmuxSupervisor = true): void {
  if (tmuxSupervisor) {
    const tmuxSocket = `switchroom-${name}`;
    const result = spawnSync(
      "docker",
      [
        "exec",
        "-it",
        containerName(name),
        "tmux",
        "-L",
        tmuxSocket,
        "attach",
        "-t",
        name,
      ],
      { stdio: "inherit" },
    );
    if (result.error) {
      throw new Error(`Failed to attach to agent "${name}": ${result.error.message}`);
    }
    return;
  }

  const result = spawnSync("docker", ["logs", "-f", containerName(name)], {
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`Failed to tail logs for agent "${name}": ${result.error.message}`);
  }
}

export function getAgentLogs(name: string, follow: boolean): void {
  const args = ["logs"];
  if (follow) args.push("-f");
  args.push(containerName(name));

  const child = spawn("docker", args, { stdio: "inherit" });
  child.on("error", (err) => {
    throw new Error(
      `Failed to get logs for agent "${name}": ${err.message}`
    );
  });
}

// Silence unused-import lints on `execFile` (kept for future async
// shellouts; the synchronous path covers everything the CLI needs).
void execFile;
