/**
 * `switchroom skill install|remove` — the WRITE half of the agent-config
 * broker's skill self-service surface (#1163 Phase 2).
 *
 * Mirrors `agent-config-write.ts` (schedule_add / schedule_remove) but
 * for skills:
 *   - Writes land in `~/.switchroom/agents/<name>/skills.d/<slug>.yaml`
 *     via `overlay-writer.ts:writeSkillsOverlayEntry`.
 *   - The overlay-loader picks them up on next config-resolve cycle and
 *     unions them into `agents.<name>.skills`.
 *   - A subsequent `agent reconcile` materializes the symlinks in the
 *     agent's `.claude/skills/<name>` dir.
 *
 * v1 source allow-list: ONLY `bundled:<name>` accepted. Git-pinned-SHA
 * sources are designed in #1163 but defer to a follow-up (needs clone
 * + SHA verification + audit-log shape). `file://` / `local-path:`
 * from agents are explicitly rejected per the issue's security model.
 *
 * Error codes:
 *   - E_SKILL_SOURCE_NOT_SUPPORTED — source format not in v1 allow-list (exit 9)
 *   - E_SKILL_NOT_FOUND            — bundled:<name> but skill doesn't exist (exit 9)
 *   - E_SKILL_QUOTA_EXCEEDED       — agent at 20 skills (exit 9)
 *   - E_INVALID_SKILL_NAME         — name fails [a-z0-9-]{1,40} (exit 1)
 *   - E_NOT_FOUND                  — skill_remove can't find entry (exit 1)
 *   - E_INTERNAL                   — write/lock failure (exit 1)
 *   - E_RECONCILE_FAILED           — write succeeded, reconcile didn't (exit 10)
 */

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { stringify as yamlStringify } from "yaml";
import {
  writeSkillsOverlayEntry,
  deleteSkillsOverlayEntry,
  listSkillsOverlayEntries,
} from "../config/overlay-writer.js";
import { getBundledSkillsPoolDir } from "../agents/reconcile-default-skills.js";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ReconcileFn } from "./agent-config-write.js";
import { appendAudit, restartRequiredNote } from "./agent-config.js";

/** Per-agent skill cap. Matches the schedule cap (20). */
export const MAX_SKILLS_PER_AGENT = 20;

/** Allowed source prefixes for v1. `git+https://...@<pinned-sha>` is
 *  designed but deferred to a follow-up PR. */
const V1_ALLOWED_SOURCE_PREFIX = "bundled:";

export type SkillErrorCode =
  | "E_SKILL_SOURCE_NOT_SUPPORTED"
  | "E_SKILL_NOT_FOUND"
  | "E_SKILL_QUOTA_EXCEEDED"
  | "E_INVALID_SKILL_NAME"
  | "E_NOT_FOUND"
  | "E_INTERNAL"
  | "E_RECONCILE_FAILED";

export interface SkillInstallOpts {
  agent?: string;
  /** Source descriptor — v1 accepts only `bundled:<skill-name>`. */
  source: string;
  /** Optional override name (slug). Defaults to the source's skill name. */
  name?: string;
  /** Test-only: override overlay root. */
  root?: string;
  /** Test-only: override the bundled-skills-pool directory. */
  bundledSkillsPoolDir?: string;
  /** Test-only: override reconcile trigger. */
  reconcile?: ReconcileFn | null;
}

export interface SkillRemoveOpts {
  agent?: string;
  name: string;
  root?: string;
  reconcile?: ReconcileFn | null;
}

export interface SkillResult {
  ok: true;
  slug: string;
  path: string;
  source: string;
  resolved_skill_name: string;
  would_recreate: false;
  /** On disk + reconciled, but claude loads skills at process start —
   *  not live until the agent restarts (skill hot-reload is unbuilt
   *  Phase C; see lifecycle.ts:classifyChangeKind). */
  restart_required: true;
  restart_hint: string;
}

export interface SkillErrorResult {
  ok: false;
  code: SkillErrorCode;
  message: string;
  exit: number;
}

