import type { ClerkConfig, MemoryBackendConfig } from "../config/schema.js";

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Generate the MCP server config entry for Hindsight.
 *
 * In docker mode (docker_service: true), the command runs via `docker exec`.
 * In local mode, it invokes the `hindsight` binary directly.
 */
export function generateHindsightMcpConfig(
  collection: string,
  memoryConfig: MemoryBackendConfig,
): McpServerConfig {
  const isDocker = memoryConfig.config?.docker_service ?? true;

  if (isDocker) {
    return {
      command: "docker",
      args: ["exec", "-i", "clerk-hindsight", "hindsight", "mcp", "--collection", collection],
      env: {},
    };
  }

  return {
    command: "hindsight",
    args: ["mcp", "--collection", collection],
    env: {},
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
    "  image: vectorize/hindsight:latest",
    "  environment:",
    ...envLines,
    "  volumes:",
    "    - hindsight-data:/data",
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
