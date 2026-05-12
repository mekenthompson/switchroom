import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 * Pick a tmpfs-backed directory for the LLM-key secret file.
 *
 * Resolution order:
 *   1. `/run/switchroom/hindsight/` — preferred on systemd hosts, tmpfs by default.
 *   2. `/dev/shm/switchroom-hindsight/` — fallback when `/run` is read-only
 *      (rootless containers, some hardened hosts).
 *
 * If neither parent is writable we throw rather than silently writing the
 * secret to persistent disk (e.g. `/tmp`, which is *not* tmpfs on every
 * distro and outlives container restarts).
 *
 * Exported for the doctor probe and tests.
 */
export function pickHindsightSecretDir(): string {
  const candidates = ["/run/switchroom/hindsight", "/dev/shm/switchroom-hindsight"];
  const errors: string[] = [];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Probe that we can actually write a file here. mkdirSync can succeed
      // on a read-only mount that already has the dir; the write probe is
      // the only honest test.
      accessSync(dir, fsConstants.W_OK);
      return dir;
    } catch (err) {
      errors.push(`${dir}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    "No writable tmpfs location for the Hindsight LLM key file. " +
      "Tried (in order):\n  " +
      errors.join("\n  ") +
      "\n\nRefusing to fall back to /tmp because it isn't tmpfs on every " +
      "distro; the API key would otherwise survive on persistent disk.",
  );
}

/**
 * Path to the secret file on the host. Single fixed name per container —
 * there's only one `switchroom-hindsight` container, so a stable path is fine.
 */
export function hindsightSecretFilePath(): string {
  return `${pickHindsightSecretDir()}/llm-key`;
}

/**
 * In-container mount point for the secret file. Bind-mounted read-only
 * from the host path returned by `hindsightSecretFilePath()`. The
 * entrypoint shim (see startHindsight) reads this file and exports
 * the env var inside the container so it never enters `Config.Env`.
 */
export const HINDSIGHT_SECRET_CONTAINER_PATH = "/run/secrets/hindsight-llm-key";

/**
 * Write the LLM API key to a tmpfs-backed file (mode 0644). The file
 * contains JUST the key value (no `KEY=` prefix) — the in-container
 * shim does the `export` step.
 *
 * Why a bind-mounted secret file + entrypoint shim instead of `-e` or
 * `--env-file`:
 *
 *   - `-e KEY=VALUE` exposes the value via `docker inspect`'s
 *     `.Config.Env` to anyone in the docker group, AND writes the
 *     secret to the parent process's command line (shell history,
 *     journald).
 *   - `--env-file path` — empirically verified on Docker 29.4.1 — DOES
 *     populate `.Config.Env` identically to `-e`. It only closes the
 *     argv leak, not the inspect leak.
 *   - Hindsight upstream does not support `HINDSIGHT_API_LLM_API_KEY_FILE`
 *     indirection (checked vectorize-io/hindsight, no `*_FILE` env
 *     convention as of this fix).
 *
 * The bind-mount + shim approach closes BOTH leaks: docker only knows
 * about a volume mount and a CMD override; the env var is set inside
 * the container by `sh -c 'export …' && exec /app/start-all.sh`, which
 * docker has no view into. `docker inspect .Config.Env` won't contain
 * the key.
 *
 * Why file mode 0644 (not 0600):
 *   - The host parent dir (`pickHindsightSecretDir`) is mode 0700 owned
 *     by the current user — that's where access control happens. Other
 *     host users can't even traverse into the dir.
 *   - The bind-mount preserves numeric UID into the container, where
 *     Hindsight runs as user `hindsight` (non-root, per upstream's
 *     `USER hindsight` in Dockerfile.standalone). If the host UID
 *     doesn't match the container's `hindsight` UID, mode 0600 would
 *     break `cat` inside the shim with EACCES. 0644 lets the
 *     containerized non-root user read the file regardless of UID
 *     mapping; the dir's 0700 still keeps other host users out.
 *
 * Cleanup story:
 *   - `stopHindsight()` unlinks the host file (best-effort).
 *   - The dir lives on tmpfs, so a host reboot wipes it.
 *   - The bind-mount is read-only inside the container, so the
 *     containerized process can't tamper.
 */
export function writeHindsightLlmKeyFile(apiKey: string): string {
  const path = hindsightSecretFilePath();
  const trimmed = apiKey.trim();
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Hindsight LLM API key contains a newline; refusing to write.");
  }
  // No trailing newline — the shim uses `$(cat …)` and a trailing
  // newline gets stripped by command substitution anyway, but keeping
  // the file byte-exact avoids surprises if someone inspects it.
  // Mode 0644 — see jsdoc rationale above. The 0700 parent dir is the
  // real access control.
  writeFileSync(path, trimmed, { mode: 0o644 });
  // Re-chmod in case umask / pre-existing file altered the bits.
  chmodSync(path, 0o644);
  return path;
}

/**
 * Start the Hindsight Docker container.
 *
 * @param provider - Optional LLM provider (e.g., "ollama", "openai", "anthropic")
 * @param apiKey - Optional LLM API key (e.g., OpenAI key). When present,
 *   written to a tmpfs file and bind-mounted into the container; an
 *   entrypoint shim exports the env var INSIDE the container so it
 *   never enters `.Config.Env`. See `writeHindsightLlmKeyFile()` for
 *   the threat model.
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
  // Non-secret env stays on `-e` — provider name isn't sensitive and is
  // useful as a debugging breadcrumb in `docker inspect`.
  if (provider) envArgs.push("-e", `HINDSIGHT_API_LLM_PROVIDER=${provider}`);

  // Secret routing: bind-mount the host file read-only at a fixed
  // in-container path, then override CMD with a shim that exports the
  // key from the file before `exec`ing into Hindsight's start-all.sh.
  // This keeps the key out of .Config.Env entirely — docker only sees
  // the volume mount and CMD argv, neither of which contain the value.
  const secretMountArgs: string[] = [];
  let cmdOverride: string[] = [];
  if (apiKey) {
    const hostPath = writeHindsightLlmKeyFile(apiKey);
    // `:ro` bind mount — the container has no business writing back.
    secretMountArgs.push("-v", `${hostPath}:${HINDSIGHT_SECRET_CONTAINER_PATH}:ro`);
    // Override CMD via `--entrypoint sh` + args after the image. The
    // shim must exec the upstream CMD (`/app/start-all.sh`) so that
    // PID-1 semantics, signal handling, and tini-style behavior are
    // preserved.
    //
    // Fail-loud guards (in this order):
    //   1. `set -eu` catches unset/empty intermediate vars.
    //   2. `key=$(cat …) || exit 1` — POSIX `set -e` does NOT propagate
    //      failures from `$(…)` inside a simple assignment, so we make
    //      the failure explicit. Catches missing bind-mount source,
    //      EACCES on the mounted file (e.g. UID mismatch with the
    //      Hindsight user), or any cat failure.
    //   3. `[ -n "$key" ] || exit 1` — refuse to boot Hindsight with an
    //      empty API key. This is the "silent boot with no key" guard
    //      the previous `set -e`-only version actually failed to provide.
    //
    // Exit-1 means docker logs the failure and `--restart unless-stopped`
    // backs off rather than looping forever; `docker logs
    // switchroom-hindsight` shows the shim's stderr.
    cmdOverride = [
      "-c",
      `set -eu; key=$(cat ${HINDSIGHT_SECRET_CONTAINER_PATH}) || exit 1; [ -n "$key" ] || exit 1; export HINDSIGHT_API_LLM_API_KEY="$key"; exec /app/start-all.sh`,
    ];
  }

  const entrypointArgs = apiKey ? ["--entrypoint", "sh"] : [];

  const args = [
    "run", "-d",
    "--name", "switchroom-hindsight",
    "--restart", "unless-stopped",
    "-p", `127.0.0.1:${apiPort}:8888`,
    "-p", `127.0.0.1:${uiPort}:9999`,
    "-v", "switchroom-hindsight-data:/home/hindsight/.pg0",
    ...envArgs,
    ...secretMountArgs,
    ...entrypointArgs,
    "ghcr.io/vectorize-io/hindsight:latest",
    ...cmdOverride,
  ];

  execFileSync("docker", args, { stdio: "pipe" });
}

/**
 * Stop and remove the Hindsight Docker container.
 *
 * Also unlinks the LLM-key secret file on tmpfs (best-effort) so a stopped
 * container doesn't leave the key sitting at a predictable path. A host
 * reboot also wipes it (tmpfs), and a re-`startHindsight()` rewrites it.
 */
export function stopHindsight(): void {
  try {
    execFileSync("docker", ["stop", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be stopped */ }
  try {
    execFileSync("docker", ["rm", "switchroom-hindsight"], { stdio: "pipe" });
  } catch { /* container may already be removed */ }
  // Best-effort cleanup. We probe both candidate dirs because the file
  // may have been written under whichever was writable at start time.
  // Both the old env-file path (pre-pivot) and the new bare-value path
  // are unlinked, so a partial rollout doesn't strand keys.
  for (const dir of ["/run/switchroom/hindsight", "/dev/shm/switchroom-hindsight"]) {
    for (const name of ["llm-key", "llm-key.env"]) {
      const path = `${dir}/${name}`;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch { /* nothing to clean up */ }
    }
  }
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
