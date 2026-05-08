/**
 * Pause-sentinel reader test (Phase 3b-2b).
 *
 * `migrate to-docker` writes ~/.switchroom/watchdog.paused before
 * tearing down the systemd fleet so the watchdog (which races to
 * "fix" any container that disappears) sits out the cutover.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWatchdogPaused } from "./pause.js";

function tmpFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), "sr-wp-"));
  return join(d, name);
}

describe("isWatchdogPaused", () => {
  it("returns false when sentinel does not exist", () => {
    expect(isWatchdogPaused(tmpFile("absent"))).toBe(false);
  });

  it("returns true when sentinel exists", () => {
    const p = tmpFile("watchdog.paused");
    writeFileSync(p, "paused-by=migrate\n", "utf8");
    expect(isWatchdogPaused(p)).toBe(true);
  });
});
