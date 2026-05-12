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

/**
 * Filter regex for switchroom phase-test container NAMES (any phase).
 *
 * Two shapes are matched:
 *   - `switchroom-phase<digit>...` — the per-container `docker run`
 *     pattern used by single-container tests with explicit `--name`.
 *   - `phase<digit><letter>-<slug>-...` — the compose-project pattern
 *     used by fleet tests like broker-ipc-race.test.ts (project
 *     prefix `phase1c-race-${pid}`) and per-agent-isolation.test.ts
 *     (project prefix `phase1c-iso-${pid}`). Compose names every
 *     container as `<project>-<service>` so the leading
 *     `phase<digit><letter>-` is enough to identify them as test
 *     orphans even when a leaked container survives the test that
 *     created it.
 *
 * Pre-fix, only the first shape was filtered. A failing fleet test
 * that left containers behind (e.g. broker-ipc-race exiting before
 * its afterAll teardown) would pollute the next docker test's
 * before/after snapshot comparison, cascading the failure into
 * unrelated tests (phase2b-kernel-ipc, phase2c-vault-integration).
 *
 * Belt to braces — the LABEL filter `switchroom.test=` below is the
 * load-bearing rule (covers Moby-auto-named transient containers from
 * `docker run --rm` callsites that omit `--name` — e.g. e2e.test.ts's
 * spawnSync calls). The name regex is the fallback when a future test
 * neglects to apply the canonical labelArgv().
 */
const PHASE_TEST_NAME = /^switchroom-phase\d|^phase\d[a-z]-/;

/**
 * Substring match against the `{{.Labels}}` column from `docker ps`.
 *
 * The full docker test suite stamps every container (single-run and
 * compose-emitted alike) with `switchroom.test=phase<digit><letter>`
 * via `tests/docker/_label-helpers.ts:dockerRunLabelsArgv` and the
 * `injectLabelsIntoCompose` post-processor. So a single substring
 * check against the labels column reliably tags a row as test-owned
 * regardless of what name docker assigned it.
 *
 * Pre-fix (this file at HEAD before #1079 fleet flake fix), the prod-
 * snapshot only looked at NAMES. Concurrent vitest forks running
 * `e2e.test.ts` issue `docker run --rm ...` (no `--name`), letting
 * docker assign Moby names like `friendly_chatelet` that the name
 * regex misses; the container was alive for less than a second but
 * straddled `phase2c-vault-integration`'s afterAll snapshot, flaking
 * every other docker-e2e run on main. Switching to a labels-first
 * filter fixes that without weakening genuine drift detection
 * (production containers do not carry `switchroom.test=` labels).
 */
const PHASE_TEST_LABEL_MARKER = "switchroom.test=";

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
 * Uses `--no-trunc` so IDs are stable for diffing. Includes
 * `{{.Labels}}` so the labels-first filter in `filterPhaseTestContainers`
 * can reliably classify rows as test-owned even when docker auto-
 * assigned a Moby name (rather than the test passing `--name`).
 */
const PS_FORMAT = "{{.Names}}|{{.ID}}|{{.Status}}|{{.Labels}}";
export function captureProdSnapshot(): ProdSnapshot {
  try {
    return {
      raw: execSync(
        `sudo docker ps --no-trunc --format '${PS_FORMAT}'`,
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString(),
    };
  } catch {
    try {
      return {
        raw: execSync(
          `docker ps --no-trunc --format '${PS_FORMAT}'`,
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

export function filterPhaseTestContainers(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => {
      if (!l) return false;
      if (l.includes(PHASE_TEST_LABEL_MARKER)) return false;
      if (PHASE_TEST_NAME.test(l)) return false;
      return true;
    })
    .sort()
    .join("\n");
}

/**
 * Probe whether a live switchroom production fleet is running on the
 * host. The compose generator emits fixed `container_name:` values for
 * the singletons (`switchroom-vault-broker`, `switchroom-approval-
 * kernel`) — so a phase test that creates singletons under its own
 * project name COLLIDES with those names and will either fail to start
 * or, worse, clobber the production containers. PR #916 un-skipped
 * `e2e.test.ts` + `per-agent-isolation.test.ts` + `broker-ipc-race.test
 * .ts`; on 2026-05-10 that took the operator's klanker offline because
 * those tests force-remove `switchroom-vault-broker` in their
 * `beforeAll`.
 *
 * Detection is by the `switchroom.fleet=switchroom` label, NOT by
 * container name. The compose generator stamps the fleet label with
 * the value of `containerNamePrefix` (defaults `"switchroom"` for
 * production, parametrized to the test PROJECT name for phase tests
 * — see `src/agents/compose.ts:ComposeGeneratorOptions
 * .containerNamePrefix`). So a phase test running in one vitest fork
 * carries `switchroom.fleet=phase1c-iso-NNN` and is NOT flagged by
 * another fork's `productionFleetIsLive()` — closing the parallel-
 * fork false-positive PR #939's reviewer flagged.
 *
 * Returns true if at least one container with `switchroom.fleet=
 * switchroom` is alive.
 *
 * Tests that destructively touch singleton names should
 * `describe.skipIf(productionFleetIsLive())` at suite level, so a
 * phase test never wrecks a live production fleet on a shared host.
 * CI clean-room runs see no production fleet → tests proceed normally.
 */
export function productionFleetIsLive(): boolean {
  try {
    const out = execSync(
      "docker ps --filter label=switchroom.fleet=switchroom --format '{{.Names}}'",
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString().trim();
    return out.length > 0;
  } catch {
    // No docker, or sudo required and unavailable — fail closed:
    // assume NO fleet so tests can still run on dev machines without
    // docker access. The destructive operation will fail loudly later
    // if docker is genuinely unreachable.
    return false;
  }
}

/**
 * Hard guard for destructive phase-test setup. Throws when a live
 * production fleet is detected. Belt to the
 * `describe.skipIf(productionFleetIsLive())` braces — call from
 * `beforeAll` so a future test that forgets the skipIf still bails out
 * before the `docker rm -f switchroom-vault-broker` line.
 */
export function assertNoProductionFleet(): void {
  if (productionFleetIsLive()) {
    throw new Error(
      "REFUSING TO RUN: a live switchroom production fleet was detected on this host " +
      "(containers labeled switchroom.fleet=switchroom). This phase test would clobber " +
      "the production singletons by name. Stop the production fleet with " +
      "`docker compose -p switchroom down` before running this test, or run the suite " +
      "on a host without a production switchroom install.",
    );
  }
}
