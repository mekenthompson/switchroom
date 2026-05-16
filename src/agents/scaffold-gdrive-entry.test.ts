/**
 * Scaffold-emission gate for the per-agent `gdrive` MCP entry (RFC G).
 *
 * `resolveGdriveMcpEntry` is the pure decision both the `scaffoldAgent`
 * and `reconcileAgent` mcpServers-assembly paths call. These cases pin
 * the brief's contract:
 *
 *   - an agent WITH the config (account set + in enabled_for[]) emits
 *     the gdrive entry pointed at the in-container launcher;
 *   - WITHOUT it (no account / not in enabled_for[] / hard opt-out) it
 *     does NOT emit.
 *
 * The broker-ACL agreement (scaffold gate ⇔ broker selection) is pinned
 * separately in scaffold-integration.test.ts via the shared
 * `shouldEmitGdriveMcp` predicate; this file exercises the scaffold-side
 * wrapper that also folds in the opt-out + tier resolution.
 */

import { describe, expect, it } from "vitest";

import {
  DOCKER_SWITCHROOM_CLI_PATH,
  resolveGdriveMcpEntry,
} from "./scaffold.js";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";

function cfg(
  google_accounts: SwitchroomConfig["google_accounts"],
  google_workspace?: SwitchroomConfig["google_workspace"],
): SwitchroomConfig {
  return { google_accounts, google_workspace } as unknown as SwitchroomConfig;
}

function agent(partial: Partial<AgentConfig>): AgentConfig {
  return partial as unknown as AgentConfig;
}

const ENABLED = cfg({
  "pixsoul@gmail.com": { enabled_for: ["clerk", "carrie"] },
});

describe("resolveGdriveMcpEntry — emits when broker-authorized", () => {
  it("emits the launcher entry when account set AND agent in enabled_for[]", () => {
    const entry = resolveGdriveMcpEntry(
      "carrie",
      agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
      ENABLED,
    );
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe("gdrive");
    expect(entry?.value.command).toBe(DOCKER_SWITCHROOM_CLI_PATH);
    expect(entry?.value.args?.[0]).toBe("drive-mcp-launcher");
  });

  it("threads the per-agent tier override through to the launcher", () => {
    const entry = resolveGdriveMcpEntry(
      "carrie",
      agent({
        google_workspace: { account: "pixsoul@gmail.com", tier: "core" },
      }),
      cfg(
        { "pixsoul@gmail.com": { enabled_for: ["carrie"] } },
        { tier: "extended" } as SwitchroomConfig["google_workspace"],
      ),
    );
    const args = entry?.value.args ?? [];
    const i = args.indexOf("--tier");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("core"); // per-agent wins over top-level
  });

  it("falls back to the top-level tier when the agent has none", () => {
    const entry = resolveGdriveMcpEntry(
      "carrie",
      agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
      cfg(
        { "pixsoul@gmail.com": { enabled_for: ["carrie"] } },
        { tier: "extended" } as SwitchroomConfig["google_workspace"],
      ),
    );
    const args = entry?.value.args ?? [];
    expect(args[args.indexOf("--tier") + 1]).toBe("extended");
  });

  // Bug A regression: Claude Code spawns MCP servers with a sanitized
  // env, so the launcher gets none of the compose container env unless
  // the entry carries it explicitly. All six keys must mirror
  // src/agents/compose.ts emitAgentService env exactly.
  it("emits the full sanitized-env block with agentName threaded", () => {
    const entry = resolveGdriveMcpEntry(
      "carrie",
      agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
      ENABLED,
    );
    expect(entry?.value.env).toEqual({
      SWITCHROOM_CONFIG: "/state/config/switchroom.yaml",
      SWITCHROOM_AGENT_NAME: "carrie",
      SWITCHROOM_CONTAINER: "1",
      SWITCHROOM_AUTH_BROKER_SOCKET: "/run/switchroom/auth-broker/sock",
      SWITCHROOM_VAULT_BROKER_SOCK: "/run/switchroom/broker/sock",
      HOME: "/state/agent/home",
    });
  });

  it("threads a different agent name through SWITCHROOM_AGENT_NAME", () => {
    const entry = resolveGdriveMcpEntry(
      "clerk",
      agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
      ENABLED,
    );
    expect(entry?.value.env?.SWITCHROOM_AGENT_NAME).toBe("clerk");
    // tier arg still preserved alongside the env block
    expect(entry?.value.args).toEqual(["drive-mcp-launcher"]);
  });
});

describe("resolveGdriveMcpEntry — does NOT emit", () => {
  it("returns null when the agent has no google_workspace.account", () => {
    expect(
      resolveGdriveMcpEntry("carrie", agent({}), ENABLED),
    ).toBeNull();
  });

  it("returns null when the agent is not in the account's enabled_for[]", () => {
    expect(
      resolveGdriveMcpEntry(
        "gymbro",
        agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
        ENABLED,
      ),
    ).toBeNull();
  });

  it("returns null when the referenced account isn't in google_accounts", () => {
    expect(
      resolveGdriveMcpEntry(
        "carrie",
        agent({ google_workspace: { account: "missing@gmail.com" } }),
        ENABLED,
      ),
    ).toBeNull();
  });

  it("returns null on the hard opt-out mcp_servers: { gdrive: false }", () => {
    expect(
      resolveGdriveMcpEntry(
        "carrie",
        agent({
          google_workspace: { account: "pixsoul@gmail.com" },
          mcp_servers: { gdrive: false },
        }),
        ENABLED,
      ),
    ).toBeNull();
  });

  it("returns null when google_accounts is entirely absent", () => {
    expect(
      resolveGdriveMcpEntry(
        "carrie",
        agent({ google_workspace: { account: "pixsoul@gmail.com" } }),
        cfg(undefined),
      ),
    ).toBeNull();
  });
});
