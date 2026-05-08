/**
 * Shared production-host docker snapshot helper for docker phase tests.
 *
 * Phase 1c+ docker tests run on a host that ALSO runs production
 * workloads (Coolify, hindsight, nginx-tunnel-gateway, …). To guarantee
 * a phase test never disturbs a production container, every phase test
 * captures a `docker ps` snapshot in `beforeAll` and asserts the same
 * snapshot in `afterAll`. Any deviation fails the suite hard.
 *
 * This module centralises the capture + assertion so future phase tests
 * inherit the hard-fail behaviour by default and we don't fan out
 * copy-pasted regex filters across N test files.
 *
 * Cross-phase filter rationale: when the broader docker test suite runs
 * 2a/2b/2c (and beyond) together, sibling-phase ephemerals can appear
 * in one snapshot but vanish before the other — that's normal noise,
 * not production drift. We strip any container whose name matches
 * `switchroom-phase<digit>` from BOTH sides before diffing. Production
 * containers do not carry that name prefix, so genuine drift still
 * trips the assertion.
 */

import { execSync } from "node:child_process";
import { expect } from "vitest";

/** Filter regex for switchroom phase-test containers (any phase). */
const PHASE_TEST_NAME = /switchroom-phase\d/;

/**
 * A snapshot of the host's container list at one moment in time.
 * Wrapped in a struct so callers don't accidentally pass a raw string
 * to the wrong parameter.
 */
export interface ProdSnapshot {
  readonly raw: string;
}

/**
 * Capture the host's complete container list. Tries `sudo docker ps`
 * first (production hosts typically require it), falls back to plain
 * `docker ps`, and returns an empty snapshot if neither works (e.g. CI
 * without docker).
 *
 * Uses `--no-trunc` so IDs are stable for diffing.
 */
export function captureProdSnapshot(): ProdSnapshot {
  try {
    return {
      raw: execSync(
        "sudo docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}'",
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString(),
    };
  } catch {
    try {
      return {
        raw: execSync(
          "docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}'",
          { stdio: ["ignore", "pipe", "pipe"] },
        ).toString(),
      };
    } catch {
      return { raw: "" };
    }
  }
}

/**
 * HARD assertion that no production-host container drift occurred
 * between two snapshots. Filters out any switchroom phase-test
 * container (any phase) from BOTH sides before diffing — see
 * cross-phase rationale above.
 *
 * Use in `afterAll` of every docker phase test:
 *
 * ```ts
 * const before = captureProdSnapshot();
 * // ... test body ...
 * const after = captureProdSnapshot();
 * expectNoProdDrift(before, after);
 * ```
 */
export function expectNoProdDrift(
  before: ProdSnapshot,
  after: ProdSnapshot,
): void {
  expect(filterPhaseTestContainers(after.raw)).toEqual(
    filterPhaseTestContainers(before.raw),
  );
}

function filterPhaseTestContainers(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => l && !PHASE_TEST_NAME.test(l))
    .sort()
    .join("\n");
}
