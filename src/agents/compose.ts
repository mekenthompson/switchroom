/**
 * Docker Compose generator — Phase 1a.
 *
 * Turns the cascade-resolved switchroom.yaml into a deterministic
 * docker-compose.yml.
 *
 * Determinism: agents are emitted in sorted name order, volumes
 * alphabetised, env keys sorted. Two apply runs against the same
 * inputs AND the same host filesystem state MUST produce a
 * byte-identical output (asserted by the snapshot tests in
 * tests/docker/compose-generator.test.ts). The host-filesystem
 * caveat covers the optional skills/credentials bind mounts (#907)
 * that we only emit when the source dirs actually exist — docker
 * compose `up` hard-fails when a `:ro` bind source is missing.
 *
 * Identity model:
 *   - Each agent gets a deterministic UID in 10001..10999 derived
 *     from a stable hash of its name (allocateAgentUid()).
 *   - Each agent's broker socket dir lives in its OWN named volume,
 *     mounted ONLY into that agent's container. Same for kernel.
 *   - The broker mounts every agent's socket dir under
 *     /run/switchroom/broker/<agent>; per-agent agents mount only
 *     their own dir under /run/switchroom/broker.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { SwitchroomConfig, AgentConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { isReservedAgentName } from "../vault/broker/peercred.js";

/** UID range reserved for agent containers. 999 slots — practical fleet limit. */
export const AGENT_UID_MIN = 10001;
export const AGENT_UID_MAX = 10999;

/** Resource defaults by profile category. RFC §"Resource limits as foot-guns". */
export interface ResourceDefaults {
  memLimit: string;
  cpus: number;
}

const RESOURCE_BY_PROFILE: Record<string, ResourceDefaults> = {
  klanker: { memLimit: "6g", cpus: 2.0 },
  // Conversational profiles — clerk, finn, carrie, coach, etc.
  conversational: { memLimit: "1.5g", cpus: 1.0 },
  // Lightweight profiles.
  lightweight: { memLimit: "1g", cpus: 0.5 },
  // Coding/worker/researcher.
  coding: { memLimit: "2g", cpus: 2.0 },
  // Catch-all default.
  default: { memLimit: "1.5g", cpus: 1.0 },
};

/**
 * Resolve resource defaults for an agent. Special-cases the agent name
 * "klanker" (matches the canonical fleet's klanker profile), then falls
 * through to the agent's `extends:` profile name, then to "default".
 *
 * Operator overrides at the agent level (resources.mem_limit etc.) win
 * over these defaults — see emitAgentService.
 */
export function resolveResourceDefaults(
  agentName: string,
  profile: string | undefined,
): ResourceDefaults {
  if (agentName === "klanker") return RESOURCE_BY_PROFILE.klanker!;
  if (profile && RESOURCE_BY_PROFILE[profile]) return RESOURCE_BY_PROFILE[profile]!;
  return RESOURCE_BY_PROFILE.default!;
}

/**
 * Allocate a deterministic UID for an agent in [AGENT_UID_MIN, AGENT_UID_MAX].
 *
 * Algorithm: SHA-256 of the agent name, take the first 4 bytes as a
 * uint32, modulo the range size, plus the floor. This is collision-prone
 * by birthday-paradox at large fleets — `checkAgentUidUniqueness` in
 * doctor flags collisions and instructs the operator to rename one of
 * the colliders. With 50 agents the collision probability is ~0.12%; at
 * the canonical ~10-agent fleet it's negligible.
 *
 * Determinism: same name → same UID, always. This matters for
 * compose regeneration after an `add agent` so existing agents' UIDs
 * never shift (which would require a chown sweep over their state).
 */
export function allocateAgentUid(name: string): number {
  // Names reserved by other identity kinds (today: "operator", used for
  // the host-shell broker socket) cannot be used as agent names.
  // Refusing here at allocation rather than letting a same-named agent
  // silently collide with the operator socket — which would forge an
  // identity from the broker's POV.
  if (isReservedAgentName(name)) {
    throw new Error(
      `agent name '${name}' is reserved by switchroom for another identity kind ` +
      `(see vault/broker/peercred.ts:RESERVED_AGENT_NAMES). Pick a different name.`,
    );
  }
  const hash = createHash("sha256").update(name).digest();
  const u32 = hash.readUInt32BE(0);
  const range = AGENT_UID_MAX - AGENT_UID_MIN + 1;
  return AGENT_UID_MIN + (u32 % range);
}

