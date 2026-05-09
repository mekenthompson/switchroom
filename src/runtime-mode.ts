/**
 * Single source of truth for "is this a docker-runtime install?".
 *
 * Two separate signals can flip the answer to true:
 *   1. `SWITCHROOM_RUNTIME=docker` env var. Set by `compose.ts` on every
 *      container, so any code running INSIDE an agent / broker / kernel /
 *      scheduler container sees this. Never exported on the host shell —
 *      operators don't typically set it themselves.
 *   2. Existence of `~/.switchroom/compose/docker-compose.yml`. Generated
 *      by `switchroom apply` on the host. Catches the case where an
 *      operator runs a CLI verb like `switchroom agent status myagent`
 *      from their bare shell — no env var is set, but the compose file's
 *      presence is the operator-side truth.
 *
 * v0.7.2 introduced docker-aware branches in `status.ts`,
 * `agent.preflightCheck`, and `doctor.checkGatewayUnit` but gated them
 * only on the env var. The host-shell case fell back to systemd, which
 * reports "inactive" forever on a docker fleet — the headline claim of
 * v0.7.2 was actually broken from the host. v0.7.3 routes all four
 * callsites through this helper so both signals fire.
 *
 * Kept deliberately sparse: no opts param, no overrides. Anything that
 * needs richer detection (the doctor's `runDockerSection`, which probes
 * a specific compose path) keeps using its own scoped helper.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * True when this install is in docker mode — either we're running
 * inside a switchroom container (env var) or the host has a generated
 * compose file present (apply has run at least once).
 *
 * The compose path is computed at call time rather than import time so
 * tests can flip the answer by swapping HOME / creating the file
 * dynamically. (Real-world callers see the same behavior either way.)
 */
export function isDockerRuntime(): boolean {
  if (process.env.SWITCHROOM_RUNTIME === "docker") return true;
  const composePath = join(
    homedir(),
    ".switchroom",
    "compose",
    "docker-compose.yml",
  );
  return existsSync(composePath);
}
