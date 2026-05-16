/**
 * Regression test for #1393 (WS1 fresh-reviewer gate, epic #1389).
 *
 * BUG: `mirrorAccountToAgent` (auth-broker, runs as root with
 * CAP_DAC_OVERRIDE) wrote the per-agent OAuth mirror into
 * `~/.switchroom/agents/<name>/.claude/.credentials.json` with
 * `mkdirSync({recursive})` + atomic-write + `chownSync` and NO
 * symlink guard. That tree is agent-UID-owned and RW bind-mounted
 * into the (potentially prompt-injected) agent container, so the
 * agent could pre-plant `.claude` (or `agentDir`, or the target
 * file) as a symlink and the root broker would dereference it on
 * the next fanout → arbitrary host-path root-owned write.
 *
 * FIX: `resolveMirrorPathsSafe` lstats every controllable path
 * component (agentsDir / agentDir / .claude / target) BEFORE any
 * mkdir/write/chown and fails closed (skips that agent's mirror,
 * logs + audits) if any is a symlink or the wrong type — never
 * crashing the whole fanout.
 *
 * These tests drive the real fanout (boot `fanoutAll`) through a
 * temp HOME, exactly like `server-mirror-enrich.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import { accountCredentialsPath, accountDir } from "../account-store.js";
import type { SwitchroomConfig } from "../../config/schema.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-symlink-guard-test-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(h: Harness, agents: Record<string, object>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
    auth: { active: "default" },
  } as unknown as SwitchroomConfig;
}

function writeSourceCreds(h: Harness, label: string): void {
  mkdirSync(accountDir(label, h.home), { recursive: true });
  writeFileSync(
    accountCredentialsPath(label, h.home),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-default",
        refreshToken: "rt-default",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  );
}

function readAudit(h: Harness): string {
  const p = join(h.stateDir, "audit.jsonl");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

describe("AuthBroker — symlink-guarded per-agent mirror (#1393)", () => {
  it("REFUSES to write through a pre-planted `.claude` symlink (no root-owned write at the symlink target)", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    // The agent owns ~/.switchroom/agents/ziggy/ and pre-plants
    // `.claude` -> an attacker-chosen escape target.
    const agentDir = join(h.agentsDir, "ziggy");
    mkdirSync(agentDir, { recursive: true });
    const escapeTarget = join(h.tmp, "escape-target");
    mkdirSync(escapeTarget, { recursive: true });
    symlinkSync(escapeTarget, join(agentDir, ".claude"));

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start(); // boot fanout fires here
    broker.stop();

    // The broker must NOT have dereferenced the symlink: nothing
    // written into the escape target.
    expect(existsSync(join(escapeTarget, ".credentials.json"))).toBe(false);
    // And the symlink is left intact (not replaced by a real file/dir).
    expect(existsSync(join(agentDir, ".claude", ".credentials.json"))).toBe(
      false,
    );

    // The refusal is audited as a structured security event.
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain(".claude:is-a-symlink");
  });

  it("REFUSES to write through a pre-planted symlinked `agentDir`", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    const escapeTarget = join(h.tmp, "escape-target-2");
    mkdirSync(escapeTarget, { recursive: true });
    // agentDir itself is a symlink to an attacker-chosen dir.
    symlinkSync(escapeTarget, join(h.agentsDir, "ziggy"));

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    broker.stop();

    expect(existsSync(join(escapeTarget, ".claude", ".credentials.json"))).toBe(
      false,
    );
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain("agentDir:is-a-symlink");
  });

  it("REFUSES a symlinked `.credentials.json` target file", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    const agentDir = join(h.agentsDir, "ziggy");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const escapeFile = join(h.tmp, "escape-file");
    writeFileSync(escapeFile, "original");
    symlinkSync(escapeFile, join(claudeDir, ".credentials.json"));

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    broker.stop();

    // The escape file must not have been overwritten with creds.
    expect(readFileSync(escapeFile, "utf-8")).toBe("original");
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain(".credentials.json:is-a-symlink");
  });

  it("one poisoned agent does NOT block a legitimate agent's mirror (fail-closed, not fail-stop)", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    // Poisoned agent.
    const evil = join(h.agentsDir, "evil");
    mkdirSync(evil, { recursive: true });
    const escapeTarget = join(h.tmp, "escape-target-3");
    mkdirSync(escapeTarget, { recursive: true });
    symlinkSync(escapeTarget, join(evil, ".claude"));

    // Legitimate agent — a normal scaffolded dir.
    mkdirSync(join(h.agentsDir, "good"), { recursive: true });

    const broker = new AuthBroker(
      makeConfig(h, { evil: {}, good: {} }),
      {
        home: h.home,
        stateDir: h.stateDir,
        socketRoot: h.socketRoot,
        disableRefreshLoop: true,
      },
    );
    await broker.start();
    broker.stop();

    // Evil agent skipped, no escape write.
    expect(existsSync(join(escapeTarget, ".credentials.json"))).toBe(false);
    // Good agent still got a correct mirror.
    const good = JSON.parse(
      readFileSync(
        join(h.agentsDir, "good", ".claude", ".credentials.json"),
        "utf-8",
      ),
    );
    expect(good.claudeAiOauth.accessToken).toBe("at-default");
  });

  it("REGRESSION: a legitimate non-symlink path still mirrors correctly", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    broker.stop();

    const mirrorPath = join(
      h.agentsDir,
      "ziggy",
      ".claude",
      ".credentials.json",
    );
    expect(existsSync(mirrorPath)).toBe(true);
    // Real file, not a symlink, and lands at the expected path.
    expect(realpathSync(mirrorPath)).toBe(mirrorPath);
    const mirror = JSON.parse(readFileSync(mirrorPath, "utf-8"));
    expect(mirror.claudeAiOauth.accessToken).toBe("at-default");
    expect(mirror.claudeAiOauth.refreshToken).toBe("rt-default");
    // No spurious refusal audited on the happy path.
    expect(readAudit(h)).not.toContain("mirror-symlink-refused");
  });
});
