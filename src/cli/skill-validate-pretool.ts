/**
 * PreToolUse hook — RFC "native-by-default skill authoring", Phase 1.
 *
 * Fires on Write / Edit / MultiEdit. When the target path is inside an
 * agent's own `.claude/skills/<slug>/` tree it lints the write against
 * the same skill-shape rules the (deprecated) `skill_*` MCP tools
 * enforced — but **advisory only**: it never blocks a malformed skill,
 * it returns `additionalContext` so the model self-corrects. The one
 * hard stop is the per-skill byte cap (`MAX_SKILL_BYTES`), the only
 * rule with real blast radius (a runaway write filling the agent's
 * persistent volume).
 *
 * Why a hook and not a CLI: agent-scope skills live in the agent's own
 * writable, persistent, reconcile-safe dir — the native authoring path
 * is plain Write/Edit. The shared validators in `skill-common.ts` are
 * the single source of truth; this hook calls them directly (bundled
 * to a self-contained .mjs at build time, like drive-write-pretool).
 *
 * Claude Code PreToolUse protocol (v1), mirrors drive-write-pretool:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow.
 *           exit 0 + {"decision":"block","reason":...}  → block.
 *           exit 0 + {"hookSpecificOutput":{...,additionalContext}}
 *                                                       → allow + nudge.
 *
 * Fail-OPEN everywhere (stdin parse error, fs error, unknown shape):
 * a lint hook must never be the reason a legitimate write fails. The
 * only non-allow outcome is the explicit oversize block.
 */

import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_SKILL_BYTES,
  validateSkillName,
  validateRelPath,
  validateSkillMd,
} from "./skill-common.js";

const SKILLS_SEGMENT = "/.claude/skills/";
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  const safe = String(reason)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  process.stdout.write(JSON.stringify({ decision: "block", reason: safe }));
  process.exit(0);
}

function nudge(lines: string[]): never {
  const context =
    "skill-lint (advisory — the write was allowed):\n" +
    lines.map((l) => `  • ${l}`).join("\n") +
    "\nThese are the same rules the deprecated skill_* MCP tools " +
    "enforced. Fix them so the skill is well-formed and discoverable " +
    "on your next turn.";
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    }),
  );
  process.exit(0);
}

/** Total bytes of regular files under `dir` (recursive, symlink-safe,
 *  best-effort). Returns 0 on any error — fail-open. */
function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) total += dirBytes(p);
      else if (st.isFile()) total += st.size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

function fileSize(p: string): number {
  try {
    const st = lstatSync(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function main(): void {
  const raw = readStdin().trim();
  if (!raw) allow();

  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // Claude protocol error — not ours to police.
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (!EDIT_TOOLS.has(toolName)) allow();

  const input =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as Record<string, unknown>)
      : {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) allow();

  const segIdx = filePath.indexOf(SKILLS_SEGMENT);
  if (segIdx < 0) allow(); // not a skill write

  const afterSkills = filePath.slice(segIdx + SKILLS_SEGMENT.length);
  const segs = afterSkills.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) allow(); // writing the skills root or a bare slug dir

  const slug = segs[0]!;
  const relPath = segs.slice(1).join("/");
  const skillDir = filePath.slice(0, segIdx + SKILLS_SEGMENT.length) + slug;

  const warnings: string[] = [];
  if (!validateSkillName(slug)) {
    warnings.push(
      `skill slug "${slug}" is invalid — must match ` +
        `[a-z0-9][a-z0-9_-]{0,62}. Claude won't discover a skill at an ` +
        `invalid slug.`,
    );
  }
  if (!validateRelPath(relPath)) {
    warnings.push(
      `"${relPath}" is outside the skill path allowlist ` +
        `(SKILL.md, README.md, scripts/*.{sh,py}, assets/*, ` +
        `reference/*.md, max depth 3). The file will be written but ` +
        `won't be part of a well-formed skill bundle.`,
    );
  }
  if (
    relPath === "SKILL.md" &&
    toolName === "Write" &&
    typeof input.content === "string"
  ) {
    const r = validateSkillMd(input.content, slug);
    if ("ok" in r && r.ok === false) {
      warnings.push(`SKILL.md frontmatter: ${r.message}`);
    }
  }

  // Hard cap — the only blocking rule. Project the new total when we
  // can (Write carries full content); for Edit/MultiEdit we only have
  // the current on-disk total, so we block solely if already over.
  try {
    const existingTotal = dirBytes(skillDir);
    let projected = existingTotal;
    if (toolName === "Write" && typeof input.content === "string") {
      projected =
        existingTotal -
        fileSize(filePath) +
        Buffer.byteLength(input.content, "utf8");
    }
    if (projected > MAX_SKILL_BYTES) {
      block(
        `skill "${slug}" would be ${projected} bytes, over the ` +
          `${MAX_SKILL_BYTES}-byte per-skill cap. Trim the skill ` +
          `(split large assets out, or shorten SKILL.md) and retry.`,
      );
    }
  } catch {
    /* fail-open: a sizing error must not block a write */
  }

  if (warnings.length > 0) nudge(warnings);
  allow();
}

main();
