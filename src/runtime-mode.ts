/**
 * Runtime-mode detection.
 *
 * `SWITCHROOM_RUNTIME=docker` is set by `src/agents/compose.ts` on every
 * agent container env block (and on the broker/kernel/scheduler service
 * blocks). Code paths that need to know whether they're running inside a
 * docker container vs. on the host should call `isDockerRuntime()`
 * rather than reading `process.env.SWITCHROOM_RUNTIME` directly — the
 * indirection lets us add a host-fallback heuristic later without
 * sprinkling additional reads across the codebase.
 *
 * Several modules already had local copies of this predicate
 * (`src/cli/vault.ts:isSandboxContext`,
 *  `src/cli/doctor-docker.ts`). PR #905 added a third caller and chose
 * to consolidate around this shared module so the host-broker-socket
 * resolver could share the same detection contract.
 */
export function isDockerRuntime(): boolean {
  return process.env.SWITCHROOM_RUNTIME === "docker";
}
