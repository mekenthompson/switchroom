/**
 * Test-discipline helpers (Phase 1c).
 *
 * The host that runs these tests also runs Coolify, hindsight, and a
 * collection of production app stacks. The HARD RULES in CLAUDE.md
 * require every test container to carry:
 *
 *   - `switchroom.test=phase1c`     (stable identifier across runs)
 *   - `switchroom.test.run=<uuid>`  (per-run identifier for forensic-
 *                                    grade scoping)
 *
 * Two helpers:
 *   - injectLabelsIntoCompose() — post-processes a generated compose
 *     YAML and injects a `labels:` block on every service so that
 *     `docker ps --filter label=switchroom.test=phase1c` covers the
 *     whole fleet (including evil-twin / evil-cross / agent-newbie).
 *   - safeLabelTeardown() — the ONLY sanctioned bulk-teardown shape.
 *     Filters by label, never touches non-phase1c containers.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Generate a fresh per-run id. Call once per test file in beforeAll. */
export function newRunId(): string {
  return randomUUID();
}

/**
 * Inject a `labels:` block under every top-level service entry in the
 * given compose YAML. Idempotent: services that already have a
 * `labels:` key are left alone (we don't try to merge — none of the
 * test composes set their own labels today).
 *
 * Detection: a service is any line matching /^  [a-z][a-z0-9-]*:$/m
 * inside the `services:` section. We rely on the fixed two-space
 * indentation the compose generator emits.
 */
export function injectLabelsIntoCompose(yml: string, runId: string): string {
  const labelsBlock = [
    `    labels:`,
    `      switchroom.test: "phase1c"`,
    `      switchroom.test.run: "${runId}"`,
    ``,
  ].join("\n");
  // Match: 2-space-indented service name (e.g. "  agent-alice:") at the
  // start of a line, followed by newline. Insert labels on the next
  // line. We anchor to two-space indent; the volumes:/networks: top-
  // level keys use no indent so they won't match.
  return yml.replace(
    /^( {2}[a-z][a-z0-9-]*:)\n(?! {4}labels:)/gm,
    (match, header) => `${header}\n${labelsBlock}`,
  );
}

/**
 * Build the canonical `--label` argv flags for a `docker run` call.
 * Returns a flat string suitable for splicing into a `docker run ...`
 * command line.
 */
export function dockerRunLabels(runId: string): string {
  return `--label switchroom.test=phase1c --label switchroom.test.run=${runId}`;
}

/**
 * Build the canonical label argv as an array, for spawnSync callers.
 */
export function dockerRunLabelsArgv(runId: string): string[] {
  return [
    "--label", "switchroom.test=phase1c",
    "--label", `switchroom.test.run=${runId}`,
  ];
}

/**
 * Sanctioned bulk teardown — filtered by label. Safe on any host
 * because it CANNOT match a container that wasn't created by this
 * test suite.
 *
 * Intended as a belt-and-braces fallback in afterAll(); the primary
 * teardown should still be the project-scoped `docker compose down`
 * or per-name `docker rm -f <name>`.
 */
export function safeLabelTeardown(runId?: string): void {
  const filter = runId
    ? `label=switchroom.test.run=${runId}`
    : `label=switchroom.test=phase1c`;
  try {
    const ids = execSync(`docker ps -aq --filter ${filter}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (ids.length === 0) return;
    // Single rm -f call with the explicit id list — this is the ONLY
    // sanctioned shape per CLAUDE.md.
    execSync(`docker rm -f ${ids.split(/\s+/).join(" ")}`, { stdio: "ignore" });
  } catch {
    /* best effort */
  }
}
