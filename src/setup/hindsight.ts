import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

/**
 * Default Hindsight ports (upstream defaults).
 */
export const HINDSIGHT_DEFAULT_API_PORT = 8888;
export const HINDSIGHT_DEFAULT_UI_PORT = 9999;

/**
 * Default cap on observations per *tag scope*.
 *
 * Upstream Hindsight defaults `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE`
 * to `-1` (unlimited). Once a tag scope hits the cap, consolidation
 * stops creating new observations and only updates/deletes existing
 * ones — bounding the cost of consolidating a single long-running
 * scope. Tagless observations are unaffected.
 *
 * Switchroom retains with `retainTags: ["{session_id}"]` (vendored
 * plugin default), so a "tag scope" maps roughly to "one session." A
 * very long Telegram session that runs for weeks can accumulate
 * thousands of observations under one scope — that's the case 1000
 * targets. Most sessions are far below the cap, so for typical
 * agents this is defense-in-depth rather than an active limit.
 *
 * This is NOT a fix for vectorize-io/hindsight#1284 (the upstream
 * unbounded-growth bug for consolidation across a whole bank); it's a
 * companion safety rail until that lands. Operators who want a
 * different value can stop the container and re-run `docker run`
 * with `-e HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=N`.
 */
export const HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE = 1000;

/**
 * Check if a TCP port is free for binding on 127.0.0.1.
 * Returns true if free, false if something is already listening.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Find a free port starting at `start`, incrementing until one is found
 * or `maxAttempts` ports have been tried.
 *
 * @param start - First port to try
 * @param maxAttempts - How many ports to try before giving up
 * @returns The first free port, or null if none found in range
 */
export async function findFreePort(
  start: number,
  maxAttempts = 50,
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = start + i;
    // Skip privileged ports just in case
    if (port < 1024) continue;
    if (await isPortFree(port)) {
      return port;
    }
  }
  return null;
}

/**
 * Pick host ports for the Hindsight container.
 *
 * Tries the upstream defaults (8888/9999) first. If either is taken,
 * falls back to 18888/19999, then keeps incrementing.
 *
 * Returns the chosen { apiPort, uiPort }, or throws if no ports could be found.
 */
export async function pickHindsightPorts(): Promise<{
  apiPort: number;
  uiPort: number;
}> {
  // Try defaults first
  if (
    (await isPortFree(HINDSIGHT_DEFAULT_API_PORT)) &&
    (await isPortFree(HINDSIGHT_DEFAULT_UI_PORT))
  ) {
    return {
      apiPort: HINDSIGHT_DEFAULT_API_PORT,
      uiPort: HINDSIGHT_DEFAULT_UI_PORT,
    };
  }

  // Defaults taken; fall back to 18888/19999 then linear scan
  const apiPort = await findFreePort(18888);
  const uiPort = await findFreePort(19999);
  if (apiPort === null || uiPort === null) {
    throw new Error(
      "Could not find a free port for Hindsight. " +
        "Stop whatever is using 8888 / 9999 / 18888 / 19999 and retry.",
    );
  }
  return { apiPort, uiPort };
}

/**
 * Check if Docker is available on the system.
 */
export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container is currently running.
 */
export function isHindsightRunning(): boolean {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "--filter", "name=switchroom-hindsight", "--format", "{{.Status}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if the switchroom-hindsight container exists (running or stopped).
 */
export function isHindsightContainerExists(): boolean {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=switchroom-hindsight", "--format", "{{.Names}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the Hindsight Docker container.
 *
 * @param provider - Optional LLM provider (e.g., "ollama", "openai", "anthropic")
 * @param apiKey - Optional LLM API key (e.g., OpenAI key)
 * @param ports - Optional host port mapping. If omitted, tries upstream
 *   defaults (8888/9999) then 18888/19999.
 */
export function startHindsight(
  provider?: string,
  apiKey?: string,
  ports?: { apiPort: number; uiPort: number },
): void {
  const apiPort = ports?.apiPort ?? HINDSIGHT_DEFAULT_API_PORT;
  const uiPort = ports?.uiPort ?? HINDSIGHT_DEFAULT_UI_PORT;
  const envArgs: string[] = [
    // Per-tag-scope observation cap. Bounds the size of a single
    // long-running session (switchroom retains tagged with
    // `{session_id}`). See HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE
    // for the rationale and how it relates to vectorize-io/hindsight#1284.
    "-e", `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=${HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE}`,
  ];
  if (provider) envArgs.push("-e", `HINDSIGHT_API_LLM_PROVIDER=${provider}`);
  if (apiKey) envArgs.push("-e", `HINDSIGHT_API_LLM_API_KEY=${apiKey}`);
  const args = [
    "run", "-d",
    "--name", "switchroom-hindsight",
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${apiPort}:8888`,
    "-p", `127.0.0.1:${uiPort}:9999`,
    "-v", "switchroom-hindsight-data:/home/hindsight/.pg0",
    ...envArgs,
    "ghcr.io/vectorize-io/hindsight:latest",
  ];

  execFileSync("docker", args, { stdio: "pipe" });
}

/**
 * Stop and remove the Hindsight Docker container.
 */
export function stopHindsight(): void {
  try {
    execFileSync("docker", ["stop", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be stopped */ }
  try {
    execFileSync("docker", ["rm", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be removed */ }
}

/**
 * Get the status of the Hindsight Docker container.
 * Returns a human-readable status string, or null if not found.
 */
export function getHindsightStatus(): string | null {
  try {
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=switchroom-hindsight", "--format", "{{.Status}}"],
      { stdio: "pipe", encoding: "utf-8" },
    );
    const status = output.trim();
    return status.length > 0 ? status : null;
  } catch {
    return null;
  }
}

/**
 * Get the MCP server config for Hindsight via HTTP endpoint.
 * Hindsight exposes MCP via Streamable HTTP at localhost:8888/mcp.
 */
export function getHindsightMcpUrl(): {
  url: string;
} {
  return {
    url: "http://localhost:8888/mcp/",
  };
}

/**
 * Generate a docker-compose snippet for Hindsight.
 */
export function generateHindsightComposeSnippet(provider?: string): string {
  const envLines = [
    // Always-on cap — see startHindsight() for context.
    `      - HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=${HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE}`,
  ];
  if (provider) envLines.push(`      - LLM_PROVIDER=${provider}`);

  return [
    "services:",
    "  switchroom-hindsight:",
    "    image: ghcr.io/vectorize-io/hindsight:latest",
    "    container_name: switchroom-hindsight",
    "    ports:",
    "      - \"8888:8888\"",
    "      - \"9999:9999\"",
    "    environment:",
    ...envLines,
    "    volumes:",
    "      - switchroom-hindsight-data:/home/hindsight/.pg0",
    "    restart: unless-stopped",
    "",
    "volumes:",
    "  switchroom-hindsight-data:",
  ].join("\n");
}
