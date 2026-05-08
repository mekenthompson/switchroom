import { describe, expect, it } from "vitest";
import { buildPlan, formatPlanJsonl, formatPlanText, type PlanState } from "./plan.js";

const baseState: PlanState = {
  agents: ["klanker", "finn"],
  composeProject: "switchroom-fleet",
  composePath: "/home/u/.switchroom/compose/docker-compose.yml",
  targetUid: 1000,
};

describe("buildPlan to-docker", () => {
  it("emits expected step kinds in order", () => {
    const plan = buildPlan("to-docker", baseState);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("watchdog-pause");
    expect(kinds).toContain("systemd-stop");
    expect(kinds).toContain("systemd-disable");
    expect(kinds).toContain("uid-align");
    expect(kinds).toContain("compose-generate");
    expect(kinds).toContain("compose-up");
    expect(kinds).toContain("vault-broker-handshake");
    expect(kinds).toContain("marker-write");
    expect(kinds[kinds.length - 1]).toBe("watchdog-resume");
  });

  it("includes one systemd-stop+disable per agent", () => {
    const plan = buildPlan("to-docker", baseState);
    const stops = plan.steps.filter((s) => s.kind === "systemd-stop");
    const disables = plan.steps.filter((s) => s.kind === "systemd-disable");
    expect(stops).toHaveLength(2);
    expect(disables).toHaveLength(2);
  });

  it("skips uid-align when targetUid is undefined", () => {
    const plan = buildPlan("to-docker", { ...baseState, targetUid: undefined });
    expect(plan.steps.filter((s) => s.kind === "uid-align")).toHaveLength(0);
  });

  it("marker step writes mode=docker", () => {
    const plan = buildPlan("to-docker", baseState);
    const marker = plan.steps.find((s) => s.kind === "marker-write");
    expect(marker).toBeDefined();
    if (marker?.kind === "marker-write") expect(marker.mode).toBe("docker");
  });
});

describe("buildPlan to-host", () => {
  it("emits expected step kinds in reverse direction", () => {
    const plan = buildPlan("to-host", baseState);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe("watchdog-pause");
    expect(kinds).toContain("compose-down");
    expect(kinds).toContain("systemd-enable");
    expect(kinds).toContain("systemd-start");
    expect(kinds).toContain("marker-write");
    expect(kinds[kinds.length - 1]).toBe("watchdog-resume");
    // Should NOT include compose-generate or uid-align
    expect(kinds).not.toContain("compose-generate");
    expect(kinds).not.toContain("uid-align");
  });

  it("marker step writes mode=host", () => {
    const plan = buildPlan("to-host", baseState);
    const marker = plan.steps.find((s) => s.kind === "marker-write");
    expect(marker).toBeDefined();
    if (marker?.kind === "marker-write") expect(marker.mode).toBe("host");
  });
});

describe("buildPlan warnings", () => {
  it("warns when fleet is empty", () => {
    const plan = buildPlan("to-docker", { ...baseState, agents: [] });
    expect(plan.warnings.some((w) => /no agents/i.test(w))).toBe(true);
  });
});

describe("formatPlanText snapshot", () => {
  it("renders a stable to-docker plan", () => {
    const plan = buildPlan("to-docker", baseState);
    expect(formatPlanText(plan)).toMatchInlineSnapshot(`
      "Migration plan: to-docker
      Steps: 13

         1. Pause fleet watchdog
              rollback: watchdog-resume
         2. Stop systemd unit switchroom-klanker.service
              rollback: systemctl --user start switchroom-klanker.service
         3. Disable systemd unit switchroom-klanker.service
              rollback: systemctl --user enable switchroom-klanker.service
         4. Stop systemd unit switchroom-finn.service
              rollback: systemctl --user start switchroom-finn.service
         5. Disable systemd unit switchroom-finn.service
              rollback: systemctl --user enable switchroom-finn.service
         6. chown agent klanker workspace to UID 1000
              rollback: chown back to host UID (recorded in migration.log)
         7. chown agent finn workspace to UID 1000
              rollback: chown back to host UID (recorded in migration.log)
         8. Generate compose file at /home/u/.switchroom/compose/docker-compose.yml (project: switchroom-fleet)
              rollback: rm /home/u/.switchroom/compose/docker-compose.yml
         9. docker compose -p switchroom-fleet -f /home/u/.switchroom/compose/docker-compose.yml up -d
              rollback: docker compose -p switchroom-fleet -f /home/u/.switchroom/compose/docker-compose.yml down
        10. Re-handshake vault-broker token for agent klanker
              rollback: no rollback — handshake is idempotent
        11. Re-handshake vault-broker token for agent finn
              rollback: no rollback — handshake is idempotent
        12. Write ~/.switchroom/runtime-mode = docker
              rollback: marker-write host
        13. Resume fleet watchdog

      (dry-run — no side-effects performed)"
    `);
  });

  it("renders a stable to-host plan", () => {
    const plan = buildPlan("to-host", baseState);
    expect(formatPlanText(plan)).toMatchInlineSnapshot(`
      "Migration plan: to-host
      Steps: 8

         1. Pause fleet watchdog
              rollback: watchdog-resume
         2. docker compose -p switchroom-fleet -f /home/u/.switchroom/compose/docker-compose.yml down
              rollback: docker compose -p switchroom-fleet -f /home/u/.switchroom/compose/docker-compose.yml up -d
         3. Enable systemd unit switchroom-klanker.service
              rollback: systemctl --user disable switchroom-klanker.service
         4. Start systemd unit switchroom-klanker.service
              rollback: systemctl --user stop switchroom-klanker.service
         5. Enable systemd unit switchroom-finn.service
              rollback: systemctl --user disable switchroom-finn.service
         6. Start systemd unit switchroom-finn.service
              rollback: systemctl --user stop switchroom-finn.service
         7. Write ~/.switchroom/runtime-mode = host
              rollback: marker-write docker
         8. Resume fleet watchdog

      (dry-run — no side-effects performed)"
    `);
  });
});

describe("formatPlanJsonl", () => {
  it("emits one JSON object per line, ending with newline", () => {
    const plan = buildPlan("to-host", { ...baseState, agents: ["a"] });
    const out = formatPlanJsonl(plan);
    expect(out.endsWith("\n")).toBe(true);
    const lines = out.trim().split("\n");
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    const first = JSON.parse(lines[0]);
    expect(first.kind).toBe("header");
    expect(first.verb).toBe("to-host");
  });
});
