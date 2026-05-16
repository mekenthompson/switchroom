import { describe, it, expect } from "vitest";
import { runCredentialsMigrationChecks } from "./doctor-credentials-migration.js";
import type { SwitchroomConfig } from "../config/schema.js";

function cfg(agents: string[]): SwitchroomConfig {
  return {
    agents: Object.fromEntries(agents.map((a) => [a, {}])),
  } as unknown as SwitchroomConfig;
}

function deps(
  entries: string[],
  dirs: Set<string>,
  credentialsDir = "/cred",
) {
  return {
    credentialsDir,
    existsSync: (p: string) => p === credentialsDir,
    readdirSync: (_: string) => entries,
    isDirectory: (p: string) => dirs.has(p),
  };
}

describe("runCredentialsMigrationChecks (sec WS6-F2)", () => {
  it("silent ([]) when no credentials dir exists", () => {
    expect(
      runCredentialsMigrationChecks(cfg(["a"]), {
        credentialsDir: "/cred",
        existsSync: () => false,
      }),
    ).toEqual([]);
  });

  it("ok when only per-agent subdirs (declared agents) exist", () => {
    const rs = runCredentialsMigrationChecks(
      cfg(["a", "b"]),
      deps(["a", "b"], new Set(["/cred/a", "/cred/b"])),
    );
    expect(rs).toHaveLength(1);
    expect(rs[0]!.status).toBe("ok");
  });

  it("WARNS (not fail, not silent) on a flat credential FILE", () => {
    const rs = runCredentialsMigrationChecks(
      cfg(["a"]),
      deps(["a", "shared-token.json"], new Set(["/cred/a"])),
    );
    const w = rs.find((r) => r.name.includes("flat entries"));
    expect(w?.status).toBe("warn");
    expect(w?.detail).toContain("shared-token.json");
    expect(w?.fix).toContain("mv");
  });

  it("treats a non-agent-named directory as flat (no agent mounts it)", () => {
    const rs = runCredentialsMigrationChecks(
      cfg(["a"]),
      deps(["a", "legacy"], new Set(["/cred/a", "/cred/legacy"])),
    );
    expect(rs[0]!.status).toBe("warn");
    expect(rs[0]!.detail).toContain("legacy");
  });
});
