/**
 * Runtime detection for `switchroom up` (Phase 3b-3).
 *
 * Pure helpers + a single decision function that maps
 * `(platform, marker, systemd-installed, --legacy flag)` → which runtime
 * `switchroom up` should use, plus whether to emit the one-time legacy
 * advisory. No side effects — every input is injected so the unit tests
 * can exhaustively cover the decision matrix without touching the real
 * host.
 *
 * The marker file convention (`~/.switchroom/runtime-mode` containing
 * `host` or `docker`) was introduced in Phase 3b-2; see
 * `src/cli/migrate/preflight.ts` for the canonical reader. We re-export
 * `readRuntimeMode` here to keep `up`'s import surface compact.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimeMode = "host" | "docker" | null;

export type Runtime = "docker" | "host";

export interface DecisionInput {
  /** `process.platform` — "linux" / "darwin" / "win32" / etc. */
  platform: NodeJS.Platform;
  /** Current marker value (`null` if absent). */
  marker: RuntimeMode;
  /** Does this host already have an active systemd switchroom installation? */
  hasActiveSystemd: boolean;
  /** Did the user pass `--legacy` to opt into the systemd runtime? */
  legacy: boolean;
}

export interface Decision {
  /** Which runtime `switchroom up` should drive on this invocation. */
  runtime: Runtime;
  /**
   * Should the legacy-systemd advisory be printed?
   *
   * Fires only when the host is on systemd by default-flip-induced
   * inertia (Linux, no marker, active systemd, no `--legacy`). Operator
   * silences it by either migrating (`switchroom migrate to-docker`) or
   * explicitly opting in (`switchroom up --legacy`, which writes the
   * marker so this never fires again).
   */
  showLegacyAdvisory: boolean;
  /**
   * Should we write `runtime-mode = host` after the systemd up
   * succeeds? Set when `--legacy` was used on a host with no marker
   * yet, so future `up` invocations route to systemd without
   * re-checking systemctl.
   */
  writeHostMarkerAfter: boolean;
  /**
   * Should we write `runtime-mode = docker` after compose-up succeeds?
   * Set on the fresh-Linux default-flip path (no marker, no systemd,
   * no `--legacy`).
   */
  writeDockerMarkerAfter: boolean;
}

/**
 * Decide which runtime `switchroom up` uses, given the host context.
 *
 * Decision matrix (Phase 3b-3 acceptance criteria):
 *
 *   1. marker = "docker"               → docker (no advisory; marker authoritative)
 *   2. marker = "host"                  → host (no advisory; operator already chose)
 *   3. non-Linux                        → host (current behaviour; flip is Linux-only)
 *   4. Linux + --legacy                 → host; write marker if absent
 *   5. Linux + active systemd, no flag  → host + legacy advisory
 *   6. Linux + no systemd, no flag      → docker (default flip); write marker
 */
export function decideRuntime(input: DecisionInput): Decision {
  const { platform, marker, hasActiveSystemd, legacy } = input;

  // 1, 2 — marker is authoritative when present.
  if (marker === "docker") {
    return {
      runtime: "docker",
      showLegacyAdvisory: false,
      writeHostMarkerAfter: false,
      writeDockerMarkerAfter: false,
    };
  }
  if (marker === "host") {
    return {
      runtime: "host",
      showLegacyAdvisory: false,
      writeHostMarkerAfter: false,
      writeDockerMarkerAfter: false,
    };
  }

  // 3 — non-Linux: keep current behaviour (host). No marker write — Mac
  // is deferred to Phase 3d.
  if (platform !== "linux") {
    return {
      runtime: "host",
      showLegacyAdvisory: false,
      writeHostMarkerAfter: false,
      writeDockerMarkerAfter: false,
    };
  }

  // 4 — explicit --legacy opt-in.
  if (legacy) {
    return {
      runtime: "host",
      showLegacyAdvisory: false,
      writeHostMarkerAfter: true,
      writeDockerMarkerAfter: false,
    };
  }

  // 5 — already-installed systemd fleet keeps using systemd, with the
  // one-time advisory pointing to migration.
  if (hasActiveSystemd) {
    return {
      runtime: "host",
      showLegacyAdvisory: true,
      writeHostMarkerAfter: false,
      writeDockerMarkerAfter: false,
    };
  }

  // 6 — fresh Linux host, no systemd, no flag → default-flip to docker.
  return {
    runtime: "docker",
    showLegacyAdvisory: false,
    writeHostMarkerAfter: false,
    writeDockerMarkerAfter: true,
  };
}

/* ------------------------------------------------------------------ */
/* I/O helpers — all overridable by the caller for unit tests.         */
/* ------------------------------------------------------------------ */

export function defaultRuntimeModePath(): string {
  return join(homedir(), ".switchroom", "runtime-mode");
}

export function readRuntimeMode(path?: string): RuntimeMode {
  const p = path ?? defaultRuntimeModePath();
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf8").trim();
    if (v === "host" || v === "docker") return v;
  } catch { /* unreadable */ }
  return null;
}

export type RunCommand = (
  cmd: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Detect whether this host has at least one enabled `switchroom-*`
 * systemd user unit — the signal we use to decide "the operator is
 * already on the legacy runtime".
 *
 * Implementation: `systemctl --user list-unit-files --type=service
 * --no-legend --plain switchroom-*`. Any line whose state is `enabled`
 * or `enabled-runtime` counts as "active install". An empty list (or a
 * non-zero exit) means no install — return false.
 *
 * The function never throws; on any error it returns false so a host
 * without systemd at all (containers, BSD jails) doesn't fail `up`.
 */
export async function hasActiveSystemdInstall(
  runCommand: RunCommand,
): Promise<boolean> {
  let r: Awaited<ReturnType<RunCommand>>;
  try {
    r = await runCommand("systemctl", [
      "--user",
      "list-unit-files",
      "--type=service",
      "--no-legend",
      "--plain",
      "switchroom-*",
    ]);
  } catch {
    return false;
  }
  if (r.exitCode !== 0) return false;
  const lines = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const line of lines) {
    const cols = line.split(/\s+/);
    const unit = cols[0];
    const state = cols[1];
    if (
      unit?.startsWith("switchroom-") &&
      (state === "enabled" || state === "enabled-runtime")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Format the legacy-systemd advisory printed when an existing systemd
 * install is detected on Linux. Pure function so tests can snapshot the
 * exact text without spawning a Command runner.
 */
export function legacyAdvisoryText(): string {
  return [
    "You're on the legacy systemd runtime.",
    "Run `switchroom migrate to-docker` to move to the Docker runtime,",
    "or `switchroom up --legacy` to silence this notice.",
  ].join("\n");
}
