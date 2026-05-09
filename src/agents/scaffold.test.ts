import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for {@link alignAgentUid}.
 *
 * The function shells out to `chown` (and falls back to `sudo chown`)
 * to fix bind-mount ownership for an agent's per-agent state dir.
 * We mock `node:child_process` and `node:fs` so the tests run
 * deterministically regardless of the runner's UID, sudo policy, or
 * filesystem state.
 */

// Mock factories must declare their state inside the factory body —
// vi.mock is hoisted, so anything referenced here must be self-contained.
vi.mock("node:child_process", () => {
  return {
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(),
  };
});

// Imports MUST come after vi.mock so the mocks are applied.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { alignAgentUid } from "./scaffold.js";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);

describe("alignAgentUid", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    mockedExistsSync.mockReset();
    mockedStatSync.mockReset();
    mockedExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still runs recursive chown even when the top-level dir is already owned (subtree may be stale)", () => {
    // The previous behaviour was a fast-path no-op when statSync said the
    // top-level was already aligned. That hid stale uid 1000 entries
    // sitting deeper in the subtree (e.g. files an operator dropped in
    // via sudo). chown -R is idempotent + cheap, so we always run it.
    mockedStatSync.mockReturnValue({ uid: 10042, gid: 10042 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(res.paths).toEqual(["/fake/state/agent"]);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toEqual(["-R", "10042:10042", "/fake/state/agent"]);
  });

  it("tries unprivileged chown first, returns success when it works", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toEqual(["-R", "10042:10042", "/fake/state/agent"]);
  });

  it("falls back to `sudo chown` when unprivileged chown fails (EPERM)", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync
      .mockImplementationOnce(() => {
        const e = new Error("EPERM: operation not permitted");
        throw e;
      })
      .mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    const [bin1] = mockedExecFileSync.mock.calls[0];
    const [bin2, args2] = mockedExecFileSync.mock.calls[1];
    expect(bin1).toBe("chown");
    expect(bin2).toBe("sudo");
    expect(args2).toEqual([
      "chown",
      "-R",
      "10042:10042",
      "/fake/state/agent",
    ]);
  });

  it("throws an actionable error when both unprivileged AND sudo chown fail", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() =>
      alignAgentUid("agent", "/fake/state/agent", 10042, {
        writeOut: () => {},
        confirm: false,
      }),
    ).toThrow(/sudo chown failed.*Run manually: sudo chown -R 10042:10042/);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("respects dryRun: never shells out even if uids mismatch", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
      dryRun: true,
    });

    expect(res.chowned).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("returns immediately with no paths when the agentDir does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    const res = alignAgentUid("agent", "/missing/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(false);
    expect(res.paths).toEqual([]);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});
