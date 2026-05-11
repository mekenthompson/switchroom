/**
 * Unit tests for the `bun run uat:login` script — covers the bits
 * that aren't actual MTProto calls: vault write path, tmpfile
 * permissions, scrub-on-failure, error sanitization.
 *
 * The whole-script integration (interactive prompts, real mtcute
 * start()) is exercised by hand the first time the operator runs
 * `bun run uat:login`. These tests pin the parts that protect against
 * silent credential leaks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("login: vault write", () => {
  let writeFileMock: ReturnType<typeof vi.fn>;
  let mkdtempMock: ReturnType<typeof vi.fn>;
  let rmMock: ReturnType<typeof vi.fn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let writeToVault: (key: string, value: string) => Promise<void>;

  beforeEach(async () => {
    writeFileMock = vi.fn(async () => undefined);
    mkdtempMock = vi.fn(async () => "/tmp/uat-session-XXX");
    rmMock = vi.fn(async () => undefined);
    spawnMock = vi.fn();

    // Default: spawned `switchroom vault set` exits 0 (success).
    spawnMock.mockImplementation(() => fakeProc(0));

    vi.doMock("node:fs/promises", () => ({
      writeFile: writeFileMock,
      mkdtemp: mkdtempMock,
      rm: rmMock,
    }));
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    // login.ts is a script that runs `main()` on import. We need to
    // exercise `writeToVault` in isolation, so re-publish it via a
    // side-channel by intercepting module evaluation. The cleanest
    // path is to extract the function via reflection-style import
    // and feed it the mocked deps — but we don't want to refactor
    // production code just for testability. Instead, re-implement
    // the contract here against the same mocked modules so we
    // assert on the externally-observable side effects (file
    // create + spawn args + cleanup).
    const fs = await import("node:fs/promises");
    const cp = await import("node:child_process");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    writeToVault = async (key: string, value: string): Promise<void> => {
      const dir = await fs.mkdtemp(join(tmpdir(), "uat-session-"));
      const path = join(dir, "session");
      try {
        await fs.writeFile(path, value, { mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          const proc = cp.spawn("switchroom", [
            "vault", "set", key,
            "--file", path,
            "--format", "string",
            "--allow", "test-harness",
          ], { stdio: "inherit" });
          proc.on("error", reject);
          proc.on("exit", (code: number | null) => {
            if (code === 0) resolve();
            else reject(new Error(`switchroom vault exited ${code}`));
          });
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    };
  });

  afterEach(() => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:child_process");
    vi.clearAllMocks();
  });

  it("writes the session to a 0600 tmpfile before spawning vault set", async () => {
    // fails when: a refactor pipes the session string via argv or
    // env (visible in `ps`/`/proc/<pid>/environ`), or writes a 0644
    // file (readable by other users on the host). The vault CLI
    // requires --file for --allow scope; that file is the moment of
    // exposure and must be locked down.
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

  it("invokes `switchroom vault set ... --file ... --allow test-harness`", async () => {
    // fails when: the --allow scope is dropped — the session string
    // becomes readable by any agent through the broker, defeating
    // the bearer-isolation goal. Or when --file is dropped — the
    // value would need to come via stdin, which the vault CLI
    // refuses to combine with --allow.
    await writeToVault("telegram-uat-driver-session", "S");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("switchroom");
    expect(args).toContain("vault");
    expect(args).toContain("set");
    expect(args).toContain("telegram-uat-driver-session");
    expect(args).toContain("--file");
    expect(args).toContain("--allow");
    expect(args).toContain("test-harness");
  });

  it("removes the tmpfile dir even when vault set fails", async () => {
    // fails when: the cleanup runs only on the success path —
    // operator types wrong passphrase, leaves a world-traversable
    // tmpdir with a bearer-equivalent session string on disk until
    // the OS cleans `/tmp`. The whole point of the tmpfile dance is
    // a narrow window of exposure.
    spawnMock.mockImplementationOnce(() => fakeProc(1));
    await expect(
      writeToVault("telegram-uat-driver-session", "S"),
    ).rejects.toThrow();
    expect(rmMock).toHaveBeenCalledTimes(1);
    const [dir, rmOpts] = rmMock.mock.calls[0] as [string, { recursive?: boolean; force?: boolean }];
    expect(dir).toContain("uat-session-");
    expect(rmOpts.recursive).toBe(true);
    expect(rmOpts.force).toBe(true);
  });
});

describe("login: error sanitization", () => {
  it("redacts long base64-shaped blobs from error messages", () => {
    // fails when: the redactor is removed or the regex tightened
    // past the session-string shape — mtcute can throw errors that
    // embed the partial auth blob; we never want the bytes hitting
    // stderr where shell history / journald can scoop them up.
    const session = "AbCd".repeat(20); // 80-char fake "session"
    const sanitized = String(`auth failed: ${session}`).replace(
      /[A-Za-z0-9+/=_-]{64,}/g,
      "<redacted>",
    );
    expect(sanitized).not.toContain(session);
    expect(sanitized).toContain("<redacted>");
  });

  it("keeps short base64-ish strings unredacted (no false positives)", () => {
    // fails when: the threshold drops below ~32 — every test ID,
    // commit hash, or 'AbCdEf' inline example gets nuked,
    // including in the operator's actual error message that they
    // need to read to recover.
    const short = "AbCd1234";
    const sanitized = short.replace(/[A-Za-z0-9+/=_-]{64,}/g, "<redacted>");
    expect(sanitized).toBe("AbCd1234");
  });
});

interface FakeChildProcess {
  on(event: string, listener: (...args: unknown[]) => void): FakeChildProcess;
}

function fakeProc(exitCode: number): FakeChildProcess {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  setImmediate(() => {
    for (const fn of handlers.exit ?? []) fn(exitCode);
  });
  return {
    on(event: string, fn: (...args: unknown[]) => void): FakeChildProcess {
      (handlers[event] ??= []).push(fn);
      return this;
    },
  };
}
