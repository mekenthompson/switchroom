/**
 * Watchdog pause sentinel — Phase 3b-2b.
 *
 * `switchroom migrate to-docker` writes a marker file before tearing
 * down the systemd fleet so the watchdog (which races to "fix" any
 * container that disappears) sits out the cutover. Lives in its own
 * tiny module so non-Bun test runners (vitest) can import the pause
 * predicate without dragging in bun:sqlite via watchdog/index.ts.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PAUSE_SENTINEL = join(homedir(), ".switchroom", "watchdog.paused");

export function isWatchdogPaused(path: string = DEFAULT_PAUSE_SENTINEL): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
