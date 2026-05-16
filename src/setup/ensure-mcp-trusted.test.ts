/**
 * Tests for `ensureMcpServersTrusted` in setup/onboarding.ts (Bug B).
 *
 * Claude Code only loads project `.mcp.json` servers listed in
 * `.claude.json` `projects[<absDir>].enabledMcpjsonServers`.
 * `preTrustWorkspace` never set that array, so servers scaffolded after
 * original onboarding (gdrive, agent-config/hostd on non-original agents)
 * were silently dropped. This helper unions the just-written server keys
 * into that allowlist, idempotently, preserving hasTrustDialogAccepted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ensureMcpServersTrusted } from "./onboarding.js";

let agentDir: string;

function writeClaudeJson(obj: unknown): void {
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify(obj, null, 2));
}

function readClaudeJson(): {
  projects: Record<
    string,
    {
      hasTrustDialogAccepted?: boolean;
      enabledMcpjsonServers?: string[];
      allowedTools?: string[];
    }
  >;
} {
  return JSON.parse(
    readFileSync(join(agentDir, ".claude", ".claude.json"), "utf-8"),
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "switchroom-trust-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("ensureMcpServersTrusted", () => {
  it("unions server keys into enabledMcpjsonServers (⊇ [a,b])", () => {
    writeClaudeJson({
      projects: {
        [resolve(agentDir)]: {
          hasTrustDialogAccepted: true,
          allowedTools: [],
        },
      },
    });

    ensureMcpServersTrusted(agentDir, ["a", "b"]);

    const project = readClaudeJson().projects[resolve(agentDir)];
    expect(project.enabledMcpjsonServers).toEqual(
      expect.arrayContaining(["a", "b"]),
    );
    expect(project.hasTrustDialogAccepted).toBe(true);
  });

  it("is idempotent on a second call (no duplicates, trust preserved)", () => {
    writeClaudeJson({
      projects: {
        [resolve(agentDir)]: { hasTrustDialogAccepted: true },
      },
    });

    ensureMcpServersTrusted(agentDir, ["a", "b"]);
    ensureMcpServersTrusted(agentDir, ["a", "b"]);

    const project = readClaudeJson().projects[resolve(agentDir)];
    expect(project.enabledMcpjsonServers).toEqual(["a", "b"]);
    expect(project.hasTrustDialogAccepted).toBe(true);
  });

  it("unions with pre-existing enabledMcpjsonServers entries", () => {
    writeClaudeJson({
      projects: {
        [resolve(agentDir)]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ["switchroom-telegram"],
        },
      },
    });

    ensureMcpServersTrusted(agentDir, ["agent-config", "gdrive"]);

    const project = readClaudeJson().projects[resolve(agentDir)];
    expect(project.enabledMcpjsonServers).toEqual(
      expect.arrayContaining([
        "switchroom-telegram",
        "agent-config",
        "gdrive",
      ]),
    );
    expect(project.enabledMcpjsonServers).toHaveLength(3);
  });

  it("creates the projects entry/array when missing", () => {
    writeClaudeJson({ hasCompletedOnboarding: true });

    ensureMcpServersTrusted(agentDir, ["gdrive"]);

    const project = readClaudeJson().projects[resolve(agentDir)];
    expect(project.enabledMcpjsonServers).toEqual(["gdrive"]);
    expect(project.hasTrustDialogAccepted).toBe(true);
    expect(project.allowedTools).toEqual([]);
  });

  it("skips silently when .claude.json is absent", () => {
    // no writeClaudeJson() — file does not exist
    expect(() =>
      ensureMcpServersTrusted(agentDir, ["gdrive"]),
    ).not.toThrow();
    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(false);
  });

  it("skips silently when .claude.json is unparseable", () => {
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, ".claude.json"), "{ not valid json");

    expect(() =>
      ensureMcpServersTrusted(agentDir, ["gdrive"]),
    ).not.toThrow();
  });
});