function exitCodeFor(code: SkillErrorCode): number {
  switch (code) {
    case "E_SKILL_SOURCE_NOT_SUPPORTED":
    case "E_SKILL_NOT_FOUND":
    case "E_SKILL_QUOTA_EXCEEDED":
      return 9;
    case "E_INVALID_SKILL_NAME":
    case "E_NOT_FOUND":
    case "E_INTERNAL":
      return 1;
    case "E_RECONCILE_FAILED":
      return 10;
  }
}

function err(code: SkillErrorCode, message: string): SkillErrorResult {
  return { ok: false, code, message, exit: exitCodeFor(code) };
}

function resolveAgentName(agent: string | undefined): string {
  const a = agent ?? process.env.SWITCHROOM_AGENT_NAME;
  if (!a) {
    throw new Error(
      "agent name required: pass --agent or set SWITCHROOM_AGENT_NAME",
    );
  }
  // Cross-agent denial — matches schedule_add's identity gate.
  const pinned = process.env.SWITCHROOM_AGENT_NAME;
  if (pinned && a !== pinned) {
    throw new Error(
      `cross-agent skill writes are denied: agent=${a} but identity is pinned to ${pinned}`,
    );
  }
  return a;
}

/**
 * Parse a source descriptor like `bundled:webapp-testing`. Returns the
 * derived skill name + the kind, or an error result.
 */
function parseSkillSource(
  source: string,
): { kind: "bundled"; name: string } | SkillErrorResult {
  if (typeof source !== "string" || source.length === 0) {
    return err(
      "E_SKILL_SOURCE_NOT_SUPPORTED",
      "source must be a non-empty string",
    );
  }
  if (!source.startsWith(V1_ALLOWED_SOURCE_PREFIX)) {
    return err(
      "E_SKILL_SOURCE_NOT_SUPPORTED",
      `source format not supported in v1: ${JSON.stringify(source)}. ` +
        `Allowed: ${V1_ALLOWED_SOURCE_PREFIX}<skill-name> (git+https://...@<pinned-sha> ` +
        `is designed but deferred to a follow-up). file:// / local-path: ` +
        `are explicitly rejected.`,
    );
  }
  const name = source.slice(V1_ALLOWED_SOURCE_PREFIX.length);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name)) {
    return err(
      "E_INVALID_SKILL_NAME",
      `bundled skill name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(name)}`,
    );
  }
  return { kind: "bundled", name };
}

function countCurrentSkills(
  agent: string,
  opts: { root?: string },
): number {
  // Existing overlay entries — each YAML file may declare multiple
  // skill names, so sum across files.
  const entries = listSkillsOverlayEntries(agent, opts);
  let total = 0;
  for (const e of entries) {
    try {
      const doc = parseYaml(e.raw) as { skills?: string[] } | null;
      total += (doc?.skills ?? []).length;
    } catch {
      /* skip bad file */
    }
  }
  return total;
}

