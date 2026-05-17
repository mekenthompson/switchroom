/**
 * atomic — sec #1410 (TOCTOU follow-up to CRITICAL #1393). The two
 * brokers run as ROOT through this primitive, so the symlink-safety
 * guarantees matter. Pre-#1410 atomic.ts had no direct test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  lstatSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync, atomicWriteJsonSync } from "./atomic.js";

describe("atomicWriteFileSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content at 0600 by default and leaves no tempfile", () => {
    const p = join(dir, "secret.json");
    atomicWriteFileSync(p, "hello");
    expect(readFileSync(p, "utf8")).toBe("hello");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // No `.tmp-` leak on the success path.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("atomically replaces an existing regular file", () => {
    const p = join(dir, "f");
    writeFileSync(p, "OLD");
    atomicWriteFileSync(p, "NEW");
    expect(readFileSync(p, "utf8")).toBe("NEW");
  });

  it("atomicWriteJsonSync writes pretty JSON + trailing newline", () => {
    const p = join(dir, "c.json");
    atomicWriteJsonSync(p, { a: 1 });
    expect(readFileSync(p, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  // THE security property (#1393/#1410): if the destination is an
  // attacker-planted symlink to a sensitive file, the write must NOT
  // follow it — rename(2) replaces the symlink itself, so the pointed-
  // at victim is never modified and dest becomes a real file.
  it("does not write through a symlinked destination (no symlink-follow)", () => {
    const victim = join(dir, "victim-secret");
    writeFileSync(victim, "SECRET-UNTOUCHED");
    const dest = join(dir, "dest");
    symlinkSync(victim, dest);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);

    atomicWriteFileSync(dest, "ATTACKER-CONTROLLED-PAYLOAD");

    // dest is now a regular file with the new bytes …
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("ATTACKER-CONTROLLED-PAYLOAD");
    // … and the symlink's victim was NEVER written through.
    expect(readFileSync(victim, "utf8")).toBe("SECRET-UNTOUCHED");
  });

  it("propagates errors fail-closed (bad dir → throws, dest untouched)", () => {
    const p = join(dir, "nope", "deep", "x");
    expect(() => atomicWriteFileSync(p, "data")).toThrow();
  });
});
