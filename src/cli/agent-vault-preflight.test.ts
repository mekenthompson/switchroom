import { afterEach, describe, expect, it } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import type { BrokerStatus } from "../vault/broker/protocol.js";
import {
  checkVaultPreflight,
  checkVaultPreflightBulk,
  effectiveBotToken,
  formatLockedRefusal,
  formatLockedRefusalBulk,
  resolvePreflightSocket,
} from "./agent-vault-preflight.js";

function mkConfig(opts: {
  globalToken?: string;
  agents: Record<string, { bot_token?: string }>;
}): SwitchroomConfig {
  return {
    telegram: {
      bot_token: opts.globalToken ?? "global-plain-token",
      forum_chat_id: "-100123",
    },
    agents: opts.agents as SwitchroomConfig["agents"],
  } as unknown as SwitchroomConfig;
}

const unlocked = (): Promise<BrokerStatus | null> =>
  Promise.resolve({ unlocked: true, keyCount: 1, uptimeSec: 1 });
const locked = (): Promise<BrokerStatus | null> =>
  Promise.resolve({ unlocked: false, keyCount: 0, uptimeSec: 1 });
const unreachable = (): Promise<BrokerStatus | null> => Promise.resolve(null);

describe("effectiveBotToken", () => {
  it("uses per-agent bot_token when set", () => {
    const c = mkConfig({
      globalToken: "GLOBAL",
      agents: { foo: { bot_token: "PER_AGENT" } },
    });
    expect(effectiveBotToken(c, "foo")).toBe("PER_AGENT");
  });

  it("falls back to global telegram.bot_token", () => {
    const c = mkConfig({ globalToken: "GLOBAL", agents: { foo: {} } });
    expect(effectiveBotToken(c, "foo")).toBe("GLOBAL");
  });
});

describe("checkVaultPreflight", () => {
  it("plaintext bot_token + vault locked → skip (no check)", async () => {
    const c = mkConfig({
      globalToken: "1234:plaintext",
      agents: { foo: {} },
    });
    const v = await checkVaultPreflight(c, "foo", { status: locked });
    expect(v).toEqual({ kind: "skip", reason: "plaintext-token" });
  });

  it("vault: bot_token + vault unlocked → ok", async () => {
    const c = mkConfig({ agents: { foo: { bot_token: "vault:foo.bot_token" } } });
    const v = await checkVaultPreflight(c, "foo", { status: unlocked });
    expect(v).toEqual({ kind: "ok" });
  });

  it("vault: bot_token + vault locked → locked (reachable)", async () => {
    const c = mkConfig({ agents: { foo: { bot_token: "vault:foo.bot_token" } } });
    const v = await checkVaultPreflight(c, "foo", { status: locked });
    expect(v).toEqual({ kind: "locked", reachable: true });
  });

  it("vault: bot_token + broker unreachable → locked (unreachable)", async () => {
    const c = mkConfig({ agents: { foo: { bot_token: "vault:foo.bot_token" } } });
    const v = await checkVaultPreflight(c, "foo", { status: unreachable });
    expect(v).toEqual({ kind: "locked", reachable: false });
  });

  it("global vault: token, no per-agent override → still gates", async () => {
    const c = mkConfig({
      globalToken: "vault:telegram-bot-token",
      agents: { foo: {} },
    });
    const v = await checkVaultPreflight(c, "foo", { status: locked });
    expect(v).toEqual({ kind: "locked", reachable: true });
  });
});