/** Install a skill into the agent's overlay. */
export function skillInstall(opts: SkillInstallOpts): SkillResult | SkillErrorResult {
  let agent: string;
  try {
    agent = resolveAgentName(opts.agent);
  } catch (e) {
    return err("E_INTERNAL", (e as Error).message);
  }

  const parsed = parseSkillSource(opts.source);
  if ("ok" in parsed && parsed.ok === false) return parsed;
  const skillName = (parsed as { name: string }).name;

  // Slug: defaults to the skill name. Override via opts.name (rare).
  const slug = opts.name ?? skillName;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(slug)) {
    return err(
      "E_INVALID_SKILL_NAME",
      `slug must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(slug)}`,
    );
  }

  // Quota check BEFORE we touch disk — operator-friendly fail-fast.
  const used = countCurrentSkills(agent, { root: opts.root });
  if (used >= MAX_SKILLS_PER_AGENT) {
    return err(
      "E_SKILL_QUOTA_EXCEEDED",
      `agent ${agent} already has ${used} overlay-installed skills (cap ${MAX_SKILLS_PER_AGENT})`,
    );
  }

  // Existence check for bundled sources. Reading from the host
  // bundled-skills-pool dir; this is operator-visible and the same
  // pool the compose generator mounts into the agent container.
  const poolDir = opts.bundledSkillsPoolDir ?? getBundledSkillsPoolDir();
  const skillPath = join(poolDir, skillName);
  if (!existsSync(skillPath)) {
    return err(
      "E_SKILL_NOT_FOUND",
      `bundled skill not found at ${skillPath}. The operator needs to ` +
        `place the skill at this path before the agent can opt in.`,
    );
  }

  // Compose the overlay YAML and write atomically.
  const yamlText = yamlStringify({ skills: [skillName] });
  let path: string;
  try {
    path = writeSkillsOverlayEntry(agent, slug, yamlText, { root: opts.root });
  } catch (e) {
    return err(
      "E_INTERNAL",
      `overlay write failed: ${(e as Error).message}`,
    );
  }

  // Reconcile trigger — see agent-config-write.ts:ReconcileFn for
  // the contract. When DI'd to null (tests) we skip; otherwise the
  // production hot-apply bridge regenerates the agent's
  // .claude/skills/ symlinks live.
  if (opts.reconcile !== null) {
    const reconcileFn = opts.reconcile;
    if (reconcileFn) {
      const rr = reconcileFn(agent);
      if (!rr.ok) {
        // Rollback: delete the file we just wrote.
        try {
          deleteSkillsOverlayEntry(agent, slug, { root: opts.root });
        } catch {
          /* best-effort */
        }
        return err(
          "E_RECONCILE_FAILED",
          `overlay write succeeded but reconcile failed: ${rr.error}`,
        );
      }
    }
  }

  return {
    ok: true,
    slug,
    path,
    source: opts.source,
    resolved_skill_name: skillName,
    would_recreate: false,
    restart_required: true,
    restart_hint: restartRequiredNote(agent),
  };
}

/** Remove a skill from the agent's overlay. */
export interface SkillRemoveResult {
  ok: true;
  slug: string;
  restart_required: true;
  restart_hint: string;
}

export function skillRemove(opts: SkillRemoveOpts): SkillRemoveResult | SkillErrorResult {
  let agent: string;
  try {
    agent = resolveAgentName(opts.agent);
  } catch (e) {
    return err("E_INTERNAL", (e as Error).message);
  }
  if (!opts.name || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(opts.name)) {
    return err(
      "E_INVALID_SKILL_NAME",
      `name must match [a-z0-9][a-z0-9_-]{0,62}: got ${JSON.stringify(opts.name)}`,
    );
  }
  const slug = opts.name;
  let priorContent: string | null = null;
  try {
    const entry = listSkillsOverlayEntries(agent, { root: opts.root }).find(
      (e) => e.slug === slug,
    );
    if (!entry) {
      return err(
        "E_NOT_FOUND",
        `no overlay-managed skill entry named ${JSON.stringify(slug)} for agent ${agent}`,
      );
    }
    priorContent = entry.raw;
    deleteSkillsOverlayEntry(agent, slug, { root: opts.root });
  } catch (e) {
    return err(
      "E_INTERNAL",
      `overlay delete failed: ${(e as Error).message}`,
    );
  }
  if (opts.reconcile !== null) {
    const reconcileFn = opts.reconcile;
    if (reconcileFn) {
      const rr = reconcileFn(agent);
      if (!rr.ok) {
        // Rollback: restore the file.
        try {
          if (priorContent !== null) {
            writeSkillsOverlayEntry(agent, slug, priorContent, { root: opts.root });
          }
        } catch {
          /* best-effort */
        }
        return err(
          "E_RECONCILE_FAILED",
          `overlay delete succeeded but reconcile failed: ${rr.error}`,
        );
      }
    }
  }
  return {
    ok: true,
    slug,
    restart_required: true,
    restart_hint: restartRequiredNote(agent),
  };
}

