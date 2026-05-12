/**
 * Tests for the Repo Hygiene doctor probe (#1072).
 *
 * Threat model: clerk-export/ and *-with-secrets*.tar.gz are gitignored
 * but persist on disk in the repo root after the OpenClaw migration. The
 * probe surfaces residual state so an operator who skipped the migration
 * script sees a warning instead of silent exposure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRepoHygiene,
  isSwitchroomCheckout,
} from "../src/cli/doctor.js";

describe("checkRepoHygiene (#1072)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-hygiene-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns ok when the repo root is clean", () => {
    const results = checkRepoHygiene(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].name).toMatch(/#1072/);
  });

  it("warns when clerk-export/ exists", () => {
    mkdirSync(join(tempDir, "clerk-export"));
    writeFileSync(join(tempDir, "clerk-export", "MANIFEST.md"), "secrets");
    const results = checkRepoHygiene(tempDir);
    const exportWarning = results.find((r) => r.name.includes("clerk-export/ on disk"));
    expect(exportWarning).toBeDefined();
    expect(exportWarning?.status).toBe("warn");
    expect(exportWarning?.fix).toMatch(/migrate-clerk-export-to-vault\.sh/);
  });

  it("warns when clerk-export-with-secrets.tar.gz exists", () => {
    writeFileSync(join(tempDir, "clerk-export-with-secrets.tar.gz"), "fake");
    const results = checkRepoHygiene(tempDir);
    const tarballWarning = results.find((r) =>
      r.name.includes("clerk-export-with-secrets.tar.gz")
    );
    expect(tarballWarning).toBeDefined();
    expect(tarballWarning?.status).toBe("warn");
  });

  it("warns on any *-with-secrets*.tar.gz pattern (not just clerk-export)", () => {
    writeFileSync(join(tempDir, "myproject-with-secrets-2026.tar.gz"), "fake");
    const results = checkRepoHygiene(tempDir);
    const generic = results.find((r) =>
      r.name.includes("myproject-with-secrets-2026.tar.gz")
    );
    expect(generic).toBeDefined();
    expect(generic?.status).toBe("warn");
  });

  it("does not double-report the known tarball under the glob rule", () => {
    writeFileSync(join(tempDir, "clerk-export-with-secrets.tar.gz"), "fake");
    const results = checkRepoHygiene(tempDir);
    // Only one warning, not two.
    const matching = results.filter((r) =>
      r.name.includes("clerk-export-with-secrets.tar.gz")
    );
    expect(matching).toHaveLength(1);
  });

  it("reports all three when all are present", () => {
    mkdirSync(join(tempDir, "clerk-export"));
    writeFileSync(join(tempDir, "clerk-export-with-secrets.tar.gz"), "fake");
    writeFileSync(join(tempDir, "backup-with-secrets.tar.gz"), "fake");
    const results = checkRepoHygiene(tempDir);
    // 3 warnings, no "ok" placeholder.
    expect(results.filter((r) => r.status === "warn")).toHaveLength(3);
    expect(results.find((r) => r.status === "ok")).toBeUndefined();
  });

  it("returns clean ok when sibling files exist that don't match the pattern", () => {
    writeFileSync(join(tempDir, "README.md"), "");
    writeFileSync(join(tempDir, "package.json"), "{}");
    writeFileSync(join(tempDir, "backup.tar.gz"), ""); // no "-with-secrets" — fine
    const results = checkRepoHygiene(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
  });
});

describe("isSwitchroomCheckout (#1072)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-checkout-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false for an empty directory", () => {
    expect(isSwitchroomCheckout(tempDir)).toBe(false);
  });

  it("returns false when .git is present but package.json is missing", () => {
    mkdirSync(join(tempDir, ".git"));
    expect(isSwitchroomCheckout(tempDir)).toBe(false);
  });

  it("returns false when package.json has a different name", () => {
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "other-project" }));
    expect(isSwitchroomCheckout(tempDir)).toBe(false);
  });

  it("returns true for a switchroom checkout", () => {
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "switchroom" }));
    expect(isSwitchroomCheckout(tempDir)).toBe(true);
  });

  it("returns false when package.json is malformed", () => {
    mkdirSync(join(tempDir, ".git"));
    writeFileSync(join(tempDir, "package.json"), "{ not json");
    expect(isSwitchroomCheckout(tempDir)).toBe(false);
  });
});