describe("checkVaultPreflightBulk", () => {
  it("returns blocked=[] when no agent has a vault: token (no broker call)", async () => {
    const c = mkConfig({
      globalToken: "PLAIN",
      agents: { foo: {}, bar: { bot_token: "PLAIN_PER" } },
    });
    let called = 0;
    const r = await checkVaultPreflightBulk(c, ["foo", "bar"], {
      status: () => {
        called++;
        return locked();
      },
    });
    expect(r.blocked).toEqual([]);
    expect(called).toBe(0);
  });

  it("flags ALL vault-ref agents when vault is locked", async () => {
    const c = mkConfig({
      globalToken: "vault:tg",
      agents: { foo: {}, bar: { bot_token: "PLAIN" }, baz: { bot_token: "vault:baz.tok" } },
    });
    const r = await checkVaultPreflightBulk(c, ["foo", "bar", "baz"], { status: locked });
    expect(r.blocked.map((b) => b.agent).sort()).toEqual(["baz", "foo"]);
    expect(r.reachable).toBe(true);
  });

  it("treats unreachable broker as locked", async () => {
    const c = mkConfig({ agents: { foo: { bot_token: "vault:foo.tok" } } });
    const r = await checkVaultPreflightBulk(c, ["foo"], { status: unreachable });
    expect(r.blocked).toHaveLength(1);
    expect(r.reachable).toBe(false);
  });

  it("returns blocked=[] when broker reachable + unlocked", async () => {
    const c = mkConfig({ agents: { foo: { bot_token: "vault:foo.tok" } } });
    const r = await checkVaultPreflightBulk(c, ["foo"], { status: unlocked });
    expect(r.blocked).toEqual([]);
    expect(r.reachable).toBe(true);
  });
});

describe("formatLockedRefusal", () => {
  it("includes unlock + retry + force-locked guidance (reachable)", () => {
    const m = formatLockedRefusal("klanker", { kind: "locked", reachable: true });
    expect(m).toContain("vault is locked");
    expect(m).toContain("switchroom vault broker unlock");
    expect(m).toContain("switchroom agent restart klanker");
    expect(m).toContain("--force-locked");
  });

  it("differentiates unreachable wording", () => {
    const m = formatLockedRefusal("klanker", { kind: "locked", reachable: false });
    expect(m).toContain("unreachable");
  });
});

describe("formatLockedRefusalBulk", () => {
  it("lists every blocked agent", () => {
    const m = formatLockedRefusalBulk(
      [{ agent: "foo" }, { agent: "bar" }],
      true,
    );
    expect(m).toContain("foo");
    expect(m).toContain("bar");
    expect(m).toContain("--force-locked");
  });
});

describe("resolvePreflightSocket — env > config > default (#1062 Bug 4)", () => {
  const prev = process.env.SWITCHROOM_VAULT_BROKER_SOCK;
  afterEach(() => {
    if (prev === undefined) delete process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    else process.env.SWITCHROOM_VAULT_BROKER_SOCK = prev;
  });

  function withSocket(socket?: string): SwitchroomConfig {
    const base = mkConfig({ agents: { foo: { bot_token: "vault:foo" } } });
    if (socket === undefined) return base;
    return {
      ...base,
      vault: {
        path: "~/.switchroom/vault.enc",
        broker: { enabled: true, socket },
      },
    } as SwitchroomConfig;
  }

  it("env var wins over explicit config value", () => {
    process.env.SWITCHROOM_VAULT_BROKER_SOCK = "/tmp/from-env.sock";
    const got = resolvePreflightSocket(withSocket("/tmp/from-config.sock"));
    expect(got).toBe("/tmp/from-env.sock");
  });

  it("explicit config value used when env unset", () => {
    delete process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    const got = resolvePreflightSocket(withSocket("/tmp/from-config.sock"));
    expect(got).toBe("/tmp/from-config.sock");
  });

  it("Zod schema default in config does NOT count as explicit (returns undefined → fall through)", () => {
    // This is the load-bearing case. Before the fix, the schema's
    // default of "~/.switchroom/vault-broker.sock" appeared identical
    // to an operator override, masking the env var and routing the
    // preflight at a legacy socket nobody was listening on. Returning
    // undefined here lets statusViaBroker pick the runtime default
    // (operator socket under docker).
    delete process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    const got = resolvePreflightSocket(
      withSocket("~/.switchroom/vault-broker.sock"),
    );
    expect(got).toBeUndefined();
  });

  it("config without vault.broker.socket field → undefined", () => {
    delete process.env.SWITCHROOM_VAULT_BROKER_SOCK;
    const got = resolvePreflightSocket(withSocket(undefined));
    expect(got).toBeUndefined();
  });
});
