import type { ClerkConfig } from "../config/schema.js";
import {
  generateHindsightMcpConfig,
  getCollectionForAgent,
  type McpServerConfig,
} from "./hindsight.js";

/**
 * Return the MCP server entry for Hindsight to merge into an agent's
 * settings.json during scaffolding.
 *
 * Returns null if the memory backend is not hindsight.
 */
export function getHindsightSettingsEntry(
  agentName: string,
  config: ClerkConfig,
): { key: string; value: McpServerConfig } | null {
  const memoryConfig = config.memory;
  if (!memoryConfig || memoryConfig.backend !== "hindsight") {
    return null;
  }

  const collection = getCollectionForAgent(agentName, config);
  const mcpConfig = generateHindsightMcpConfig(collection, memoryConfig);

  return { key: "hindsight", value: mcpConfig };
}
