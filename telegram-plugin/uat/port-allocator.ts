/**
 * Process-wide unique port allocator for the UAT harness.
 *
 * Why this exists: each scenario `spinUp`s an agent child process
 * with its own gateway listening on `TELEGRAM_GATEWAY_PORT`. If two
 * sibling scenarios race to pick a port we get silent collisions
 * that masquerade as flaky assertions ("the bridge couldn't reach
 * the gateway, so no replies showed up"). See SETUP.md §6 for the
 * port-vs-unix-socket decision.
 *
 * The allocator is monotonic per process and probes the candidate
 * by `bind()`ing a transient socket — catches the case where some
 * other process on the host has stolen a port out of our range.
 */

import { createServer } from "node:net";

const DEFAULT_BASE_PORT = 47000;
const DEFAULT_MAX_PORT = 47999;

let cursor = DEFAULT_BASE_PORT;

/**
 * Allocate the next free TCP port in the harness range.
 *
 * Throws if every port in [base, max] is taken — almost certainly
 * means a previous run leaked agent processes. Recovery: `pkill -f
 * test-harness-uat` and try again.
 */
export async function allocatePort(opts?: {
  base?: number;
  max?: number;
}): Promise<number> {
  const base = opts?.base ?? DEFAULT_BASE_PORT;
  const max = opts?.max ?? DEFAULT_MAX_PORT;

  if (cursor < base) cursor = base;

  const start = cursor;
  for (;;) {
    const port = cursor;
    cursor = cursor + 1 > max ? base : cursor + 1;

    if (await isPortFree(port)) {
      return port;
    }

    if (cursor === start) {
      throw new Error(
        `[uat/port-allocator] no free ports in [${base}, ${max}]; ` +
          "likely leaked agent child processes — try `pkill -f test-harness-uat`",
      );
    }
  }
}

/** Reset the allocator. Test-only. */
export function _resetAllocatorForTests(): void {
  cursor = DEFAULT_BASE_PORT;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}
