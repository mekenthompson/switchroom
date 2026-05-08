/**
 * Phase 3a-1: Entry-guard bundler sweep.
 *
 * When bun's bundler inlines a module that has an
 * `if (import.meta.url === \`file://${process.argv[1]}\`)` entry guard
 * INTO another bundle (e.g. dist/cli/switchroom.js), `import.meta.url`
 * is rewritten to point at the OUTPUT bundle. The naive guard then
 * compares `file://<output-path>` to argv[1] (the same output path) and
 * matches — causing the inlined module's main() to fire for any CLI
 * invocation. This regressed CI in the Phase 1c kernel work and was
 * fixed in fork PR #26 for the broker; the squash to main reverted it.
 *
 * This test guards against re-regression by:
 *   1. Asserting the entry-guard regex for each affected module accepts
 *      its OWN bundle / source path.
 *   2. Asserting the regex REJECTS dist/cli/switchroom.js (the merged
 *      CLI entry point) so a guard cannot fire when bundled inside it.
 *   3. Smoke-testing that running `bun dist/cli/switchroom.js --help`
 *      exits cleanly and does NOT emit any of the modules' fatal
 *      stderr banners (e.g. "vault-broker fatal", "approval-kernel
 *      fatal", "scheduler fatal").
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Mirror the regexes embedded in each module's entry guard. If you
// change a guard regex in src/, mirror the change here — divergence is
// the bug we're guarding against.
const guards: Record<string, RegExp> = {
  broker: /(?:^|[/\\])(?:vault[/\\]broker[/\\])?server\.(?:js|ts)$/,
  "approval-kernel":
    /(?:^|[/\\])(?:vault[/\\]approvals[/\\])?kernel-server\.(?:js|ts)$/,
  scheduler: /(?:^|[/\\])scheduler[/\\]index\.(?:js|ts)$/,
};

describe("entry-guard regexes — per-module (Phase 3a-1)", () => {
  it("broker regex accepts its own bundle/source paths", () => {
    expect(guards.broker.test("/opt/sr/dist/vault/broker/server.js")).toBe(
      true,
    );
    expect(guards.broker.test("src/vault/broker/server.ts")).toBe(true);
    expect(guards.broker.test("server.js")).toBe(true);
  });

  it("broker regex rejects the merged CLI bundle", () => {
    expect(guards.broker.test("/opt/sr/dist/cli/switchroom.js")).toBe(false);
    expect(guards.broker.test("dist/cli/switchroom.js")).toBe(false);
  });

  it("approval-kernel regex accepts its own bundle/source paths", () => {
    expect(
      guards["approval-kernel"].test(
        "/opt/sr/dist/vault/approvals/kernel-server.js",
      ),
    ).toBe(true);
    expect(
      guards["approval-kernel"].test(
        "src/vault/approvals/kernel-server.ts",
      ),
    ).toBe(true);
    expect(guards["approval-kernel"].test("kernel-server.js")).toBe(true);
  });

  it("approval-kernel regex rejects the merged CLI bundle and broker bundle", () => {
    expect(
      guards["approval-kernel"].test("/opt/sr/dist/cli/switchroom.js"),
    ).toBe(false);
    expect(
      guards["approval-kernel"].test("/opt/sr/dist/vault/broker/server.js"),
    ).toBe(false);
  });

  it("scheduler regex accepts its own bundle/source paths", () => {
    expect(guards.scheduler.test("/opt/sr/dist/scheduler/index.js")).toBe(
      true,
    );
    expect(guards.scheduler.test("src/scheduler/index.ts")).toBe(true);
  });

  it("scheduler regex rejects the merged CLI bundle and a generic index.js", () => {
    expect(guards.scheduler.test("/opt/sr/dist/cli/switchroom.js")).toBe(
      false,
    );
    expect(guards.scheduler.test("/opt/sr/dist/foo/index.js")).toBe(false);
  });
});

describe("dist/cli/switchroom.js — no inlined-guard misfires (Phase 3a-1)", () => {
  const cli = resolve(
    __dirname,
    "..",
    "dist",
    "cli",
    "switchroom.js",
  );

  it("running --help does not boot broker / kernel / scheduler", () => {
    // Phase 3a-2 (was: it.skipIf(!existsSync(cli))). Silently skipping
    // when dist/cli/switchroom.js was missing meant a fresh checkout
    // could pass this suite without the smoke ever running. Now we
    // assert the dist exists so the suite fails loud — run
    // `npm run build` first (or wire it into CI as a pretest).
    expect(
      existsSync(cli),
      `dist CLI missing at ${cli} — run \`npm run build\` before this test.`,
    ).toBe(true);
    const res = spawnSync("bun", [cli, "--help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/tmp/empty-fakehome" },
      timeout: 30_000,
    });
    const blob = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    expect(res.status).toBe(0);
    expect(blob).not.toMatch(/vault-broker fatal/);
    expect(blob).not.toMatch(/approval-kernel fatal/);
    expect(blob).not.toMatch(/scheduler fatal/);
    // None of these modules should print their boot banners either.
    expect(blob).not.toMatch(/vault-broker: listening on/);
    expect(blob).not.toMatch(/scheduler: registered/);
  });
});
