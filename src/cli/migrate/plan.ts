/**
 * Migration plan builder + pretty-printer.
 *
 * Pure: `buildPlan(verb, state)` returns a typed list of steps that
 * `migrate to-docker` / `migrate to-host` would execute. No side-effects.
 *
 * `--dry-run` in 3b-2a renders the plan; 3b-2b/c will execute it.
 */

export type MigrateVerb = "to-docker" | "to-host";

export type PlanStep =
  | { kind: "systemd-stop"; unit: string }
  | { kind: "systemd-disable"; unit: string }
  | { kind: "systemd-enable"; unit: string }
  | { kind: "systemd-start"; unit: string }
  | { kind: "compose-generate"; path: string; project: string }
  | { kind: "compose-up"; project: string; path: string }
  | { kind: "compose-down"; project: string; path: string }
  | { kind: "watchdog-pause" }
  | { kind: "watchdog-resume" }
  | { kind: "marker-write"; mode: "host" | "docker" }
  | { kind: "vault-broker-handshake"; agent: string }
  | { kind: "uid-align"; agent: string; targetUid: number };

export interface PlanState {
  /** Agents in the fleet that will be migrated. */
  agents: string[];
  /** Compose project name (typically `switchroom-fleet`). */
  composeProject: string;
  /** Path to the compose file that would be generated. */
  composePath: string;
  /** Target UID for chown alignment in to-docker (informational only here). */
  targetUid?: number;
}

export interface MigrationPlan {
  verb: MigrateVerb;
  steps: Array<PlanStep & { rollback?: string }>;
  warnings: string[];
}

/* ------------------------------------------------------------------ */

export function buildPlan(verb: MigrateVerb, state: PlanState): MigrationPlan {
  const steps: Array<PlanStep & { rollback?: string }> = [];
  const warnings: string[] = [];

  if (state.agents.length === 0) {
    warnings.push("No agents found in the fleet — plan will be a no-op.");
  }

  if (verb === "to-docker") {
    steps.push({ kind: "watchdog-pause", rollback: "watchdog-resume" });
    for (const a of state.agents) {
      const unit = `switchroom-${a}.service`;
      steps.push({
        kind: "systemd-stop",
        unit,
        rollback: `systemctl --user start ${unit}`,
      });
      steps.push({
        kind: "systemd-disable",
        unit,
        rollback: `systemctl --user enable ${unit}`,
      });
    }
    if (typeof state.targetUid === "number") {
      for (const a of state.agents) {
        steps.push({
          kind: "uid-align",
          agent: a,
          targetUid: state.targetUid,
          rollback: "chown back to host UID (recorded in migration.log)",
        });
      }
    }
    steps.push({
      kind: "compose-generate",
      path: state.composePath,
      project: state.composeProject,
      rollback: `rm ${state.composePath}`,
    });
    steps.push({
      kind: "compose-up",
      project: state.composeProject,
      path: state.composePath,
      rollback: `docker compose -p ${state.composeProject} -f ${state.composePath} down`,
    });
    for (const a of state.agents) {
      steps.push({
        kind: "vault-broker-handshake",
        agent: a,
        rollback: "no rollback — handshake is idempotent",
      });
    }
    steps.push({ kind: "marker-write", mode: "docker", rollback: "marker-write host" });
    steps.push({ kind: "watchdog-resume" });
  } else {
    // to-host
    steps.push({ kind: "watchdog-pause", rollback: "watchdog-resume" });
    steps.push({
      kind: "compose-down",
      project: state.composeProject,
      path: state.composePath,
      rollback: `docker compose -p ${state.composeProject} -f ${state.composePath} up -d`,
    });
    for (const a of state.agents) {
      const unit = `switchroom-${a}.service`;
      steps.push({
        kind: "systemd-enable",
        unit,
        rollback: `systemctl --user disable ${unit}`,
      });
      steps.push({
        kind: "systemd-start",
        unit,
        rollback: `systemctl --user stop ${unit}`,
      });
    }
    steps.push({ kind: "marker-write", mode: "host", rollback: "marker-write docker" });
    steps.push({ kind: "watchdog-resume" });
  }

  return { verb, steps, warnings };
}

/* ------------------------------------------------------------------ */
/* Pretty-printer                                                      */
/* ------------------------------------------------------------------ */

export function describeStep(step: PlanStep): string {
  switch (step.kind) {
    case "systemd-stop":
      return `Stop systemd unit ${step.unit}`;
    case "systemd-disable":
      return `Disable systemd unit ${step.unit}`;
    case "systemd-enable":
      return `Enable systemd unit ${step.unit}`;
    case "systemd-start":
      return `Start systemd unit ${step.unit}`;
    case "compose-generate":
      return `Generate compose file at ${step.path} (project: ${step.project})`;
    case "compose-up":
      return `docker compose -p ${step.project} -f ${step.path} up -d`;
    case "compose-down":
      return `docker compose -p ${step.project} -f ${step.path} down`;
    case "watchdog-pause":
      return "Pause fleet watchdog";
    case "watchdog-resume":
      return "Resume fleet watchdog";
    case "marker-write":
      return `Write ~/.switchroom/runtime-mode = ${step.mode}`;
    case "vault-broker-handshake":
      return `Re-handshake vault-broker token for agent ${step.agent}`;
    case "uid-align":
      return `chown agent ${step.agent} workspace to UID ${step.targetUid}`;
  }
}

export function formatPlanText(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(`Migration plan: ${plan.verb}`);
  lines.push(`Steps: ${plan.steps.length}`);
  lines.push("");
  plan.steps.forEach((step, i) => {
    const num = String(i + 1).padStart(2, " ");
    lines.push(`  ${num}. ${describeStep(step)}`);
    if (step.rollback) {
      lines.push(`        rollback: ${step.rollback}`);
    }
  });
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  lines.push("");
  lines.push("(dry-run — no side-effects performed)");
  return lines.join("\n");
}

export function formatPlanJsonl(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ kind: "header", verb: plan.verb, stepCount: plan.steps.length }));
  plan.steps.forEach((step, i) => {
    lines.push(JSON.stringify({ index: i + 1, ...step }));
  });
  for (const w of plan.warnings) {
    lines.push(JSON.stringify({ kind: "warning", message: w }));
  }
  return lines.join("\n") + "\n";
}
