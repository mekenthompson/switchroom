/**
 * doctor-inlined-secrets — WS6-F3 (#1421). The whole switchroom.yaml
 * is bind-mounted read-only into every agent, so any secret-shaped
 * key carrying a literal (non-`vault:`) value is a cross-agent secret
 * read. These cases pin the detector's signal/no-noise contract.
 */

import { describe, expect, it } from "vitest";

import { runInlinedSecretChecks } from "./doctor-inlined-secrets.js";
import type { SwitchroomConfig } from "../config/schema.js";

const cfg = {} as unknown as SwitchroomConfig;

function run(yaml: string) {
  return runInlinedSecretChecks(cfg, {
    configPath: "/x/switchroom.yaml",
    readFileSync: () => yaml,
  });
}

describe("runInlinedSecretChecks", () => {
  it("returns [] when there is no config file to scan", () => {
    expect(runInlinedSecretChecks(cfg, {})).toEqual([]);
  });

  it("OK when every secret-shaped key is a vault: reference", () => {
    const r = run(
      [
        "telegram:",
        "  bot_token: vault:tg-bot",
        "google_accounts:",
        "  ws:",
        "    google_client_secret: vault:gws-secret",
      ].join("\n"),
    );
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("ok");
  });

  it("flags a top-level inlined bot_token and never echoes the value", () => {
    const secret = "123456:SUPER-SECRET-BOT-TOKEN";
    const r = run(`telegram:\n  bot_token: ${secret}\n`);
    const warn = r.find((c) => c.status === "warn");
    expect(warn).toBeDefined();
    expect(warn!.name).toContain("telegram.bot_token");
    // The secret value must NEVER appear in any field of the result.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(secret);
    expect(warn!.fix).toMatch(/switchroom vault set/);
  });

  it("flags a nested per-agent inlined secret with a dotted path", () => {
    const r = run(
      [
        "agents:",
        "  klanker:",
        "    bot_token: 999:INLINED",
        "  bob:",
        "    bot_token: vault:bob-tg",
      ].join("\n"),
    );
    const warns = r.filter((c) => c.status === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].name).toContain("agents.klanker.bot_token");
  });

  it("flags google_client_secret and *_token / *_secret suffixes", () => {
    const r = run(
      [
        "google_accounts:",
        "  ws:",
        "    google_client_secret: gcs-abc123",
        "custom:",
        "  refresh_token: rt-literal",
        "  webhook_secret: wh-literal",
      ].join("\n"),
    );
    const names = r.filter((c) => c.status === "warn").map((c) => c.name);
    expect(names.some((n) => n.includes("google_client_secret"))).toBe(true);
    expect(names.some((n) => n.includes("refresh_token"))).toBe(true);
    expect(names.some((n) => n.includes("webhook_secret"))).toBe(true);
  });

  it("does not nag on placeholders / empty values", () => {
    const r = run(
      [
        "telegram:",
        "  bot_token: <your-bot-token>",
        "a:",
        "  api_key: changeme",
        "b:",
        "  client_secret: ''",
      ].join("\n"),
    );
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("ok");
  });

  it("does not false-positive on benign non-secret keys", () => {
    const r = run(
      ["agents:", "  a:", "    topic_name: Health", "    model: opus"].join("\n"),
    );
    expect(r[0].status).toBe("ok");
  });

  it("warns (not throws) on unparseable YAML", () => {
    const r = run("this: : : not valid yaml: [");
    expect(r[0].status).toBe("warn");
  });
});
