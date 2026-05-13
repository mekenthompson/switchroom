/**
 * `switchroom mcp hostd` — start the hostd stdio MCP server.
 *
 * Wired into agent .mcp.json by the scaffold (#1175 Phase 3 / PR δ)
 * so the agent's Claude session can call the host-control daemon's
 * fleet-management verbs (agent_restart / agent_start / agent_stop /
 * update_check / update_apply) as MCP tools — addressing the gap
 * where Phase 2 made these reachable from gateway slash-commands but
 * not from the agent's tool-using inner loop.
 */

import type { Command } from "commander";

export function registerHostdMcpCommand(program: Command): void {
  const mcp =
    program.commands.find((c) => c.name() === "mcp") ??
    program.command("mcp").description("MCP server entry points");
  mcp
    .command("hostd")
    .description(
      "Run the hostd stdio MCP server (5 tools: agent_restart, " +
        "agent_start, agent_stop, update_check, update_apply). " +
        "Dispatches to the host-control daemon over the per-agent " +
        "UDS at /run/switchroom/hostd/$SWITCHROOM_AGENT_NAME/sock.",
    )
    .action(async () => {
      const { runHostdMcpServer } = await import(
        "../mcp/hostd/server.js"
      );
      await runHostdMcpServer();
    });
}
