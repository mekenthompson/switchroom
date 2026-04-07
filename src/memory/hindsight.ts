import type { ClerkConfig, MemoryBackendConfig } from "../config/schema.js";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/**
 * Generate the MCP server config entry for Hindsight.
 *
 * Hindsight exposes MCP via Streamable HTTP at http://localhost:8888/mcp.
 * This works with Claude Code's HTTP MCP transport and is simpler than docker exec.
 */
export function generateHindsightMcpConfig(
  _collection: string,
  _memoryConfig: MemoryBackendConfig,
): McpServerConfig {
  return {
    url: "http://localhost:8888/mcp",
  };
}

/**
 * Generate a docker-compose YAML snippet for the Hindsight service.
 */
export function generateDockerComposeSnippet(
  memoryConfig: MemoryBackendConfig,
): string {
  const provider = memoryConfig.config?.provider ?? "ollama";
  const model = memoryConfig.config?.model;

  const envLines = [`      - LLM_PROVIDER=${provider}`];
  if (model) {
    envLines.push(`      - EMBEDDING_MODEL=${model}`);
  }
  if (memoryConfig.config?.api_key) {
    envLines.push(`      - API_KEY=${memoryConfig.config.api_key}`);
  }

  return [
    "hindsight:",
    "  image: ghcr.io/vectorize-io/hindsight:latest",
    "  ports:",
    "    - \"8888:8888\"",
    "    - \"9999:9999\"",
    "  environment:",
    ...envLines,
    "  volumes:",
    "    - hindsight-data:/home/hindsight/.pg0",
    "  restart: unless-stopped",
  ].join("\n");
}

/**
 * Look up the Hindsight collection name for an agent.
 * Falls back to the agent's name if no explicit collection is configured.
 */
export function getCollectionForAgent(
  agentName: string,
  config: ClerkConfig,
): string {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.collection ?? agentName;
}

/**
 * Check whether an agent has strict memory isolation.
 * Strict agents are excluded from cross-agent reflection.
 */
export function isStrictIsolation(
  agentName: string,
  config: ClerkConfig,
): boolean {
  const agentConfig = config.agents[agentName];
  return agentConfig?.memory?.isolation === "strict";
}
