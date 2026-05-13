/**
 * Unit tests for `hostd-dispatch.ts` — the gateway's helper that routes
 * self-restart slash-commands through the hostd UDS when enabled.
 *
 * The config-loading branches are validated by mocking
 * `loadSwitchroomConfig` (the schema's complexity isn't this test's
 * concern — we just need to feed it a known value). The wire-error
 * branch is validated by pointing the helper at a nonexistent socket.
 *
 * The "actually hits a real hostd" path is covered in
 * `tests/host-control/server.test.ts` end-to-end — we don't re-test
 * the server here.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

const loadConfigMock = vi.fn();
vi.mock("../../src/config/loader.js", () => ({
  loadConfig: loadConfigMock,
}));

// Import AFTER the mock so the module captures the mocked function.
const {
  tryHostdDispatch,
  hostdWillBeUsed,
  isHostdEnabled,
  hostdSocketPath,
  _resetHostdEnabledCache,
} = await import("../gateway/hostd-dispatch.js");

beforeEach(() => {
  _resetHostdEnabledCache();
  loadConfigMock.mockReset();
});

afterEach(() => {
  _resetHostdEnabledCache();
});

describe("isHostdEnabled() — config gate", () => {
  it("returns false when host_control absent", () => {
    loadConfigMock.mockReturnValue({});
    expect(isHostdEnabled()).toBe(false);
  });

  it("returns false when host_control.enabled is false", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: false } });
    expect(isHostdEnabled()).toBe(false);
  });

  it("returns true when host_control.enabled is true", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    expect(isHostdEnabled()).toBe(true);
  });

  it("returns false on config-load throw (best-effort fallback)", () => {
    // Gateway runs in environments where the config may not be
    // readable yet (very-early-boot, broken symlink). The helper must
    // not propagate — it just disables the hostd path.
    loadConfigMock.mockImplementation(() => {
      throw new Error("config: file not found");
    });
    expect(isHostdEnabled()).toBe(false);
  });

  it("caches the result across calls (no re-read)", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    expect(isHostdEnabled()).toBe(true);
    expect(isHostdEnabled()).toBe(true);
    expect(isHostdEnabled()).toBe(true);
    expect(loadConfigMock).toHaveBeenCalledTimes(1);
  });
});

describe("hostdWillBeUsed() — config + socket existence", () => {
  it("false when hostd disabled even if socket would be present", () => {
    loadConfigMock.mockReturnValue({});
    expect(hostdWillBeUsed("klanker")).toBe(false);
  });

  it("false when hostd enabled but per-agent socket isn't bound", () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    // hostdSocketPath() is hard-coded to /run/switchroom/hostd/<name>/sock
    // — that path doesn't exist in the test env, so existsSync returns
    // false and hostdWillBeUsed is false.
    expect(hostdWillBeUsed("klanker-no-such-agent")).toBe(false);
  });
});

describe("tryHostdDispatch()", () => {
  it("returns 'not-configured' when hostd disabled", async () => {
    loadConfigMock.mockReturnValue({});
    const result = await tryHostdDispatch("klanker", {
      v: 1,
      op: "agent_restart",
      request_id: "test-1",
      args: { name: "klanker", force: true },
    });
    expect(result).toBe("not-configured");
  });

  it("returns 'not-configured' when socket absent", async () => {
    loadConfigMock.mockReturnValue({ host_control: { enabled: true } });
    const result = await tryHostdDispatch("nonexistent-agent", {
      v: 1,
      op: "agent_restart",
      request_id: "test-2",
      args: { name: "nonexistent-agent", force: true },
    });
    expect(result).toBe("not-configured");
  });

  it("locks the socket-path contract", () => {
    // RFC C pins this path. If the gateway and the compose generator
    // drift apart on the bind path, the mount silently goes nowhere
    // and every dispatch returns "not-configured". Catch any rename
    // in lockstep with the compose-generator test.
    expect(hostdSocketPath("klanker")).toBe(
      "/run/switchroom/hostd/klanker/sock",
    );
  });
});
