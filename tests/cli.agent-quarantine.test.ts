import { describe, it, expect } from "vitest";

import {
  checkQuarantineRefusal,
  formatQuarantineRefusal,
} from "../src/cli/agent.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostTelegramStateDir,
  writeQuarantineMarker,
} from "../src/agents/quarantine.js";

/**
 * Coverage for the CLI-side quarantine refusal + formatter (#1076).
 *
 * `checkQuarantineRefusal` is the load-bearing gate for `switchroom
 * agent start` / `restart` — if it returns false for a quarantined
 * agent, the operator pays for another respawn loop on the doomed
 * gateway. If it returns true for a non-quarantined agent, every
 * start spuriously aborts.
 */

describe("formatQuarantineRefusal", () => {
  it("includes the agent name, reason text, and operator action", () => {
    const out = formatQuarantineRefusal("alfred", {
      v: 1,
      reason: "startup.unauthorized",
      ts: Date.now() - 5_000,
      detail: "Telegram API returned 401 Unauthorized for getMe.",
    });
    expect(out).toMatch(/alfred is QUARANTINED/);
    expect(out).toMatch(/401 Unauthorized/);
    expect(out).toMatch(/switchroom agent unquarantine alfred/);
  });

  it("handles a missing detail field without printing 'undefined'", () => {
    const out = formatQuarantineRefusal("alfred", {
      v: 1,
      reason: "startup.unauthorized",
      ts: Date.now(),
    });
    expect(out).not.toMatch(/undefined/);
  });
});

describe("checkQuarantineRefusal", () => {
  it("returns false when no marker is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "quar-refusal-"));
    try {
      // No marker created → no refusal.
      expect(checkQuarantineRefusal(dir, "alfred")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when a marker exists (caller should abort)", () => {
    const agentsDir = mkdtempSync(join(tmpdir(), "quar-refusal-"));
    try {
      const stateDir = hostTelegramStateDir(agentsDir, "alfred");
      mkdirSync(stateDir, { recursive: true });
      writeQuarantineMarker(stateDir, "startup.unauthorized", "401");
      // Suppress console.error noise from the printed banner.
      const origErr = console.error;
      console.error = () => {};
      try {
        expect(checkQuarantineRefusal(agentsDir, "alfred")).toBe(true);
      } finally {
        console.error = origErr;
      }
    } finally {
      rmSync(agentsDir, { recursive: true, force: true });
    }
  });
});
