import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerUpCommand, registerInitCommand } from "./deprecated.js";

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
