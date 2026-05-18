/**
 * `switchroom skill publish|unpublish` — promote an agent's own,
 * natively-authored agent-scope skill into the operator's global pool
 * (and remove it again).
 *
 * Agent-scope skills are authored the Claude-native way (plain
 * Write/Edit into `$CLAUDE_CONFIG_DIR/skills/<slug>/`); there is no
 * create/edit/read/delete tool surface — that shim was removed (RFC
 * docs/rfcs/skill-authoring-native.md, Phase 3). Publish is the one
 * privileged, admin-gated, marker-guarded broker write; see
 * `skillPublish` for the §3.5 atomicity contract.
 *
 * Error codes (constants in `skill-common.ts`):
 *   - E_SKILL_NOT_FOUND                   (exit 14)
 *   - E_SKILL_BUNDLE_TOO_LARGE            (exit 15)
 *   - E_SKILL_INVALID_NAME                (exit 9)
 *   - E_SKILL_INVALID_PATH                (exit 9)
 *   - E_SKILL_INVALID_FRONTMATTER         (exit 9)
 *   - E_SKILL_SCOPE_DENIED                (exit 9)
 *   - E_SKILL_OPERATOR_OWNED              (exit 18)
 *   - E_SKILL_GLOBAL_MOUNT_UNCONFIGURED   (exit 17)
 *   - E_AGENT_PIN_REQUIRED                (exit 16)
 */

import type { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  rmSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join, dirname, sep } from "node:path";
import {
  agentScopeSkillDir,
  agentScopeSkillsRoot,
  appendAudit,
  authorErr,
  authorExitCodeFor,
  authorshipMarkerName,
  globalScopeSkillDir,
  globalScopeSkillsRoot,
  hasAuthorshipMarker,
  listSkillFiles,
  MAX_FILES_PER_SKILL,
  MAX_SKILL_BYTES,
  resolveGlobalScopeRoot,
  safeWriteFile,
  skillVersionToken,
  totalSkillBytes,
  validateRelPath,
  validateSkillMd,
  validateSkillName,
  type SkillAuthorError,
} from "./skill-common.js";
import { existsSync as fsExistsSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";

export type SkillScope = "agent" | "global";

/** Resolve whether `agent` is `admin: true` in the merged switchroom
 *  config. Used to gate global-scope writes (PR B).
 *
 *  Tests can inject `isAdminOverride` to bypass disk-loading the yaml. */
export function defaultIsAdmin(agent: string): boolean {
  try {
    const cfg = loadConfig();
    const slice = cfg.agents?.[agent] as { admin?: boolean } | undefined;
    return slice?.admin === true;
  } catch {
    return false;
  }
}

interface ScopeContext {
  scope: SkillScope;
  /** Absolute root dir for this scope (parent of all skill dirs). */
  rootDir: string;
  /** Absolute path to this specific skill's dir. */
  skillDir: string;
}

function resolveScope(
  agent: string,
  slug: string,
  scope: SkillScope | undefined,
  perAgentRoot: string | undefined,
  globalRoot: string | undefined,
  isAdminFn: (a: string) => boolean,
): ScopeContext | SkillAuthorError {
  const s: SkillScope = scope ?? "agent";
  if (s === "agent") {
    return {
      scope: "agent",
      rootDir: agentScopeSkillsRoot(agent, perAgentRoot),
      skillDir: agentScopeSkillDir(agent, slug, perAgentRoot),
    };
  }
  if (s === "global") {
    if (!isAdminFn(agent)) {
      return authorErr(
        "E_SKILL_SCOPE_DENIED",
        `global-scope skill authoring requires admin: true on agent "${agent}"`,
      );
    }
    const root = globalRoot ?? resolveGlobalScopeRoot();
    if (!fsExistsSync(root)) {
      return authorErr(
        "E_SKILL_GLOBAL_MOUNT_UNCONFIGURED",
        `global scope root ${root} is not present — the /skills-rw bind mount is missing (rebuild compose with admin: true)`,
      );
    }
    return {
      scope: "global",
      rootDir: globalScopeSkillsRoot(root),
      skillDir: globalScopeSkillDir(slug, root),
    };
  }
  return authorErr(
    "E_SKILL_SCOPE_DENIED",
    `unknown scope ${JSON.stringify(s)} — must be "agent" or "global"`,
  );
}

/**
 * Identity-pin enforcement.
 *
 * The original implementation only rejected cross-agent writes when
 * the env-pin was both set AND mismatched. That left a bypass: with
 * SWITCHROOM_AGENT_NAME unset, an attacker could pass --agent victim
 * and write into a peer's overlay. Fix: any explicit `agent` arg
 * REQUIRES the env-pin to be set AND to match. If `agent` is omitted
 * and the env-pin is unset, we also refuse (we have no idea who's
 * calling). Returns a sentinel-tagged object on failure so callers
 * can map to the right error code (E_AGENT_PIN_REQUIRED, exit 16).
 */
class AgentPinRequiredError extends Error {
  readonly kind = "pin-required" as const;
}

function resolveAgent(agent: string | undefined): string {
  const pinned = process.env.SWITCHROOM_AGENT_NAME;
  if (agent !== undefined) {
    if (!pinned) {
      throw new AgentPinRequiredError(
        `cross-agent skill writes require SWITCHROOM_AGENT_NAME to be set ` +
        `(got --agent=${agent} with no env-pin)`,
      );
    }
    if (agent !== pinned) {
      throw new AgentPinRequiredError(
        `cross-agent skill writes are denied: agent=${agent} but identity is pinned to ${pinned}`,
      );
    }
    return agent;
  }
  // No explicit agent → must have the env-pin to know who's calling.
  if (!pinned) {
    throw new AgentPinRequiredError(
      "agent name required: pass --agent (which must match SWITCHROOM_AGENT_NAME) or set SWITCHROOM_AGENT_NAME",
    );
  }
  return pinned;
}

function agentErrCode(e: unknown): SkillAuthorError {
  if (e instanceof AgentPinRequiredError) {
    return authorErr("E_AGENT_PIN_REQUIRED", e.message);
  }
  return authorErr("E_SKILL_SCOPE_DENIED", (e as Error).message);
}

// ─── skillPublish / skillUnpublish ────────────────────────────────────
//
// RFC docs/rfcs/skill-authoring-native.md §3.2/§3.5, Phase 2. The ONE
// privileged broker-backed write: promote an agent's own, already-
// iterated agent-scope skill into the operator's global pool
// (/skills-rw). Replace-by-publish of a whole directory — no per-file
// edit, no version tokens. Admin-gated; marker-guarded so operator-
// curated / peer-authored globals stay immutable from agents.

/** Best-effort fsync of a directory's dirents (marker durability
 *  before the atomic rename — RFC §3.5). Never throws. */
function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* fsync is a durability nicety, not a correctness gate */
  }
}