export function registerAgentConfigSkillWriteCommands(program: Command): void {
  // The `skill` parent command was already registered by
  // `registerAgentConfigCommands` (for `skill list`). Find the existing
  // node and hang our `install` / `remove` subcommands off it instead
  // of trying to re-register, which would throw "cannot add command
  // 'skill' as already have command 'skill'".
  const skill = program.commands.find((c) => c.name() === "skill")
    ?? program.command("skill").description(
      "Add / remove an agent's overlay-installed skills (#1163 Phase 2).",
    );

  skill
    .command("install")
    .description("Install a bundled skill into the agent's overlay")
    .requiredOption(
      "--source <source>",
      `Source descriptor. v1: bundled:<skill-name>. ` +
        `git+https://...@<pinned-sha> is designed but deferred.`,
    )
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .option("--name <slug>", "Optional override slug (defaults to the skill name)")
    .action(async (opts: { agent?: string; source: string; name?: string }) => {
      let r: SkillResult | SkillErrorResult;
      let resolvedAgent = opts.agent ?? "<unknown>";
      try {
        r = skillInstall({
          agent: opts.agent,
          source: opts.source,
          name: opts.name,
        });
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        try {
          appendAudit(resolvedAgent, "skill.install", { ...opts, ok: false }, 7);
        } catch { /* ignore */ }
        process.exit(7);
      }
      if (opts.agent) resolvedAgent = opts.agent;
      else if (process.env.SWITCHROOM_AGENT_NAME) {
        resolvedAgent = process.env.SWITCHROOM_AGENT_NAME;
      }
      if (!r.ok) {
        process.stderr.write(JSON.stringify({ code: r.code, message: r.message }) + "\n");
        try {
          appendAudit(
            resolvedAgent,
            "skill.install",
            { ...opts, ok: false, code: r.code },
            r.exit,
          );
        } catch { /* ignore */ }
        process.exit(r.exit);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        slug: r.slug,
        path: r.path,
        source: r.source,
        resolved_skill_name: r.resolved_skill_name,
        restart_required: r.restart_required,
        restart_hint: r.restart_hint,
      }) + "\n");
      try {
        appendAudit(
          resolvedAgent,
          "skill.install",
          { source: opts.source, slug: r.slug, resolved_skill_name: r.resolved_skill_name },
          0,
        );
      } catch { /* ignore */ }
    });

  skill
    .command("remove")
    .description("Remove an overlay-installed skill by name")
    .requiredOption("--name <slug>", "Slug passed at install time")
    .option("--agent <name>", "Target agent (defaults to $SWITCHROOM_AGENT_NAME)")
    .action(async (opts: { agent?: string; name: string }) => {
      let r: SkillRemoveResult | SkillErrorResult;
      let resolvedAgent = opts.agent ?? "<unknown>";
      try {
        r = skillRemove({ agent: opts.agent, name: opts.name });
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
        try {
          appendAudit(resolvedAgent, "skill.remove", { ...opts, ok: false }, 7);
        } catch { /* ignore */ }
        process.exit(7);
      }
      if (opts.agent) resolvedAgent = opts.agent;
      else if (process.env.SWITCHROOM_AGENT_NAME) {
        resolvedAgent = process.env.SWITCHROOM_AGENT_NAME;
      }
      if (!r.ok) {
        process.stderr.write(JSON.stringify({ code: r.code, message: r.message }) + "\n");
        try {
          appendAudit(
            resolvedAgent,
            "skill.remove",
            { ...opts, ok: false, code: r.code },
            r.exit,
          );
        } catch { /* ignore */ }
        process.exit(r.exit);
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        slug: r.slug,
        restart_required: r.restart_required,
        restart_hint: r.restart_hint,
      }) + "\n");
      try {
        appendAudit(resolvedAgent, "skill.remove", { slug: r.slug }, 0);
      } catch { /* ignore */ }
    });
}
