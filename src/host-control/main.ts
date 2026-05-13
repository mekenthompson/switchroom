/**
 * switchroom-hostd entrypoint.
 *
 * Phase 1 minimal binary: loads switchroom.yaml, derives the agent
 * UID map, instantiates HostdServer, starts it, waits for SIGTERM.
 *
 * Phase 1.5 follow-up will land:
 *   - `switchroom hostd install` (writes the systemd user unit)
 *   - `switchroom hostd status` / `start` / `stop` wrappers
 *   - logrotate.d fragment for the audit log
 *
 * Phase 2 follow-up adds the gateway integration that actually
 * routes verbs through the daemon (replacing spawnSwitchroomDetached
 * callsites). Until then, this entrypoint can be invoked by an
 * operator who's opted into `host_control.enabled: true` but
 * behaviour is observation-only — the daemon binds sockets and
 * audits incoming calls, but no gateway code path produces them.
 */

import { homedir } from "node:os";
import { loadConfig } from "../config/loader.js";
import { allocateAgentUid } from "../agents/compose.js";
import { HostdServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.host_control?.enabled !== true) {
    process.stderr.write(
      "hostd: refusing to start — host_control.enabled is not true in switchroom.yaml\n",
    );
    process.exit(2);
  }

  const agentUids: Record<string, number> = {};
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.admin === true) {
      agentUids[name] = allocateAgentUid(name);
    }
  }

  if (Object.keys(agentUids).length === 0) {
    process.stderr.write(
      "hostd: no admin-flagged agents — nothing to serve. Set `admin: true` on at least one agent.\n",
    );
    process.exit(2);
  }

  const server = new HostdServer({
    homeDir: homedir(),
    agentUids,
    config: {
      agents: Object.fromEntries(
        Object.entries(config.agents).map(([n, a]) => [n, { admin: a.admin === true }]),
      ),
    },
  });
  await server.start();

  const paths = server.getBoundPaths();
  process.stderr.write(
    `hostd: ready — bound ${paths.length} agent socket(s): ${paths.join(", ")}\n`,
  );

  // Wait for SIGTERM / SIGINT. systemd's standard stop signal is
  // SIGTERM; Ctrl-C in dev sends SIGINT. Both shut down gracefully.
  let stopping = false;
  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`hostd: shutting down (${reason})\n`);
    await server.stop();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  process.stderr.write(`hostd: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