export interface SkillPublishOpts {
  agent?: string;
  name: string;
  /** Per-agent test root override (the publish *source* is agent scope). */
  root?: string;
  /** Global-scope root override (defaults to /skills-rw via env). */
  globalRoot?: string;
  isAdmin?: (agent: string) => boolean;
}

export interface SkillPublishResult {
  ok: true;
  slug: string;
  /** Absolute path of the published global skill dir. */
  path: string;
  files: string[];
  version: string;
}

export function skillPublish(
  opts: SkillPublishOpts,
): SkillPublishResult | SkillAuthorError {
  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }

  // Source = the agent's own agent-scope skill dir (you publish what
  // you authored natively).
  const srcDir = agentScopeSkillDir(agent, opts.name, opts.root);
  if (!existsSync(srcDir)) {
    return authorErr(
      "E_SKILL_NOT_FOUND",
      `agent-scope skill "${opts.name}" not found for ${agent} — author it first (write into $CLAUDE_CONFIG_DIR/skills/${opts.name}/), then publish`,
    );
  }
  try {
    if (lstatSync(srcDir).isSymbolicLink()) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `refuse to publish "${opts.name}" — source ${srcDir} is a symlink (bundled-skill install, not agent-authored)`,
      );
    }
  } catch {
    return authorErr("E_SKILL_NOT_FOUND", `${srcDir} missing`);
  }

  // Hard-validate the source shape. Unlike the advisory native-write
  // hook, publish is the privileged promotion gate — a malformed skill
  // must NOT reach the shared global pool.
  const files = listSkillFiles(srcDir);
  if (!files.includes("SKILL.md")) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `source skill "${opts.name}" has no SKILL.md`,
    );
  }
  for (const rel of files) {
    if (!validateRelPath(rel)) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `source file not in allowlist: ${JSON.stringify(rel)}`,
      );
    }
  }
  if (files.length > MAX_FILES_PER_SKILL) {
    return authorErr(
      "E_SKILL_BUNDLE_TOO_LARGE",
      `source skill has ${files.length} files (max ${MAX_FILES_PER_SKILL})`,
    );
  }
  const total = totalSkillBytes(srcDir);
  if (total > MAX_SKILL_BYTES) {
    return authorErr(
      "E_SKILL_BUNDLE_TOO_LARGE",
      `source skill is ${total} bytes (cap ${MAX_SKILL_BYTES})`,
    );
  }
  const skillMd = readFileSync(join(srcDir, "SKILL.md"), "utf-8");
  const fm = validateSkillMd(skillMd, opts.name);
  if ("ok" in fm && fm.ok === false) return fm;

  // Resolve GLOBAL scope: admin gate + /skills-rw mount present.
  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, "global", undefined, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const ctx = sc as ScopeContext;
  const destDir = ctx.skillDir;
  const rootDir = ctx.rootDir;

  // Marker-gated replace: if a global skill already exists at this
  // slug, it must be a real dir carrying THIS agent's marker.
  // Operator-curated (no marker) / peer-authored globals are immutable.
  if (existsSync(destDir)) {
    try {
      if (lstatSync(destDir).isSymbolicLink()) {
        return authorErr(
          "E_SKILL_INVALID_PATH",
          `global "${opts.name}" is a symlink — refuse to overwrite`,
        );
      }
    } catch {
      /* race: treat as absent below */
    }
    if (!hasAuthorshipMarker(destDir, agent)) {
      return authorErr(
        "E_SKILL_OPERATOR_OWNED",
        `global skill "${opts.name}" is not authored by ${agent} (no ${authorshipMarkerName(agent)} marker) — operator-curated or peer-authored skills are immutable`,
      );
    }
  }

  mkdirSync(rootDir, { recursive: true });

  // B2 defence: refuse if any component of rootDir is a symlink
  // (parent-walk before we materialize a stage dir under it).
  {
    const segs = rootDir.split(sep).filter((s) => s.length > 0);
    let cur = rootDir.startsWith(sep) ? sep : "";
    for (const seg of segs) {
      cur = cur === sep ? sep + seg : cur + sep + seg;
      try {
        if (lstatSync(cur).isSymbolicLink()) {
          return authorErr(
            "E_SKILL_INVALID_PATH",
            `refuse to publish under symlinked path component: ${cur}`,
          );
        }
      } catch {
        /* not-yet-created tail — fine */
      }
    }
  }

  // Atomic publish (RFC §3.5): stage → copy → stamp marker INSIDE the
  // stage dir → fsync → rename into place. The marker is written
  // BEFORE the rename so the published dir is never observable without
  // it — this is what prevents the crash-after-copy self-lockout a
  // mark-after-rename ordering would be vulnerable to.
  const uniq = `${process.pid}.${Date.now()}`;
  const stageDir = join(rootDir, `.publish-${opts.name}.${uniq}`);
  const trashDir = join(rootDir, `.trash-${opts.name}.${uniq}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    for (const rel of files) {
      const abs = join(stageDir, rel);
      const d = dirname(abs);
      if (d !== stageDir) mkdirSync(d, { recursive: true });
      const content = readFileSync(join(srcDir, rel), "utf-8");
      const r = safeWriteFile(abs, stageDir, content, "create");
      if (r && "ok" in r && r.ok === false) {
        try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
        return r;
      }
    }
    // Stamp authorship marker INSIDE the stage dir, before the rename.
    writeFileSync(
      join(stageDir, authorshipMarkerName(agent)),
      "",
      { flag: "wx", mode: 0o600 },
    );
    fsyncDirBestEffort(stageDir);

    // Swap into place: move any existing (marker-verified) dest aside,
    // rename the stage in, then drop the old copy.
    let hadOld = false;
    if (existsSync(destDir)) {
      renameSync(destDir, trashDir);
      hadOld = true;
    }
    try {
      renameSync(stageDir, destDir);
    } catch (e) {
      if (hadOld) {
        try { renameSync(trashDir, destDir); } catch { /* best-effort restore */ }
      }
      throw e;
    }
    if (hadOld) {
      try { rmSync(trashDir, { recursive: true, force: true }); } catch { /* */ }
    }
  } catch (e) {
    try { rmSync(stageDir, { recursive: true, force: true }); } catch { /* */ }
    return authorErr(
      "E_SKILL_INVALID_PATH",
      `failed to publish skill: ${(e as Error).message}`,
    );
  }

  return {
    ok: true,
    slug: opts.name,
    path: destDir,
    files,
    version: skillVersionToken(destDir),
  };
}

export interface SkillUnpublishOpts {
  agent?: string;
  name: string;
  globalRoot?: string;
  isAdmin?: (agent: string) => boolean;
}

export interface SkillUnpublishResult {
  ok: true;
  slug: string;
  path: string;
}

export function skillUnpublish(
  opts: SkillUnpublishOpts,
): SkillUnpublishResult | SkillAuthorError {
  let agent: string;
  try { agent = resolveAgent(opts.agent); }
  catch (e) { return agentErrCode(e); }

  if (!validateSkillName(opts.name)) {
    return authorErr(
      "E_SKILL_INVALID_NAME",
      `skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }

  const isAdminFn = opts.isAdmin ?? defaultIsAdmin;
  const sc = resolveScope(
    agent, opts.name, "global", undefined, opts.globalRoot, isAdminFn,
  );
  if ("ok" in sc && sc.ok === false) return sc;
  const destDir = (sc as ScopeContext).skillDir;

  if (!existsSync(destDir)) {
    return authorErr(
      "E_SKILL_NOT_FOUND",
      `global skill "${opts.name}" does not exist`,
    );
  }
  try {
    if (lstatSync(destDir).isSymbolicLink()) {
      return authorErr(
        "E_SKILL_INVALID_PATH",
        `global "${opts.name}" is a symlink — refuse to unpublish`,
      );
    }
  } catch {
    return authorErr("E_SKILL_NOT_FOUND", `${destDir} missing`);
  }
  if (!hasAuthorshipMarker(destDir, agent)) {
    return authorErr(
      "E_SKILL_OPERATOR_OWNED",
      `global skill "${opts.name}" is not authored by ${agent} (no ${authorshipMarkerName(agent)} marker) — refuse to unpublish operator-curated or peer-authored skill`,
    );
  }
  rmSync(destDir, { recursive: true, force: true });
  return { ok: true, slug: opts.name, path: destDir };
}

