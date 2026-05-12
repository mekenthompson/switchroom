/**
 * Unit tests for the production-fleet detection helpers.
 *
 * These guard the destructive docker phase tests from clobbering a live
 * production fleet on a shared host (the 2026-05-10 klanker incident).
 * The helpers themselves are simple `docker ps --filter` wrappers, so
 * the tests pin two things:
 *
 *   1. Detection is by `switchroom.fleet=switchroom` label, NOT by
 *      container name. Tests that create containers under
 *      `${PROJECT}-vault-broker` shapes don't false-positive.
 *   2. `assertNoProductionFleet` throws (not returns) so a forgotten
 *      `describe.skipIf` still bails out before destructive setup.
 *
 * No actual docker is invoked — `execSync` is shadowed via a local
 * mock seam so the tests run in CI clean-rooms without a daemon.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Module spy on node:child_process so we can drive execSync's response
// without touching the real docker daemon. The helpers under test
// `import { execSync } from "node:child_process"` so the mock applies
// transparently.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from "node:child_process";
import {
  productionFleetIsLive,
  assertNoProductionFleet,
  filterPhaseTestContainers,
} from "./_prod-snapshot.js";

const mockExec = vi.mocked(execSync);

beforeEach(() => {
  mockExec.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("productionFleetIsLive", () => {
  it("returns true when docker ps reports at least one switchroom-fleet=switchroom container", () => {
    mockExec.mockReturnValueOnce(
      Buffer.from("switchroom-vault-broker\nswitchroom-klanker\n"),
    );
    expect(productionFleetIsLive()).toBe(true);
    // Verify the filter is by LABEL, not by name pattern.
    const cmd = String(mockExec.mock.calls[0][0]);
    expect(cmd).toContain("--filter label=switchroom.fleet=switchroom");
    expect(cmd).not.toContain("--filter name=");
  });

  it("returns false when docker ps returns empty", () => {
    mockExec.mockReturnValueOnce(Buffer.from(""));
    expect(productionFleetIsLive()).toBe(false);
  });

  it("returns false when docker ps returns whitespace-only", () => {
    mockExec.mockReturnValueOnce(Buffer.from("\n  \n\t\n"));
    expect(productionFleetIsLive()).toBe(false);
  });

  it("filter value is exactly 'switchroom' — does not match parametrized test fleets", () => {
    // Regression test for PR #939's reviewer note: phase tests in
    // parallel vitest forks emit containers labeled
    // switchroom.fleet=<PROJECT> (e.g. phase1c-iso-12345). The
    // production filter must be the LITERAL string 'switchroom' so it
    // matches ONLY production containers, not sibling-fork test
    // fleets. Docker label filters are equality, not prefix — so as
    // long as we filter on exactly 'switchroom', a label of
    // 'phase1c-iso-12345' is correctly excluded by the daemon.
    mockExec.mockReturnValueOnce(Buffer.from(""));
    productionFleetIsLive();
    const cmd = String(mockExec.mock.calls[0][0]);
    // Anchor the filter value on both sides to catch any future
    // refactor that adds a wildcard or prefix-match shape.
    expect(cmd).toMatch(/--filter label=switchroom\.fleet=switchroom(?=\s|$|'|")/);
  });

  it("returns false when docker is unreachable (fail-closed)", () => {
    mockExec.mockImplementationOnce(() => {
      throw new Error("docker daemon not running");
    });
    // Fail-closed = assume NO fleet so dev machines without docker can
    // still run the suite. The destructive op will fail loudly later
    // if docker is genuinely needed.
    expect(productionFleetIsLive()).toBe(false);
  });
});

describe("filterPhaseTestContainers", () => {
  // Format emitted by captureProdSnapshot:
  //   {{.Names}}|{{.ID}}|{{.Status}}|{{.Labels}}
  // Labels arrive as a comma-separated list like
  //   foo=bar,switchroom.test=phase1b,switchroom.test.run=abc...
  const PROD_ROW = "coolify-postgres|abcd1234|Up 3 hours|com.docker.compose.project=coolify";
  const MOBY_TEST_ROW = "friendly_chatelet|3af1b7|Up Less than a second|switchroom.test=phase1b,switchroom.test.run=uuid-here";
  const NAMED_PHASE_ROW = "switchroom-phase2c-broker-12345-deadbeef|9999|Up 2s|switchroom.test=phase2c";
  const COMPOSE_PHASE_ROW = "phase1c-iso-9876-alice-1|1111|Up 5s|com.docker.compose.project=phase1c-iso-9876";

  it("drops Moby-auto-named containers when they carry switchroom.test label (regression: #1079 flake follow-up)", () => {
    // Pre-fix: e2e.test.ts's `docker run --rm ...` (no --name) produced
    // names like `friendly_chatelet` that the name regex missed, causing
    // phase2c-vault-integration's afterAll snapshot to flake on every
    // docker-e2e run on main. The label-marker filter catches them.
    const raw = `${PROD_ROW}\n${MOBY_TEST_ROW}\n`;
    expect(filterPhaseTestContainers(raw)).toBe(PROD_ROW);
  });

  it("drops named phase test containers (the legacy name-regex case still works)", () => {
    const raw = `${PROD_ROW}\n${NAMED_PHASE_ROW}\n`;
    expect(filterPhaseTestContainers(raw)).toBe(PROD_ROW);
  });

  it("drops compose-project phase test containers", () => {
    const raw = `${PROD_ROW}\n${COMPOSE_PHASE_ROW}\n`;
    // Note: COMPOSE_PHASE_ROW has no switchroom.test label here (only
    // compose.project) — must still match via the name regex fallback.
    expect(filterPhaseTestContainers(raw)).toBe(PROD_ROW);
  });

  it("keeps a row that genuinely looks like production (no test label, no phase name)", () => {
    expect(filterPhaseTestContainers(PROD_ROW)).toBe(PROD_ROW);
  });

  it("preserves empty input", () => {
    expect(filterPhaseTestContainers("")).toBe("");
    expect(filterPhaseTestContainers("\n\n")).toBe("");
  });
});

describe("assertNoProductionFleet", () => {
  it("does NOT throw when no fleet is detected", () => {
    mockExec.mockReturnValueOnce(Buffer.from(""));
    expect(() => assertNoProductionFleet()).not.toThrow();
  });

  it("throws a clear error when production fleet is live", () => {
    mockExec.mockReturnValueOnce(
      Buffer.from("switchroom-vault-broker\nswitchroom-finn\n"),
    );
    expect(() => assertNoProductionFleet()).toThrow(/REFUSING TO RUN/);
  });

  it("error mentions the recovery command", () => {
    mockExec.mockReturnValueOnce(Buffer.from("switchroom-vault-broker\n"));
    expect(() => assertNoProductionFleet()).toThrow(
      /docker compose -p switchroom down/,
    );
  });
});
