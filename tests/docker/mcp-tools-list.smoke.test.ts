/**
 * MCP tools/list smoke test — PR C Step 4.
 *
 * Boots a minimal agent container with `channels.telegram.enabled: false`
 * (no bot token required at boot — PR C step 1 wired this into the
 * start.sh template), opens an MCP `StdioClientTransport` over
 * `docker exec -i <ctr> switchroom mcp agent-config`, lists all tools,
 * and runs them through {@link validateAnthropicToolSchemas} so we
 * catch oneOf/anyOf regressions BEFORE the image promotes to `:dev`.
 *
 * Gating:
 *   - `RUN_DOCKER_SMOKE=1` in the environment turns the suite on. In
 *     normal CI / dev `npm test` runs it skips so unit-test cycles stay
 *     fast and don't require Docker.
 *
 * Fail-fast: the real MCP `connect()` is raced against a short timeout
 * so a genuinely broken transport surfaces in ~45s instead of hanging
 * until the 5-min test timeout. (A prior "spike" pre-flight pointed an
 * MCP client at `docker exec … cat`; `cat` echoes the client's own
 * `initialize` request back, the client receives a request — not a
 * response — and returns JSON-RPC -32601, so the spike failed 100% of
 * the time regardless of transport health and permanently blocked
 * promote-to-dev. It was removed; the real connect below is the
 * authoritative transport check.)
 *
 * Lifecycle:
 *   - The harness owns the container. Image tag taken from
 *     `SMOKE_AGENT_IMAGE` (default ghcr.io/switchroom/switchroom-agent:dev).
 *   - Container is created, started, polled-until-ready, listed, then
 *     torn down in a `finally` block — even on assertion failure.
 *   - Timeout: vitest default per-test (10s) extended to 5min via
 *     `testTimeout` below.
 */

import { describe, it, expect } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateAnthropicToolSchemas } from "./anthropic-tool-schema-validator.js";

const RUN = process.env.RUN_DOCKER_SMOKE === "1";
const SMOKE_IMAGE =
  process.env.SMOKE_AGENT_IMAGE ?? "ghcr.io/switchroom/switchroom-agent:dev";
const CONTAINER_NAME = `switchroom-smoke-${process.pid}`;
const CONNECT_TIMEOUT_MS = 45_000;

function dockerAvailable(): boolean {
  try {
    spawnSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN || !dockerAvailable())("mcp tools/list smoke test", () => {
  it(
    "all MCP tools pass Anthropic tool-schema constraints",
    { timeout: 5 * 60 * 1000 },
    async () => {
      let started = false;
      try {
        // 1. Start a throwaway container with telegram disabled.
        execSync(
          `docker run -d --rm --name ${CONTAINER_NAME} ` +
            `-e SWITCHROOM_RUNTIME=docker ` +
            `-e SWITCHROOM_AGENT_NAME=smoke ` +
            `-e TELEGRAM_ENABLED=false ` +
            `--entrypoint sleep ${SMOKE_IMAGE} 600`,
          { stdio: "pipe" },
        );
        started = true;

        // 2. Connect to the agent-config MCP server over docker exec.
        //    Race the connect against a short timeout so a broken
        //    transport fails fast with an actionable message instead
        //    of hanging until the 5-min test timeout.
        const transport = new StdioClientTransport({
          command: "docker",
          args: ["exec", "-i", CONTAINER_NAME, "switchroom", "mcp", "agent-config"],
        });
        const client = new Client(
          { name: "switchroom-smoke", version: "0.0.1" },
          { capabilities: {} },
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const connectTimeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `MCP connect did not complete within ${CONNECT_TIMEOUT_MS}ms — ` +
                    `stdio-over-docker-exec transport may be broken in this SDK ` +
                    `version; pin or patch before re-running smoke-test`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([client.connect(transport), connectTimeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }

        // 3. List tools and validate every schema.
        const result = await client.listTools();
        const issues = validateAnthropicToolSchemas(result.tools);
        await client.close();
        expect(issues, issues.join("\n")).toEqual([]);
      } finally {
        if (started) {
          try {
            execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
          } catch {
            // best-effort teardown
          }
        }
      }
    },
  );
});