export interface ComposeGeneratorOptions {
  config: SwitchroomConfig;
  /** Image tag — same for every service in a release. */
  imageTag?: string;
  /** Stderr stream for warnings (cap-strip etc.); defaults to process.stderr. */
  warn?: (msg: string) => void;
  /**
   * Build mode. Default `pull` emits `image:` refs pointing at GHCR —
   * the production path; operators run `docker compose pull` and never
   * build locally. `local` instead emits `build:` blocks pointing at
   * the in-repo Dockerfiles — for dev work where the operator wants
   * `docker compose up --build` to use locally-modified Dockerfiles.
   */
  buildMode?: "pull" | "local";
  /**
   * Path to the switchroom checkout root. Required when `buildMode`
   * is `"local"`; the emitted `build.context` is set to this absolute
   * path so a compose file generated under `~/.switchroom/compose/`
   * still references the source tree's `docker/Dockerfile.*`.
   */
  buildContext?: string;
  /**
   * Absolute path to the operator's home directory — baked into every
   * host-path bind mount source at apply time.
   *
   * Why not `${HOME}`: compose interpolates env vars at the time the
   * `docker compose` CLI runs. When the operator runs `sudo docker
   * compose up -d`, sudo strips HOME by default (or sets it to /root),
   * so `${HOME}/.switchroom/...` resolves to `/root/.switchroom/...`
   * — wrong filesystem location, agent containers see empty volumes.
   *
   * Baking the absolute path at apply time eliminates the env-var
   * dependency. Optional for back-compat with callers that haven't
   * been updated yet (defaults to `${HOME}` interpolation).
   */
  homeDir?: string;
  /**
   * Absolute host path to the switchroom.yaml the operator wants the
   * containerised broker / kernel / scheduler to load. Bind-mounted
   * read-only into each of those services at /state/config/switchroom.yaml,
   * with `SWITCHROOM_CONFIG=/state/config/switchroom.yaml` set so they
   * skip the cwd auto-detect that doesn't exist inside the container.
   *
   * Without this, broker boots with `ConfigError: No switchroom.yaml found`
   * and restart-loops — the v0.7 P0 install-path bug. Optional for
   * back-compat; if omitted, broker / kernel get no config mount and
   * scheduler keeps its legacy `~/.switchroom:/state/config:ro` directory
   * mount (back-compat with pre-fix generated compose).
   */
  switchroomConfigPath?: string;
  /**
   * Prefix for `container_name:` values. Defaults to `"switchroom"` —
   * production behavior is unchanged. Setting this to a unique
   * per-test-run value (typical pattern: `phase1c-iso-${process.pid}`)
   * lets phase tests bring up their own broker/kernel/agent fleet
   * without colliding with the production singletons' fixed names on
   * a shared host.
   *
   * Belt-and-braces with `productionFleetIsLive()` skipIf guards in
   * `tests/docker/_prod-snapshot.ts`: even if a test forgets to skip
   * on a host with a live fleet, the parametrized name means it
   * creates `phase1c-iso-NNN-vault-broker` instead of clobbering
   * `switchroom-vault-broker`. Closes the test/prod-clobber regression
   * surfaced when PR #916 un-skipped the destructive docker phase
   * tests.
   *
   * Affects four slots:
   *   `container_name: <prefix>-vault-broker`
   *   `container_name: <prefix>-approval-kernel`
   *   `container_name: <prefix>-<agent-name>` for each agent
   *   `switchroom.fleet: "<prefix>"` label on every service
   *
   * The fleet label parametrization (added 2026-05-10 follow-up to PR
   * #939) lets `productionFleetIsLive()` distinguish a live production
   * fleet from a sibling phase test's fleet running in a parallel
   * vitest fork — the detection filter is `label=switchroom.fleet=
   * switchroom`, which now matches ONLY production. Without this, a
   * phase fleet from one fork looked like production to another fork
   * and produced spurious skip-with-"production-detected" reasons.
   *
   * Does NOT affect compose project name (`name: switchroom` at file
   * scope), service names (`vault-broker:`, `approval-kernel:`, the
   * agent service keys), or socket paths — those stay fixed because
   * the runtime / operator UX depends on them.
   */
  containerNamePrefix?: string;
  /**
   * Host operator UID — baked into the broker service so it knows which
   * UID to chown the operator socket+dir to at bind time. The operator
   * socket lives at `/run/switchroom/broker/operator/sock` inside the
   * broker container, host-bind-mounted at `${homeDir}/.switchroom/
   * broker-operator`. Without the chown, host-shell connects fail
   * because the socket is owned by root (the broker container's UID 0)
   * and the host operator runs as their own UID.
   *
   * Capture at apply time via `process.getuid()` (or `SUDO_UID` when
   * apply runs under sudo). Optional for back-compat: when omitted,
   * the broker skips the operator listener entirely and host-shell CLI
   * verbs continue to fail with "broker unreachable" — the same as
   * pre-fix behavior. Setting it is what turns the host-shell path on.
   */
  operatorUid?: number;
}

