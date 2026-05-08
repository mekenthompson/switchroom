/**
 * journald log-driver wiring — Phase 3b-1.
 *
 * On Linux hosts, the watchdog tags every container's stdout/stderr
 * with `SYSLOG_IDENTIFIER=switchroom-<role>[-<agent>]` so operators
 * can `journalctl -t switchroom-agent-alice` naturally. The compose
 * generator (Phase 1a/1c) doesn't set a log driver explicitly, so
 * the system default applies; on systemd-managed Linux that's
 * journald and our identifier flows through.
 *
 * On non-Linux (macOS dev hosts), journald isn't present — this
 * module degrades gracefully: `dockerLogOptsForRole()` returns an
 * empty array and a one-line warning is logged once via
 * `warnIfNotLinuxOnce()`.
 */

import { platform } from "node:os";

let warned = false;

/** True iff this host runs Linux (the journald + cgroups happy-path). */
export function isLinuxHost(): boolean {
  return platform() === "linux";
}

/** Emit a single-shot warning that journald is unavailable. */
export function warnIfNotLinuxOnce(
  warn: (s: string) => void = (s) => process.stderr.write(s),
): void {
  if (warned) return;
  if (isLinuxHost()) return;
  warned = true;
  warn(
    `[watchdog] journald not available on ${platform()} — ` +
      `SYSLOG_IDENTIFIER tagging skipped (no-op on non-Linux hosts).\n`,
  );
}

/**
 * Build the SYSLOG_IDENTIFIER for a container.
 *
 *   role=agent + agent=alice → "switchroom-agent-alice"
 *   role=broker              → "switchroom-broker"
 *   role=kernel              → "switchroom-kernel"
 *   role=scheduler           → "switchroom-scheduler"
 *
 * Identifiers must be `journalctl -t` friendly: a-z 0-9 dashes only.
 */
export function syslogIdentifier(role: string, agent?: string | null): string {
  const safeRole = role.replace(/[^a-z0-9-]/gi, "").toLowerCase();
  if (agent) {
    const safeAgent = agent.replace(/[^a-z0-9-]/gi, "").toLowerCase();
    return `switchroom-${safeRole}-${safeAgent}`;
  }
  return `switchroom-${safeRole}`;
}

/**
 * Return the `--log-driver` / `--log-opt` argv pairs for a `docker
 * run` invocation. On non-Linux hosts returns an empty array (no-op
 * — the system default driver applies).
 */
export function dockerLogOptsForRole(args: {
  role: string;
  agent?: string | null;
}): string[] {
  if (!isLinuxHost()) return [];
  const tag = syslogIdentifier(args.role, args.agent ?? null);
  return [
    "--log-driver", "journald",
    "--log-opt", `tag=${tag}`,
    "--log-opt", `labels=switchroom.role,switchroom.agent`,
  ];
}
