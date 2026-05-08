import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMigrationLogEntry,
  _resetLogChainForTests,
} from "./log.js";

beforeEach(() => {
  _resetLogChainForTests();
});

function tmpLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-mlog-"));
  return join(dir, "nested", "migration.log");
}

describe("appendMigrationLogEntry", () => {
  it("creates the log file (and parent dir) on first write", async () => {
    const path = tmpLog();
    expect(existsSync(path)).toBe(false);
    await appendMigrationLogEntry(
      { verb: "to-docker", step: "preflight", status: "ok" },
      path,
    );
    expect(existsSync(path)).toBe(true);
  });

  it("writes one valid JSON object per line", async () => {
    const path = tmpLog();
    await appendMigrationLogEntry(
      { verb: "to-docker", step: "compose-up", status: "ok", detail: "first" },
      path,
    );
    await appendMigrationLogEntry(
      { verb: "to-docker", step: "marker-write", status: "ok" },
      path,
    );
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(parsed.verb).toBe("to-docker");
      expect(parsed.status).toBe("ok");
      expect(typeof parsed.ts).toBe("string");
      expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
    }
  });

  it("supports error and rollback statuses", async () => {
    const path = tmpLog();
    await appendMigrationLogEntry(
      { verb: "to-host", step: "compose-down", status: "error", error: "boom" },
      path,
    );
    await appendMigrationLogEntry(
      { verb: "to-host", step: "compose-down", status: "rollback", detail: "restored" },
      path,
    );
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].status).toBe("error");
    expect(lines[0].error).toBe("boom");
    expect(lines[1].status).toBe("rollback");
    expect(lines[1].detail).toBe("restored");
  });

  it("is concurrency-safe under parallel appends", async () => {
    const path = tmpLog();
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendMigrationLogEntry(
          { verb: "to-docker", step: `step-${i}`, status: "ok" },
          path,
        ),
      ),
    );
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(N);
    // Every line should be valid JSON (no interleaved partial writes)
    const steps = new Set<string>();
    for (const l of lines) {
      const parsed = JSON.parse(l);
      steps.add(parsed.step);
    }
    expect(steps.size).toBe(N);
  });

  it("respects an injected ts", async () => {
    const path = tmpLog();
    const fixed = "2025-01-01T00:00:00.000Z";
    await appendMigrationLogEntry(
      { verb: "to-docker", step: "x", status: "ok", ts: fixed },
      path,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8").trim());
    expect(parsed.ts).toBe(fixed);
  });

  it("a write failure does not poison subsequent writes", async () => {
    const badPath = "/proc/1/cannot-write-here";
    await expect(
      appendMigrationLogEntry({ verb: "to-docker", step: "x", status: "ok" }, badPath),
    ).rejects.toBeTruthy();
    // Following writes to a good path should still succeed
    const good = tmpLog();
    await appendMigrationLogEntry(
      { verb: "to-docker", step: "y", status: "ok" },
      good,
    );
    expect(existsSync(good)).toBe(true);
  });
});