/** Resolve the image ref for one of the four service images. */
function resolveImageRef(
  name: "agent" | "broker" | "kernel" | "scheduler",
  imageTag: string,
): string {
  return `ghcr.io/switchroom/switchroom-${name}:${imageTag}`;
}

/**
 * Render the YAML lines for either an `image:` ref (pull mode) or a
 * `build:` block (local mode). Indentation is fixed at 4 spaces — the
 * caller has already emitted `  <service-name>:`.
 */
function emitImageOrBuild(
  lines: string[],
  service: "agent" | "broker" | "kernel" | "scheduler",
  imageTag: string,
  buildMode: "pull" | "local",
  buildContext: string | undefined,
): void {
  if (buildMode === "local") {
    if (!buildContext) {
      throw new Error(
        `compose: buildMode="local" requires buildContext (the absolute path to the switchroom checkout)`,
      );
    }
    lines.push(`    build:`);
    lines.push(`      context: ${buildContext}`);
    lines.push(`      dockerfile: docker/Dockerfile.${service}`);
  } else {
    lines.push(`    image: ${resolveImageRef(service, imageTag)}`);
  }
}

interface AgentServiceData {
  name: string;
  uid: number;
  profile: string | undefined;
  resources: ResourceDefaults;
  /** Capability extras the operator requested AND we stripped. */
  strippedCaps: string[];
}

/** Per-agent metadata exposed to doctor checks (and tests). */
export function describeAgents(config: SwitchroomConfig): AgentServiceData[] {
  const out: AgentServiceData[] = [];
  for (const name of Object.keys(config.agents).sort()) {
    const agent = config.agents[name]!;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const profile = agent.extends ?? "default";
    const uid = allocateAgentUid(name);
    const resources = resolveResourceDefaults(name, profile);
    const strippedCaps = readStrippedCaps(agent);
    out.push({ name, uid, profile, resources, strippedCaps });
    void resolved;
  }
  return out;
}

/** Capability-add escape hatch — we strip these in Docker mode (RFC). */
function readStrippedCaps(agent: AgentConfig): string[] {
  // The schema does not currently declare cap_add; an operator might
  // still smuggle it via settings_raw. We grep the raw settings for it.
  const raw = (agent.settings_raw ?? {}) as Record<string, unknown>;
  const caps = raw.cap_add;
  if (Array.isArray(caps)) return caps.map(String);
  return [];
}

/**
 * Generate a docker-compose.yml from the cascade. Pure function: no IO,
 * no env reads. Deterministic for byte-identical input.
 */
