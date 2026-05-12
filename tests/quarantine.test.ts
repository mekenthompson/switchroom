import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearQuarantineMarker,
  hostTelegramStateDir,
  quarantineMarkerPath,
  readQuarantineMarker,
  readQuarantineMarkerForAgent,
  writeQuarantineMarker,
  QUARANTINE_FILENAME,
} from "../src/agents/quarantine.js";

/**
 * Coverage for the on-disk quarantine marker contract (#1076).
 *
 * The marker is the load-bearing signal that ties the gateway's 401
 * detection to the host CLI's refuse-to-start path. If the writer/reader
 * disagree on shape or location, the entire fix collapses silently.
 */

describe("quarantine marker", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-quarantine-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("write then read round-trips fields", () => {
    writeQuarantineMarker(
      dir,
      "startup.unauthorized",
      "Telegram API returned 401 Unauthorized for getMe.",
      () => 1700000000000,
    );
    const got = readQuarantineMarker(dir);
    expect(got).not.toBeNull();
    expect(got!.v).toBe(1);
    expect(got!.reason).toBe("startup.unauthorized");
    expect(got!.ts).toBe(1700000000000);
    expect(got!.detail).toBe(
      "Telegram API returned 401 Unauthorized for getMe.",
    );
  });

  it("read returns null when the marker is absent", () => {
    expect(readQuarantineMarker(dir)).toBeNull();
  });

  it("read returns null on unparseable JSON (best-effort surface)", () => {
    writeFileSync(quarantineMarkerPath(dir), "{not json", "utf-8");
    expect(readQuarantineMarker(dir)).toBeNull();
  });

  it("read returns null on a v=99 marker (forward-compat: unknown schema is no marker)", () => {
    writeFileSync(
      quarantineMarkerPath(dir),
      JSON.stringify({ v: 99, reason: "x", ts: 1 }) + "\n",
      "utf-8",
    );
    expect(readQuarantineMarker(dir)).toBeNull();
  });

  it("write creates the parent dir when missing", () => {
    const nested = join(dir, "telegram-state-doesnt-exist-yet");
    writeQuarantineMarker(nested, "startup.unauthorized");
    const got = readQuarantineMarker(nested);
    expect(got).not.toBeNull();
    expect(got!.reason).toBe("startup.unauthorized");
  });

  it("write is idempotent and overwrites prior markers", () => {
    writeQuarantineMarker(dir, "startup.unauthorized", "first", () => 100);
    writeQuarantineMarker(dir, "startup.unauthorized", "second", () => 200);
    const got = readQuarantineMarker(dir);
    expect(got!.ts).toBe(200);
    expect(got!.detail).toBe("second");
  });

  it("written file does not contain bot-token-like material (sanity check on the contract)", () => {
    writeQuarantineMarker(
      dir,
      "startup.unauthorized",
      "Telegram API returned 401 Unauthorized for getMe at gateway startup.",
    );
    const raw = readFileSync(quarantineMarkerPath(dir), "utf-8");
    // The Telegram bot token format is `<digits>:<base64ish>`. Make sure
    // a colon-separated digit-prefixed string can't sneak in via detail.
    expect(raw).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
  });

  it("clearQuarantineMarker removes the file and returns true; second call returns false", () => {
    writeQuarantineMarker(dir, "startup.unauthorized");
    expect(clearQuarantineMarker(dir)).toBe(true);
    expect(readQuarantineMarker(dir)).toBeNull();
    expect(clearQuarantineMarker(dir)).toBe(false);
  });

  it("hostTelegramStateDir composes <agentsDir>/<name>/telegram", () => {
    expect(hostTelegramStateDir("/srv/agents", "alfred")).toBe(
      "/srv/agents/alfred/telegram",
    );
  });

  it("readQuarantineMarkerForAgent reads via the same on-disk location the gateway writes to", () => {
    const agentsDir = dir;
    const name = "alfred";
    const stateDir = hostTelegramStateDir(agentsDir, name);
    mkdirSync(stateDir, { recursive: true });
    writeQuarantineMarker(stateDir, "startup.unauthorized", "detail-here", () => 42);
    const got = readQuarantineMarkerForAgent(agentsDir, name);
    expect(got).not.toBeNull();
    expect(got!.ts).toBe(42);
    expect(got!.detail).toBe("detail-here");
  });

  it("uses the documented filename `quarantine.json` (contract symmetry with telegram-plugin/gateway/quarantine.ts)", () => {
    expect(QUARANTINE_FILENAME).toBe("quarantine.json");
    writeQuarantineMarker(dir, "startup.unauthorized");
    expect(quarantineMarkerPath(dir)).toBe(join(dir, "quarantine.json"));
  });
});
