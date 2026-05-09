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
 * Inject test-discipline labels under every top-level service entry in
 * the given compose YAML. Merges with any existing `labels:` block the
 * compose generator already emitted (the production generator now adds
 * its own `switchroom.role` / `switchroom.fleet` labels per service —
 * appending a second `labels:` key would produce a YAML duplicate-key
 * error).
 *
 * Detection: a service is any line matching /^  [a-z][a-z0-9-]*:$/m
 * inside the `services:` section. We rely on the fixed two-space
 * indentation the compose generator emits. If the service already has
 * a `labels:` key (4-space-indented immediately after, possibly with
 * intervening lines before any other 4-space key), we append our two
 * label lines to that block. Otherwise we insert a new `labels:` block
 * on the next line.
 */
export function injectLabelsIntoCompose(yml: string, runId: string): string {
  const testLabels = [
    `      switchroom.test: "phase1c"`,
    `      switchroom.test.run: "${runId}"`,
  ].join("\n");
  const newLabelsBlock = [
    `    labels:`,
    testLabels,
    ``,
  ].join("\n");

  const lines = yml.split("\n");
  const out: string[] = [];
  // Walk service-by-service. A service header is /^  [a-z][a-z0-9-]*:$/.
  // After emitting it, we look ahead to find the matching `    labels:`
  // line BEFORE any line that's outdented to top level (no leading
  // spaces) or another 2-space-indented service header.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (!/^ {2}[a-z][a-z0-9-]*:$/.test(line)) continue;

    // Look ahead within this service's block for an existing labels: key.
    let j = i + 1;
    let labelsLineIdx = -1;
    while (j < lines.length) {
      const peek = lines[j];
      // End of service: another service header, or a top-level key
      // (no leading whitespace, non-empty).
      if (/^ {2}[a-z][a-z0-9-]*:$/.test(peek)) break;
      if (/^[a-z]/.test(peek)) break;
      if (/^ {4}labels:\s*$/.test(peek)) {
        labelsLineIdx = j;
        break;
      }
      j++;
    }

    if (labelsLineIdx === -1) {
      // No existing labels: emit a fresh block on the next line.
      out.push(newLabelsBlock.replace(/\n$/, ""));
    } else {
      // Existing labels: copy through up to and including that line,
      // then append our test labels — but only if they aren't already
      // present (idempotent — some tests call this helper twice on the
      // same YAML after re-rewriting).
      for (let k = i + 1; k <= labelsLineIdx; k++) out.push(lines[k]);
      let alreadyHasTestLabel = false;
      for (let k = labelsLineIdx + 1; k < lines.length; k++) {
        const peek = lines[k];
        if (/^ {2}[a-z][a-z0-9-]*:$/.test(peek)) break;
        if (/^[a-z]/.test(peek)) break;
        if (/^ {6}switchroom\.test:/.test(peek)) { alreadyHasTestLabel = true; break; }
      }
      if (!alreadyHasTestLabel) out.push(testLabels);
      i = labelsLineIdx;
    }
  }

  return out.join("\n");
}

/**
 * Merge additional environment entries into a service's existing
 * `environment:` block (if any). If the service has no `environment:`
 * key, a new one is inserted on the line after the service header.
 *
 * `entries` must already be 6-space indented (e.g. `      KEY: value`).
 *
 * Necessary because the production compose generator now emits its own
 * `environment:` block for vault-broker / approval-kernel / scheduler;
 * the older test fixtures inserted a duplicate key, causing compose to
 * reject the YAML.
 */
export function mergeServiceEnv(
  yml: string,
  serviceName: string,
  entries: string[],
): string {
  const lines = yml.split("\n");
  const headerRe = new RegExp(`^ {2}${serviceName}:$`);
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return yml;

  // Find existing environment: line within this service block.
  let envIdx = -1;
  for (let j = headerIdx + 1; j < lines.length; j++) {
    const peek = lines[j];
    if (/^ {2}[a-z][a-z0-9-]*:$/.test(peek)) break;
    if (/^[a-z]/.test(peek)) break;
    if (/^ {4}environment:\s*$/.test(peek)) { envIdx = j; break; }
  }

  if (envIdx === -1) {
    // Insert a new environment: block right after the header.
    const block = ["    environment:", ...entries];
    lines.splice(headerIdx + 1, 0, ...block);
  } else {
    lines.splice(envIdx + 1, 0, ...entries);
  }
  return lines.join("\n");
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
