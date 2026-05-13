/**
 * Hostd dispatch helpers for the gateway's self-restart slash-commands
 * (#1175 RFC C, Phase 2). When the operator has opted into
 * `host_control.enabled: true`, /restart, /new, /reset, and
 * /update apply route through the per-agent hostd UDS instead of the
 * in-container `spawnSwitchroomDetached` shellout.
 *
 * Rationale: in docker-mode (the v0.7+ default) the agent container
 * has no docker binary and no `/var/run/docker.sock` — so the
 * spawn-path verbs fail with exit-127 the moment they touch compose.
 * Hostd runs on the host with the docker socket mounted, so the verbs
 * actually work.
 *
 * Extracted from gateway.ts for unit-testability — gateway.ts itself
 * has too many boot-time side-effects to import directly in a test.
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostdRequest } from "../../src/host-control/client.js";
import type {
  HostdRequest,
  HostdResponse,
} from "../../src/host-control/protocol.js";
import { loadConfig as loadSwitchroomConfig } from "../../src/config/loader.js";

let _hostdEnabled: boolean | undefined;

/**
 * Reads `host_control.enabled` from the resolved switchroom config.
 * Cached for the gateway's lifetime — config doesn't change without a
 * restart, and the file-read isn't free.
 *
 * Best-effort: if the config can't be loaded (gateway running in a
 * dir where loadConfig fails), returns false so the dispatch helper
 * falls through to the legacy spawn path.
 */
export function isHostdEnabled(): boolean {
  if (_hostdEnabled !== undefined) return _hostdEnabled;
  try {
    const cfg = loadSwitchroomConfig();
    _hostdEnabled = cfg.host_control?.enabled === true;
  } catch {
    _hostdEnabled = false;
  }
  return _hostdEnabled;
}

/** @internal Reset the cache so tests can swap config and re-probe. */
export function _resetHostdEnabledCache(): void {
  _hostdEnabled = undefined;
}

export function hostdSocketPath(agentName: string): string {
  return `/run/switchroom/hostd/${agentName}/sock`;
}

/**
 * True only when (a) host_control is enabled in config AND (b) the
 * per-agent socket is bound on disk. Distinct from "will the wire call
 * succeed" — that's only knowable after attempting it.
 *
 * Callers use this to decide *whether to skip docker-availability
 * preflight guards* (since hostd doesn't need in-container docker).
 */
export function hostdWillBeUsed(agentName: string): boolean {
  if (!isHostdEnabled()) return false;
  return existsSync(hostdSocketPath(agentName));
}

/**
 * Send one request to the per-agent hostd socket.
 *
 * Returns:
 *   - `"not-configured"` — hostd is disabled in config OR the per-agent
 *     socket isn't bound. Callers should fall back to the legacy
 *     `spawnSwitchroomDetached` path.
 *   - `HostdResponse` — hostd was contacted. Callers branch on
 *     `resp.result`. Wire errors (ECONNREFUSED, timeout, bad frame)
 *     are synthesized into a `result: "error"` response so callers
 *     don't need a separate try/catch around the failure.
 *
 * Deliberately no silent fallback to spawn when hostd is configured-on
 * but returns error/denied: the operator opted in, so masking failures
 * would just confuse them about why the verb didn't actually run.
 */
export async function tryHostdDispatch(
  agentName: string,
  req: HostdRequest,
): Promise<HostdResponse | "not-configured"> {
  if (!isHostdEnabled()) return "not-configured";
  const sockPath = hostdSocketPath(agentName);
  if (!existsSync(sockPath)) return "not-configured";
  try {
    return await hostdRequest(
      { socketPath: sockPath, timeoutMs: 5000 },
      req,
    );
  } catch (err) {
    process.stderr.write(
      `telegram gateway: hostd dispatch failed ` +
        `(request_id=${req.request_id} op=${req.op}): ` +
        `${(err as Error).message}\n`,
    );
    return {
      v: 1,
      request_id: req.request_id,
      result: "error",
      exit_code: null,
      duration_ms: 0,
      error: `hostd wire error: ${(err as Error).message}`,
    };
  }
}

export function hostdRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}