export function generateCompose(opts: ComposeGeneratorOptions): string {
  const { config } = opts;
  const imageTag = opts.imageTag ?? "latest";
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  const buildMode = opts.buildMode ?? "pull";
  const buildContext = opts.buildContext;
  // homePrefix is the leading segment of every host-path bind source.
  // When the caller passes homeDir we bake an absolute path so compose
  // interpolation under sudo can't mis-resolve HOME to /root. Default
  // preserves the older `${HOME}` shape for callers that haven't been
  // updated.
  const homePrefix = opts.homeDir ?? "${HOME}";
  // Default container_name prefix matches the compose project name and
  // every operator command in the docs (`docker exec -it switchroom-
  // vault-broker ...`, `journalctl --user -u switchroom-vault-broker`).
  // Tests override this so phase fleets get unique names that can't
  // collide with a production install on the same host.
  const containerNamePrefix = opts.containerNamePrefix ?? "switchroom";
  // For existsSync() decisions on optional bind-mount sources (#907):
  // emission uses `homePrefix` (which may be the literal "${HOME}" so
  // sudo-bake works), but the existsSync probe must use the real host
  // home. Falls back to process.env.HOME when no homeDir is passed.
  const hostHomeForChecks = opts.homeDir ?? process.env.HOME ?? "";
  const switchroomConfigPath = opts.switchroomConfigPath;
  if (buildMode === "local" && !buildContext) {
    throw new Error(
      `compose: buildMode="local" requires buildContext (the absolute path to the switchroom checkout)`,
    );
  }

  const lines: string[] = [];
  lines.push("# generated by switchroom — do not edit by hand.");
  lines.push("# Manual edits will be overwritten on the next `switchroom agent add`");
  lines.push("# (or future `switchroom reconcile`). To customise an agent, edit");
  lines.push("# switchroom.yaml and re-run the regenerating command.");
  lines.push("");
  lines.push(`# image tag: ${imageTag}`);
  lines.push("");
  // Top-level project name — belt-and-braces collision protection. A
  // Coolify-managed (or any other) compose stack on the same host can't
  // accidentally claim our service/container names because compose
  // namespaces by project; pinning the name at file scope means
  // `docker compose -f <path> ...` invocations always target the same
  // project even when the operator forgets `-p switchroom`.
  lines.push(`name: switchroom`);
  lines.push("");
  lines.push(`services:`);

  // ── vault-broker (singleton) ───────────────────────────────────────
  lines.push(`  vault-broker:`);
  emitImageOrBuild(lines, "broker", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-vault-broker`);
  // Fleet labels for ad-hoc selection (e.g. `docker ps --filter label=switchroom.role=agent`).
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "broker"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: unless-stopped`);
  // Liveness probe — bind-presence. The broker creates per-agent
  // socket directories at startup and binds `<dir>/sock` for each
  // configured agent. If at least one bind has happened, the daemon
  // is alive enough to take work; if every bind has gone away, the
  // daemon is wedged or dead and `restart: unless-stopped` should
  // recycle it. This catches the silent-down failure mode where the
  // broker exits cleanly (compose then sees process-gone) AS WELL AS
  // a hung daemon that's still holding the process slot but stopped
  // listening.
  //
  // Trade-off: an empty fleet (no agents → no per-agent dirs → no
  // sockets) reports unhealthy. Acceptable: a switchroom install
  // without any agents has no business running the broker; an
  // operator who's mid-install has minutes-scale exposure to this.
  // We do NOT speak the broker's app protocol here — that requires
  // peercred-checked auth and would generate audit-log noise on
  // every healthcheck tick. Bind-presence is the right level.
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/broker/*/sock 2>/dev/null | head -1 | grep -q ."]`);
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 20s`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Broker needs:
  //  - CHOWN + FOWNER: take ownership of per-agent socket dirs
  //    (created at startup) and chmod sockets to 0660 owned by the
  //    agent's UID.
  //  - DAC_READ_SEARCH: bypass DAC checks to read the operator-owned
  //    vault files. Broker runs as UID 0 so it can chown sockets, but
  //    `cap_drop: ALL` strips DAC_OVERRIDE / DAC_READ_SEARCH — without
  //    re-adding it, root can't read 0600 files owned by the operator's
  //    UID (which is what `setup` writes for vault.enc and
  //    `enable-auto-unlock` writes for vault-auto-unlock). Verified
  //    against a v0.7.3 test cutover: without this cap the broker
  //    boots, hits "Permission denied" on `/state/vault-auto-unlock`,
  //    logs `auto-unlock decrypt failed (io)`, and falls back to
  //    interactive unlock — i.e. auto-unlock is silently broken under
  //    docker.
  //  - DAC_OVERRIDE: bypass DAC checks for WRITE access to the vault
  //    dir (post-v0.7.12 op:put rotation). Without it, broker can
  //    READ the operator-owned vault dir (DAC_READ_SEARCH) but
  //    rejects mkdir/write into it because the host dir is mode 0700
  //    owned by the operator UID and the broker's container-root UID
  //    isn't recognized as the owner. Caught when self-deploying
  //    v0.7.12 against the operator's fleet: ms_graph_token.py
  //    succeeded reading the token but EACCES'd on writing the
  //    rotated value via `op:put`. The cap is consistent with the
  //    broker's existing trust posture (it already holds the
  //    passphrase + decrypted secrets in memory; allowing write is
  //    not an expansion of access, just of operations).
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  lines.push(`      - "DAC_OVERRIDE"`);
  lines.push(`    environment:`);
  if (switchroomConfigPath) {
    lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  }
  // Vault file path inside the container. Set explicitly so the broker
  // does NOT fall back to its `~/.switchroom/vault.enc` default — which
  // would resolve `~` against the container's HOME (/root) instead of
  // the operator's HOME on the host.
  // Broker's vault path. Always reads `/state/vault/vault.enc` —
  // the parent dir is bind-mounted from the host's resolved
  // `vault.path` parent (default `~/.switchroom/vault/`). v0.7.11
  // mounted the file directly which made atomic-rename impossible
  // (cross-fs single-file bind mount, EBUSY); v0.7.12 mounts the
  // parent dir so saveVault's write-temp-then-rename works.
  lines.push(`      SWITCHROOM_VAULT_PATH: /state/vault/vault.enc`);
  lines.push(`      SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH: /state/vault-auto-unlock`);
  // Operator UID — when set, the broker binds an additional listener at
  // /run/switchroom/broker/operator/sock and chowns it to this UID so
  // the host operator's shell can talk to the broker through the bind
  // mount below. See server.bindOperatorListener for the runtime side.
  if (opts.operatorUid !== undefined) {
    lines.push(`      SWITCHROOM_BROKER_OPERATOR_UID: "${opts.operatorUid}"`);
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker/${a.name}`);
  }
  // Operator listener bind — only emitted when operatorUid is set so a
  // legacy install (no operatorUid → no operator listener) doesn't get
  // an unused bind that just confuses operators staring at the compose
  // file. Both ends of the path-as-identity contract live here:
  //   host: ${homePrefix}/.switchroom/broker-operator
  //   container: /run/switchroom/broker/operator
  // peercred.socketPathToIdentity recognises the container path and
  // returns {kind: "operator"}; the broker chowns the socket to
  // operatorUid at bind time. The dir is auto-created by docker on
  // bind-mount setup; no host-side mkdir required.
  if (opts.operatorUid !== undefined) {
    lines.push(
      `      - ${homePrefix}/.switchroom/broker-operator:/run/switchroom/broker/operator`,
    );
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  // Vault parent directory mounted RW. v0.7.12 layout: vault file
  // lives at `~/.switchroom/vault/vault.enc`, parent dir is
  // bind-mounted at `/state/vault/`. atomicWriteFileSync's write-
  // temp-then-rename pattern works because temp file lands in the
  // same fs as the destination.
  //
  // v0.7.11 (and earlier) mounted the FILE directly (`~/.switchroom/
  // vault.enc:/state/vault.enc:ro`). That had two problems:
  //   1. Single-file bind mount + atomic-rename = EBUSY (cross-fs
  //      rename to a bind-mount target fails). Surfaced as #954.
  //   2. RO precluded broker-driven rotation (#952's op:put). Both
  //      fixed by switching to a parent-dir RW mount.
  //
  // The v0.7.0 install bug — docker auto-creating an empty root-
  // owned `~/.switchroom/vault/` on the host — is avoided by
  // ensuring the directory exists with the operator's UID before
  // compose runs. `switchroom apply`'s migrateVaultLayout step
  // creates the directory with mode 0700 and moves the existing
  // vault file into it, so docker never has to create an empty
  // vault dir.
  //
  // Broker reads `/state/vault/vault.enc` (see SWITCHROOM_VAULT_PATH
  // env above). The parent-dir guard at apply time refuses to mount
  // if the dir contains anything other than the canonical vault
  // file + saveVault's known artifacts (lockfile, sibling-tmp, etc).
  lines.push(`      - ${homePrefix}/.switchroom/vault:/state/vault:rw`);
  // Auto-unlock blob (encrypted with /etc/machine-id-derived key).
  // Mounted read-only — the broker only ever reads the blob; rotation
  // is performed by the host CLI (`switchroom vault broker enable-auto-unlock`)
  // followed by a `docker compose restart vault-broker`. Compose treats
  // a missing source as an empty directory — the broker detects that
  // and falls back to the interactive unlock flow, so operators who
  // never enabled auto-unlock are unaffected.
  lines.push(`      - ${homePrefix}/.switchroom/vault-auto-unlock:/state/vault-auto-unlock:ro`);
  // /etc/machine-id passthrough — required so the broker can derive
  // the same machine-bound key the host's `enable-auto-unlock` used
  // to seal the auto-unlock blob. The agent base image (node:22-bookworm-slim)
  // ships without /etc/machine-id; without this mount the broker
  // errors out "Cannot derive machine-bound key: neither /etc/machine-id
  // nor /var/lib/dbus/machine-id is readable" and falls back to
  // interactive unlock. Mount the FILE (not the /etc dir) so we don't
  // shadow the rest of /etc inside the broker image.
  lines.push(`      - /etc/machine-id:/etc/machine-id:ro`);
  lines.push(``);

  // ── approval-kernel (singleton) ────────────────────────────────────
  lines.push(`  approval-kernel:`);
  emitImageOrBuild(lines, "kernel", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-approval-kernel`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "kernel"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: unless-stopped`);
  // Mirror the broker's bind-presence healthcheck — same failure-mode
  // surface (kernel binds per-agent sockets at
  // /run/switchroom/kernel/<agent>/sock; silently exits or hangs the
  // same way) and same empty-fleet trade-off documented above.
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/kernel/*/sock 2>/dev/null | head -1 | grep -q ."]`);
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 20s`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Kernel mirrors broker: it owns per-agent socket dirs and must chown
  // sockets to the agent UID after bind().
  //
  // DAC_READ_SEARCH is needed by the healthcheck probe (PR #898) — it
  // runs `ls /run/switchroom/kernel/*/sock` as root, but per-agent
  // socket dirs are mode 0700 owned by the agent UID after bind. With
  // `cap_drop: ALL` and only CHOWN + FOWNER, root cannot read into
  // those dirs, so the probe always fails. Broker already has this
  // cap (for vault file reads); adding it here gives both singletons
  // the same probe-reachability. Read-only DAC bypass — strictly less
  // powerful than DAC_OVERRIDE which also bypasses write checks.
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  if (switchroomConfigPath) {
    lines.push(`    environment:`);
    lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel/${a.name}`);
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  lines.push(`      - ${homePrefix}/.switchroom/approvals:/state/approvals`);
  lines.push(``);

  // The singleton switchroom-cron service was removed in Phase 4 of
  // the cron-fold-in. Cron now runs in-container as a sibling of the
  // gateway in every agent (see profiles/_base/start.sh.hbs's third
  // supervised sidecar and src/agent-scheduler/). Fires arrive in the
  // agent transcript through the same InboundMessage path Telegram
  // uses, tagged meta.source="cron".

  // ── per-agent services ─────────────────────────────────────────────
  for (const a of describeAgents(config)) {
    if (a.strippedCaps.length > 0) {
      warn(`compose: stripping cap_add ${JSON.stringify(a.strippedCaps)} from agent "${a.name}" (Docker mode forbids capability extras; see RFC §security)`);
    }
    emitAgentService(lines, a, imageTag, buildMode, buildContext, homePrefix, hostHomeForChecks, switchroomConfigPath, containerNamePrefix);
  }

  // ── volumes ────────────────────────────────────────────────────────
  lines.push(`volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`  broker-${a.name}-sock:`);
    lines.push(`  kernel-${a.name}-sock:`);
  }
  lines.push("");

  return lines.join("\n");
}

function emitAgentService(
  lines: string[],
  a: AgentServiceData,
  imageTag: string,
  buildMode: "pull" | "local",
  buildContext: string | undefined,
  homePrefix: string,
  hostHomeForChecks: string,
  switchroomConfigPath: string | undefined,
  containerNamePrefix: string,
): void {
  lines.push(`  agent-${a.name}:`);
  emitImageOrBuild(lines, "agent", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-${a.name}`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "agent"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`      switchroom.agent: "${a.name}"`);
  // Share the host's network namespace.
  //
  // Scaffolded `start.sh` and the env baked into it reach a number of
  // host-local endpoints by their host-side address: Hindsight at
  // 127.0.0.1:18888 (host-loopback), the operator's LAN devices for
  // user-declared env vars (HA at 192.168.x.x, NAS, smart-home gear),
  // and the host's resolver for any DNS. With the default bridge
  // network those are unreachable from inside the container —
  // `127.0.0.1` is the container's own loopback, and the LAN is on the
  // host side of the bridge. v0.7.0 → v0.7.3 emitted no network config
  // and the agent silently failed: hindsight wait-loop timed out, MCP
  // servers errored at startup, telegram polling never began.
  // `network_mode: host` puts the agent on the host's network stack —
  // identical semantics to the v0.6 systemd-era model. Tradeoff:
  // network isolation between agents goes away (they can reach each
  // other and any host service), but the previous trust model already
  // assumed shared-host operation. Future work: a strict-isolation
  // mode that puts agents on a custom network and routes hindsight
  // through an explicit `extra_hosts` entry for `host.docker.internal`.
  lines.push(`    network_mode: host`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    init: false`);
  // PTY allocation — claude's interactive mode requires a TTY at stdin
  // (the alt-screen UI, autoaccept-poll keystrokes, and the `--print`
  // fallback's stdin check). Without these the container boots, claude
  // detects "no TTY → fall back to --print", immediately errors
  // "Input must be provided either through stdin or as a prompt
  // argument when using --print", tini exits, and the container
  // restarts forever. Equivalent to `docker run -it`. v0.6's systemd
  // path got the PTY for free via the tmux ExecStart wrapper; under
  // docker we ask compose for it directly.
  lines.push(`    tty: true`);
  lines.push(`    stdin_open: true`);
  lines.push(`    stop_grace_period: 45s`);
  lines.push(`    user: "${a.uid}:${a.uid}"`);
  lines.push(`    mem_limit: ${a.resources.memLimit}`);
  lines.push(`    cpus: ${a.resources.cpus.toFixed(1)}`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // read_only root FS — claude CLI, tini, tmux, node only need writable
  // /tmp (and the explicit /state/* mounts above). tmpfs keeps /tmp
  // RAM-backed and capped so a runaway can't fill the host disk.
  lines.push(`    read_only: true`);
  lines.push(`    tmpfs:`);
  lines.push(`      - /tmp:size=256m,mode=1777`);
  lines.push(`    depends_on:`);
  lines.push(`      vault-broker:`);
  lines.push(`        condition: service_started`);
  lines.push(`      approval-kernel:`);
  lines.push(`        condition: service_started`);
  lines.push(`    environment:`);
  // env keys MUST be sorted for byte determinism.
  const env: Record<string, string> = {
    // Per-agent persistent HOME — lives at ~/.switchroom/agents/<name>/home
    // on the host (inside the existing /state/agent bind mount, no extra
    // volume needed). The container's ImageConfig.User is a numeric UID
    // with no /etc/passwd entry, so HOME defaults to "/" which is on the
    // read-only root fs — every tool that writes to ~/.config, ~/.cache,
    // ~/.local, ~/.gitconfig fails outright. Pointing HOME at the bind
    // mount lets `gh auth login`, `git config --global`, `pip install
    // --user`, shell history, ssh keys, and similar persist across
    // container restarts.
    HOME: "/state/agent/home",
    // npm global installs (`npm install -g foo`) land here so they (a)
    // don't fail on the read-only /usr/local prefix and (b) survive
    // restart. PATH adjustment that puts this on the search path lives
    // in profiles/_base/start.sh.hbs.
    NPM_CONFIG_PREFIX: "/state/agent/home/.npm-global",
    // Make `pip install foo` Just Work for agents. Two env vars:
    //   PIP_USER=1                 — install to ~/.local (writable +
    //                                persistent via Layer 1) instead of
    //                                /usr/local site-packages (read-only).
    //   PIP_BREAK_SYSTEM_PACKAGES=1 — Debian 12 marks the system Python
    //                                as PEP 668 "externally-managed",
    //                                so pip refuses even `pip install
    //                                --user` by default with a confusing
    //                                "externally-managed-environment"
    //                                error. The override is explicit +
    //                                visible in `printenv`.
    // Without both, an agent's first `pip install polars / pandas /
    // numpy / claude-sdk` fails with either that error or "Read-only
    // file system" — neither recoverable from a tool-call retry loop.
    // With both, packages land in ~/.local/lib and survive container
    // restart via the /state/agent bind mount.
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PIP_USER: "1",
    SWITCHROOM_AGENT_NAME: a.name,
    // Broker / kernel socket paths inside the agent container. The
    // per-agent volume is mounted at `/run/switchroom/broker` (and
    // `/run/switchroom/kernel`) — directly at the parent dir, NOT
    // at the broker-side `/run/switchroom/broker/<agent>` subdir
    // (compose.ts:370 vs compose.ts:607). So from inside the agent
    // the socket is at `/run/switchroom/broker/sock`, one level
    // shallower than the broker container sees it.
    //
    // Two pre-fix bugs were stacked:
    //   1. The path values here were `/run/switchroom/broker/<name>
    //      /sock` — the broker's view, which does not exist inside
    //      the agent container at all.
    //   2. The broker env NAME was `SWITCHROOM_BROKER_SOCKET` — but
    //      the broker CLIENT (`src/vault/broker/client.ts:293`) and
    //      the secret-guard hook (`telegram-plugin/hooks/secret-
    //      guard-pretool.mjs:36`) both read
    //      `SWITCHROOM_VAULT_BROKER_SOCK`. So clients silently fell
    //      through to the `~/.switchroom/vault-broker.sock` legacy
    //      fallback (a dangling symlink inside the container) and
    //      reported "broker not running" even when the broker was
    //      up and the socket was bound at the correct in-container
    //      path. Operator-visible on 2026-05-10 as klanker's
    //      "VAULT-BROKER-DENIED" after the test-clobber incident
    //      restored the broker container.
    // Kernel side already used the correct env name (matches
    // `src/vault/approvals/client.ts:60`) but had the same wrong
    // path value. Both fixed here.
    SWITCHROOM_VAULT_BROKER_SOCK: `/run/switchroom/broker/sock`,
    SWITCHROOM_KERNEL_SOCKET: `/run/switchroom/kernel/sock`,
    SWITCHROOM_RUNTIME: "docker",
  };
  // SWITCHROOM_CONFIG: the in-container telegram-plugin gateway daemon
  // (forked as a sidecar by start.sh's docker preamble) shells out to
  // the switchroom CLI for handoff / vault / topic operations and
  // passes `--config $SWITCHROOM_CONFIG` so the in-container CLI finds
  // the right yaml regardless of cwd. The yaml is bind-mounted below.
  // Same env+mount pattern broker/kernel/scheduler already use.
  if (switchroomConfigPath) {
    env.SWITCHROOM_CONFIG = "/state/config/switchroom.yaml";
  }
  for (const k of Object.keys(env).sort()) {
    lines.push(`      ${k}: ${JSON.stringify(env[k])}`);
  }
  lines.push(`    volumes:`);
  // Per-agent volumes — each volume mounted into EXACTLY this agent's
  // container. The doctor check `checkAgentSocketMounts` asserts the
  // invariant on every regenerated compose.
  lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker`);
  lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel`);
  // Dual mounts — the same host directory is bound BOTH at the canonical
  // container path (`/state/agent`, `/state/.claude`, `/var/log/switchroom`)
  // AND at the original host path. Why both:
  //   - `/state/*` paths are baked into the Dockerfile (Dockerfile.agent's
  //     CMD is `/state/agent/start.sh`; tini ENTRYPOINT calls into it).
  //     Removing the canonical paths would break the existing v0.7.0
  //     image without rebuilding it.
  //   - Same-path mounts let scaffolded start.sh / settings.json (which
  //     bake the absolute host path of agentDir at scaffold time) Just
  //     Work inside the container. The host path in `cd "$agentDir"`
  //     resolves to the same file the bind mount points at.
  // Dual-mount is the smallest viable fix that unblocks v0.7.0 installs
  // without an image rebuild + republish.
  lines.push(`      - ${homePrefix}/.switchroom/agents/${a.name}:/state/agent`);
  lines.push(`      - ${homePrefix}/.claude/projects/${a.name}:/state/.claude`);
  lines.push(`      - ${homePrefix}/.switchroom/logs/${a.name}:/var/log/switchroom`);
  lines.push(`      - ${homePrefix}/.switchroom/agents/${a.name}:${homePrefix}/.switchroom/agents/${a.name}`);
  lines.push(`      - ${homePrefix}/.claude/projects/${a.name}:${homePrefix}/.claude/projects/${a.name}`);
  // Shared read-only bind mounts for skills + credentials (#907). Cron
  // yaml prompts widely reference `~/.switchroom/skills/...` (calendar,
  // mail, garmin, home-assistant) and `~/.switchroom/credentials/...`.
  // Mounted at the operator's host path so absolute paths in scaffolded
  // start.sh and yaml prompts Just Work; tilde resolution is fixed by
  // start.sh.hbs's $HOME/.switchroom symlink (see #910). Conditional on
  // existsSync because docker compose `up` hard-fails when a `:ro`
  // source is missing — many operators keep all secrets in vault and
  // never create a `credentials/` dir at all.
  if (existsSync(`${hostHomeForChecks}/.switchroom/skills`)) {
    lines.push(`      - ${homePrefix}/.switchroom/skills:${homePrefix}/.switchroom/skills:ro`);
  }
  if (existsSync(`${hostHomeForChecks}/.switchroom/credentials`)) {
    lines.push(`      - ${homePrefix}/.switchroom/credentials:${homePrefix}/.switchroom/credentials:ro`);
  }
  // switchroom.yaml file mount (read-only) — the in-container gateway
  // daemon needs `--config $SWITCHROOM_CONFIG` to talk to the
  // switchroom CLI for handoff / topic / vault grants. SWITCHROOM_CONFIG
  // is set above; it points here.
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  lines.push(`      - ${homePrefix}/.switchroom/logs/${a.name}:${homePrefix}/.switchroom/logs/${a.name}`);
  lines.push(``);
  void imageTag;
}
