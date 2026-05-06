// Bug 2 regression — reconcile must include systemd-unit drift in its
// "in sync" decision. Symptom: an operator added a fresh agent block to
// switchroom.yaml (no explicit experimental.legacy_pty), expecting the
// fleet default of tmux supervisor. `switchroom agent reconcile <agent>`
// reported "already in sync" while the on-disk unit was the LEGACY one
// (Type=simple, script -qfc) — so `restart` kept booting the agent under
// the wrong supervisor. Forcing `switchroom systemd install` regenerated
// the correct tmux unit. Root cause: the standalone `agent reconcile`
// CLI verb wasn't comparing the rendered systemd unit to disk; it only
// looked at in-agent-dir files (settings.json, .mcp.json, start.sh, ...).
//
// The decision logic is split out of `regenerateSystemdUnitsForAgent`
// into the pure `planAgentSystemdUnits` so we can drive it without
// shelling out to systemctl or touching ~/.config/systemd/user.

import { describe, it, expect } from "vitest";
import { planAgentSystemdUnits } from "../src/cli/agent.js";
import type { AgentConfig, SwitchroomConfig } from "../src/config/schema.js";

function makeConfig(agents: Record<string, AgentConfig>): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: { bot_token: "vault:telegram-bot-token" },
    defaults: {},
    agents,
  } as unknown as SwitchroomConfig;
}

describe("planAgentSystemdUnits — legacy_pty drives unit content", () => {
  it("legacy_pty:true vs unset produce DIFFERENT effective agent units", () => {
    const tmuxAgent: AgentConfig = {
      soul: "test soul",
    } as unknown as AgentConfig;
    const legacyAgent: AgentConfig = {
      soul: "test soul",
      experimental: { legacy_pty: true },
    } as unknown as AgentConfig;

    // Disk reads return "" — i.e. nothing on disk. Both will report
    // drifted, but with DIFFERENT desired content. That difference is
    // what the bug-2 fix has to detect.
    const tmuxPlan = planAgentSystemdUnits(
      "alpha",
      makeConfig({ alpha: tmuxAgent }),
      "/agents",
      () => "",
    );
    const legacyPlan = planAgentSystemdUnits(
      "alpha",
      makeConfig({ alpha: legacyAgent }),
      "/agents",
      () => "",
    );

    const tmuxUnit = tmuxPlan[0].desired;
    const legacyUnit = legacyPlan[0].desired;

    expect(tmuxUnit).not.toBe(legacyUnit);
    // Spot-check the structural differences that would matter to an
    // operator debugging "wrong supervisor on disk".
    expect(tmuxUnit).toContain("Type=forking");
    expect(tmuxUnit).toContain("/usr/bin/tmux");
    expect(legacyUnit).toContain("Type=simple");
    expect(legacyUnit).toContain("/usr/bin/script -qfc");
  });

  it("detects drift when on-disk unit is legacy but resolved config is tmux (the reported bug)", () => {
    // Resolved config: tmux (no legacy_pty flag set).
    const config = makeConfig({
      alpha: { soul: "test" } as unknown as AgentConfig,
    });

    // On-disk unit: render the legacy variant by planning with a synthetic
    // legacy config, then feed THAT content as the "current" disk read
    // for the tmux planning call. This simulates the production scenario:
    // operator changed yaml from legacy_pty:true to (omitted), reconcile
    // sees tmux as the desired but legacy on disk.
    const legacyConfig = makeConfig({
      alpha: {
        soul: "test",
        experimental: { legacy_pty: true },
      } as unknown as AgentConfig,
    });
    const legacyOnDisk = planAgentSystemdUnits(
      "alpha",
      legacyConfig,
      "/agents",
      () => "",
    )[0].desired;

    const plan = planAgentSystemdUnits(
      "alpha",
      config,
      "/agents",
      (_path) => legacyOnDisk,
    );

    // plan[0] is the agent unit; plan[1] (if present) is the gateway.
    expect(plan.length).toBeGreaterThanOrEqual(1);
    expect(plan[0].unitName).toBe("alpha");
    expect(plan[0].drifted).toBe(true);
    expect(plan[0].current).toContain("Type=simple"); // legacy on disk
    expect(plan[0].desired).toContain("Type=forking"); // tmux desired
  });

  it("reports NO drift when on-disk unit matches resolved config (steady state)", () => {
    const config = makeConfig({
      alpha: { soul: "test" } as unknown as AgentConfig,
    });
    // First pass: figure out what the desired tmux unit looks like.
    const desiredTmux = planAgentSystemdUnits(
      "alpha",
      config,
      "/agents",
      () => "",
    )[0].desired;

    // Second pass: feed that same content back as the on-disk content.
    // Drift detection should now report no change.
    const plan = planAgentSystemdUnits(
      "alpha",
      config,
      "/agents",
      () => desiredTmux,
    );

    expect(plan[0].drifted).toBe(false);
  });

  it("flips back to drift when legacy_pty toggles from true to unset", () => {
    // The original installAllUnits run wrote the legacy unit (operator had
    // experimental.legacy_pty:true at the time). Operator then removed the
    // flag from yaml — now we should detect that the disk is stale.
    const legacyConfig = makeConfig({
      alpha: {
        soul: "test",
        experimental: { legacy_pty: true },
      } as unknown as AgentConfig,
    });
    const tmuxConfig = makeConfig({
      alpha: { soul: "test" } as unknown as AgentConfig,
    });

    const legacyOnDisk = planAgentSystemdUnits(
      "alpha",
      legacyConfig,
      "/agents",
      () => "",
    )[0].desired;

    // Sanity: with legacy still in yaml, no drift against the legacy
    // on-disk unit.
    const stillLegacy = planAgentSystemdUnits(
      "alpha",
      legacyConfig,
      "/agents",
      () => legacyOnDisk,
    );
    expect(stillLegacy[0].drifted).toBe(false);

    // Now: yaml flipped to tmux, disk still has legacy. Must drift.
    const flipped = planAgentSystemdUnits(
      "alpha",
      tmuxConfig,
      "/agents",
      () => legacyOnDisk,
    );
    expect(flipped[0].drifted).toBe(true);
  });
});