// ─── CLI registration ────────────────────────────────────────────────

interface AuthorCliOpts {
  agent?: string;
  name: string;
}

export function registerAgentConfigSkillAuthorCommands(program: Command): void {
  const skill = program.commands.find((c) => c.name() === "skill")
    ?? program.command("skill").description(
      "Publish / unpublish agent-authored skills to the global pool.",
    );

  function emit<T>(r: T): never | void {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
  function fail(r: SkillAuthorError, agent: string, cmd: string, args: object): never {
    process.stderr.write(JSON.stringify({ code: r.code, message: r.message }) + "\n");
    try { appendAudit(agent, cmd, { ...args, ok: false, code: r.code }, r.exit); }
    catch { /* ignore */ }
    process.exit(r.exit);
  }

  skill
    .command("publish")
    .description(
      "Promote your own agent-scope skill into the operator's global " +
      "pool (admin only). Replace-by-publish of the whole dir; " +
      "marker-gated so operator/peer globals stay immutable.",
    )
    .requiredOption("--name <slug>", "Skill slug (your agent-scope skill)")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      const r = skillPublish({ agent: opts.agent, name: opts.name });
      if (!r.ok) fail(r, resolvedAgent, "skill.publish", { name: opts.name });
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.publish",
          { name: opts.name, file_count: r.files.length }, 0);
      } catch { /* */ }
    });

  skill
    .command("unpublish")
    .description(
      "Remove a global skill you published (admin only). Marker-gated: " +
      "refuses operator-curated or peer-authored skills.",
    )
    .requiredOption("--name <slug>", "Skill slug (in the global pool)")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(async (opts: AuthorCliOpts) => {
      const resolvedAgent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? "<unknown>";
      const r = skillUnpublish({ agent: opts.agent, name: opts.name });
      if (!r.ok) fail(r, resolvedAgent, "skill.unpublish", { name: opts.name });
      emit(r);
      try {
        appendAudit(resolvedAgent, "skill.unpublish", { name: opts.name }, 0);
      } catch { /* */ }
    });

  // Re-export for symmetry with the install/remove helpers.
  void authorExitCodeFor;
}
