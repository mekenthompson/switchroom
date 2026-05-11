/**
 * Unit tests for `telegram-plugin/uat/login.ts` — the part that
 * writes the minted mtcute session string into the vault. Imports
 * the **real** `writeToVault` so any production drift breaks these
 * tests (cf. reviewer feedback on PR #994).
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * Why this file lives at repo-root `tests/` rather than next to
 * `telegram-plugin/uat/login.ts`: bun test in `telegram-plugin/`
 * doesn't fully cover vitest's mocking API (`vi.doMock`, etc).
 * Hosting the test outside `telegram-plugin/` keeps vitest discovery
 * intact while sidestepping bun's discovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const mkdtempMock = vi.hoisted(() =>
  vi.fn(async (_prefix: string) => "/tmp/uat-session-XYZ"),
);
const rmMock = vi.hoisted(() => vi.fn(async () => undefined));
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  writeFile: writeFileMock,
  mkdtemp: mkdtempMock,
  rm: rmMock,
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// mtcute import is not exercised by `writeToVault`, but login.ts
// imports it at module top — mock so the test never tries to dial
// Telegram during module evaluation.
vi.mock("@mtcute/node", () => ({
  MemoryStorage: class {},
  TelegramClient: class {},
}));

interface FakeChildProcess {
  on(event: string, listener: (...args: unknown[]) => void): FakeChildProcess;
}

function findCall(
  mock: { mock: { calls: unknown[][] } },
  bin: string,
): unknown[] | undefined {
  return mock.mock.calls.find((c) => (c as unknown[])[0] === bin);
}

function fakeProc(exitCode: number, error?: Error): FakeChildProcess {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  setImmediate(() => {
    if (error) {
      for (const fn of handlers.error ?? []) fn(error);
      return;
    }
    for (const fn of handlers.exit ?? []) fn(exitCode);
  });
  return {
    on(event, fn): FakeChildProcess {
      (handlers[event] ??= []).push(fn);
      return this;
    },
  };
}

let writeToVault: typeof import("../telegram-plugin/uat/login.js").writeToVault;
let VAULT_SCOPE: string;

beforeEach(async () => {
  vi.clearAllMocks();
  spawnMock.mockImplementation(() => fakeProc(0));
  const mod = await import("../telegram-plugin/uat/login.js");
  writeToVault = mod.writeToVault;
  VAULT_SCOPE = mod.VAULT_SCOPE;
});

afterEach(() => {
  vi.resetModules();
});

describe("writeToVault: tmpfile permissions", () => {
  it("writes the session string to a 0600 tmpfile before spawning vault set", async () => {
    // fails when: a refactor pipes the session via argv (visible in
    // `ps` / `/proc/<pid>/cmdline`) or env (visible in
    // `/proc/<pid>/environ`), or writes a 0644 file readable by
    // other users. The vault CLI requires --file for --allow scope;
    // that file is the exposure window and must be 0600.
    await writeToVault("telegram-uat-driver-session", "SESSION_BLOB");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [path, contents, opts] = writeFileMock.mock.calls[0] as [
      string,
      string,
      { mode: number },
    ];
    expect(path).toContain("uat-session-");
    expect(contents).toBe("SESSION_BLOB");
    expect(opts.mode).toBe(0o600);
  });

  it("creates the tmpfile parent dir with an 'uat-session-' prefix so leaked dirs are traceable", async () => {
    // fails when: a refactor drops the descriptive prefix — a leaked
    // tmpdir in /tmp is harder to attribute to this script, and
    // existing operator runbooks that grep `/tmp` for `uat-session-`
    // miss it.
    await writeToVault("k", "v");
    expect(mkdtempMock).toHaveBeenCalledTimes(1);
    const [prefix] = mkdtempMock.mock.calls[0] as [string];
    expect(prefix).toContain("uat-session-");
  });
});

describe("writeToVault: vault set spawn", () => {
  it("invokes `switchroom vault set <key> --file ... --format string --allow test-harness`", async () => {
    // fails when: the --allow scope is dropped — the session becomes
    // readable by any agent through the broker, defeating the
    // bearer-isolation goal. Or when --file is dropped — the value
    // would need to come via stdin, which the vault CLI refuses to
    // combine with --allow.
    await writeToVault("telegram-uat-driver-session", "S");
    const vaultCall = findCall(spawnMock, "switchroom");
    expect(vaultCall, "vault set spawn not found").toBeDefined();
    const [bin, args, opts] = vaultCall as [string, string[], { stdio: string }];
    expect(bin).toBe("switchroom");
    expect(args[0]).toBe("vault");
    expect(args[1]).toBe("set");
    expect(args[2]).toBe("telegram-uat-driver-session");
    expect(args).toContain("--file");
    expect(args).toContain("--format");
    expect(args).toContain("string");
    expect(args).toContain("--allow");
    expect(args).toContain(VAULT_SCOPE);
    expect(opts.stdio).toBe("inherit");
  });

  it("never passes the session string as an argv or env value", async () => {
    // fails when: a refactor "simplifies" by switching from --file
    // to argv. `ps -ef` would then leak the bearer credential to
    // every user on the host.
    await writeToVault("k", "S3CR3T_SESSION_STRING_VALUE");
    // Inspect every spawn (vault set + the shred cleanup) — none of
    // them may carry the session string.
    for (const call of spawnMock.mock.calls) {
      const [, args, opts] = call as [
        string,
        string[],
        { env?: Record<string, string> } | undefined,
      ];
      for (const arg of args) {
        expect(arg).not.toBe("S3CR3T_SESSION_STRING_VALUE");
      }
      // Default `spawn` inherits env from the parent — we DON'T want
      // to be putting the session into a custom env either.
      expect(opts?.env).toBeUndefined();
    }
  });
});

describe("writeToVault: cleanup on failure", () => {
  it("removes the tmpfile dir even when vault set exits non-zero", async () => {
    // fails when: cleanup runs only on the success path — operator
    // types wrong passphrase, leaves a world-traversable tmpdir
    // with a bearer-equivalent session string on disk until the OS
    // cleans `/tmp`. The whole point of the tmpfile dance is a
    // narrow exposure window.
    spawnMock.mockImplementationOnce(() => fakeProc(1));
    await expect(writeToVault("k", "v")).rejects.toThrow();
    expect(rmMock).toHaveBeenCalledTimes(1);
    const [dir, opts] = rmMock.mock.calls[0] as [
      string,
      { recursive?: boolean; force?: boolean },
    ];
    expect(dir).toBe("/tmp/uat-session-XYZ");
    expect(opts.recursive).toBe(true);
    expect(opts.force).toBe(true);
  });

  it("still removes the dir if spawn itself errors (binary missing, etc.)", async () => {
    // fails when: only the exit-code path triggers cleanup — a host
    // without `switchroom` on PATH would 'error' before exit, and
    // the tmpdir would persist.
    spawnMock.mockImplementationOnce(() =>
      fakeProc(0, new Error("ENOENT: switchroom not found")),
    );
    await expect(writeToVault("k", "v")).rejects.toThrow();
    expect(rmMock).toHaveBeenCalledTimes(1);
  });
});
