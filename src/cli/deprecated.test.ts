import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerUpCommand, registerInitCommand } from "./deprecated.js";
import { registerUpdateCommand } from "./update.js";

vi.mock("./apply.js", () => ({
  runApply: vi.fn().mockResolvedValue({ composePath: "/tmp/dc.yml", composeBytes: 10 }),
}));

vi.mock("../config/loader.js", async () => {
  const actual = await vi.importActual<typeof import("../config/loader.js")>("../config/loader.js");
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      switchroom: { agents_dir: "/tmp/agents" },
      agents: {},
      telegram: { forum_chat_id: "0" },
      defaults: {},
    })),
    findConfigFile: vi.fn(() => "/tmp/switchroom.yaml"),
  };
});

import { runApply } from "./apply.js";

/**
 * Smoke tests — make sure the deprecation shims register cleanly and
 * carry the flags they need. We do not exercise their action handlers
 * here (those would require a real switchroom.yaml + scaffold); the
 * goal is to prove that the command surface is intact so the v0.6 →
 * v0.7 in-flight upgrade path keeps parsing.
 */
describe("deprecation shims", () => {
  it("registers `up` with --build-local, --out, --legacy", () => {
    const program = new Command();
    registerUpCommand(program);
    const up = program.commands.find((c) => c.name() === "up");
    expect(up).toBeDefined();
    const flags = up!.options.map((o) => o.long);
    expect(flags).toContain("--build-local");
    expect(flags).toContain("--out");
    expect(flags).toContain("--legacy");
    expect(up!.description()).toMatch(/deprecated/i);
  });

  it("registers `init` with --example, --build-local, --out", () => {
    const program = new Command();
    registerInitCommand(program);
    const init = program.commands.find((c) => c.name() === "init");
    expect(init).toBeDefined();
    const flags = init!.options.map((o) => o.long);
    expect(flags).toContain("--example");
    expect(flags).toContain("--build-local");
    expect(flags).toContain("--out");
    expect(init!.description()).toMatch(/deprecated/i);
  });
});

// ─── PR-D1 / v0.7 coverage gap #5 ────────────────────────────────────────────
// Exit-code + delegation assertions for the deprecation shims.

describe("`up` and `init` delegate to runApply with a yellow deprecation warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("`up` prints a yellow `deprecated` warning and forwards to runApply", async () => {
    const program = new Command();
    program.exitOverride();
    registerUpCommand(program);
    await program.parseAsync(["node", "switchroom", "up"]);

    // Warning printed (chalk yellow leaves the text intact)
    expect(warnSpy).toHaveBeenCalled();
    const banner = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(banner).toMatch(/switchroom up is deprecated/);
    expect(banner).toMatch(/use `switchroom apply`/);
    expect(runApply).toHaveBeenCalledOnce();
  });

  it("`init` prints a yellow `deprecated` warning and forwards to runApply, threading --example", async () => {
    const program = new Command();
    program.exitOverride();
    registerInitCommand(program);
    await program.parseAsync(["node", "switchroom", "init", "--example", "minimal"]);

    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toMatch(
      /switchroom init is deprecated/,
    );
    expect(runApply).toHaveBeenCalledOnce();
    const applyCall = (runApply as any).mock.calls[0]!;
    // Second arg is the apply opts; we threaded --example through.
    expect(applyCall[1]).toMatchObject({ example: "minimal" });
  });
});

describe("`update` legacy-flag handling (post-#918)", () => {
  // PR #918 replaced the `update` removed-shim with the real bundled
  // update verb. Legacy v0.6 flags (--phase, --force, --no-restart,
  // --resume) are still accepted as no-ops so any in-flight v0.6 →
  // v0.7 self-reexec doesn't crash on argv it no longer recognises.
  // The old "update is removed in v0.7" tests have been retired.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error(`__exit_${_code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("`update --phase=post-build` exits 0 with the v0.6→v0.7 self-reexec compat notice", async () => {
    const program = new Command();
    program.exitOverride();
    registerUpdateCommand(program);

    await expect(
      program.parseAsync(["node", "switchroom", "update", "--phase", "post-build"]),
    ).rejects.toThrow(/__exit_0/);

    const warnBanner = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(warnBanner).toMatch(/post-build/);
    expect(warnBanner).toMatch(/legacy v0\.6 self-reexec path/);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
