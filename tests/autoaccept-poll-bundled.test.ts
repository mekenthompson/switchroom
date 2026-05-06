import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Lock in that the autoaccept-poll entrypoint actually ships in dist/.
// Regression guard for the v0.7.0 release-day bug: the systemd agent unit
// referenced `dist/cli/autoaccept-poll.ts`, but scripts/build.mjs only
// bundled bin/switchroom.ts and package.json files-array doesn't include
// src/, so the published package shipped no autoaccept-poll at all and
// every fresh agent boot wedged on the first-run TUI prompt.

const distRoot = resolve(import.meta.dirname, "..", "dist", "cli");
const builtPoll = resolve(distRoot, "autoaccept-poll.js");

describe("autoaccept-poll bundled output (release-shape regression)", () => {
  it("dist/cli/autoaccept-poll.js exists after build", () => {
    expect(existsSync(builtPoll), `expected ${builtPoll} to exist after npm run build`).toBe(true);
  });

  it("dist/cli/autoaccept-poll.js is non-empty and executable", () => {
    if (!existsSync(builtPoll)) return; // first assertion already failed
    const st = statSync(builtPoll);
    expect(st.size).toBeGreaterThan(1024);
    // owner-execute bit
    expect(st.mode & 0o100).not.toBe(0);
  });

  it("dist/cli/autoaccept-poll.js has bun shebang", async () => {
    if (!existsSync(builtPoll)) return;
    const { readFileSync } = await import("node:fs");
    const head = readFileSync(builtPoll, "utf-8").slice(0, 20);
    expect(head).toMatch(/^#!\/usr\/bin\/env bun/);
  });
});
