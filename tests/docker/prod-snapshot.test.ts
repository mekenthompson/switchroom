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
