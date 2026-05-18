/**
 * Shared skill-shape validators.
 *
 * Skill authoring is Claude-native — agents just write files into
 * `$CLAUDE_CONFIG_DIR/skills/<slug>/` (no broker, no CLI). These pure
 * validators are the single source of truth for "is this a well-formed
 * skill", consumed by the non-blocking PreToolUse linter
 * (`skill-validate-pretool.ts`):
 *   - `validateSkillName`  — slug pattern.
 *   - `validateRelPath`    — path allowlist (SKILL.md, README.md,
 *     scripts/*.{sh,py}, assets/*, reference/*.md; max depth 3).
 *   - `validateSkillMd`    — SKILL.md frontmatter (name == slug,
 *     description 1..MAX_DESCRIPTION_LEN).
 *   - `MAX_SKILL_BYTES`    — per-skill aggregate cap (the one hard cap).
 *
 * Sharing a skill fleet-wide is NOT a runtime path: it is a reviewed
 * PR that lands the skill as a bundled default (opt-out per agent via
 * `bundled_skills`) or a `skills:`-cascade entry sourced from the
 * operator's `switchroom.skills_dir`. See docs/skills.md.
 */

import { parse as parseYaml } from "yaml";

/** Per-agent skill cap (matches install cap). Not enforced in PR A. */
export const MAX_SKILLS_PER_AGENT = 20;

/** Per-file size cap for authored skill files. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Per-skill aggregate cap. */
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

/** Per-skill file count cap. */
export const MAX_FILES_PER_SKILL = 50;

/** Max path depth (number of segments) for a skill-relative path. */
export const MAX_PATH_DEPTH = 3;

/** Max length of the YAML `description:` field in SKILL.md. */
export const MAX_DESCRIPTION_LEN = 1024;

export type SkillAuthorErrorCode =
  | "E_SKILL_SCOPE_DENIED"
  | "E_SKILL_INVALID_NAME"
  | "E_SKILL_INVALID_PATH"
  | "E_SKILL_INVALID_FRONTMATTER"
  | "E_SKILL_FILE_TOO_LARGE"
  | "E_SKILL_BUNDLE_TOO_LARGE"
  | "E_SKILL_ALREADY_EXISTS"
  | "E_SKILL_NOT_FOUND"
  | "E_AGENT_PIN_REQUIRED"
  | "E_SKILL_OPERATOR_OWNED"
  | "E_SKILL_GLOBAL_MOUNT_UNCONFIGURED";

export interface SkillAuthorError {
  ok: false;
  code: SkillAuthorErrorCode;
  message: string;
  exit: number;
}

export function authorExitCodeFor(code: SkillAuthorErrorCode): number {
  switch (code) {
    case "E_SKILL_ALREADY_EXISTS":
      return 13;
    case "E_SKILL_NOT_FOUND":
      return 14;
    case "E_SKILL_FILE_TOO_LARGE":
    case "E_SKILL_BUNDLE_TOO_LARGE":
      return 15;
    case "E_SKILL_INVALID_NAME":
    case "E_SKILL_INVALID_PATH":
    case "E_SKILL_INVALID_FRONTMATTER":
    case "E_SKILL_SCOPE_DENIED":
      return 9;
    case "E_AGENT_PIN_REQUIRED":
      return 16;
    case "E_SKILL_GLOBAL_MOUNT_UNCONFIGURED":
      return 17;
    case "E_SKILL_OPERATOR_OWNED":
      return 18;
  }
}


export function authorErr(
  code: SkillAuthorErrorCode,
  message: string,
): SkillAuthorError {
  return { ok: false, code, message, exit: authorExitCodeFor(code) };
}

/** Validate the agent slug / skill name against the canonical pattern. */
export function validateSkillName(name: unknown): name is string {
  return typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(name);
}

/** Validate a skill-relative path.
 *
 *  Allowlist:
 *    - SKILL.md (root)
 *    - README.md (root)
 *    - scripts/<file>.{sh,py}
 *    - assets/<...>            (max-depth 3 incl. assets/)
 *    - reference/<file>.md
 *
 *  Rejected: absolute paths, `..` segments, leading `/`, NUL,
 *  windows-style drive letters, depth > 3, empty segments.
 */
export function validateRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false; // C:\ etc.
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  if (parts.length > MAX_PATH_DEPTH) return false;
  for (const seg of parts) {
    if (seg === "" || seg === "." || seg === "..") return false;
    if (seg.startsWith(".")) return false; // no dotfiles
  }
  // Allowlist check.
  if (parts.length === 1) {
    return parts[0] === "SKILL.md" || parts[0] === "README.md";
  }
  if (parts.length === 2) {
    const [dir, file] = parts;
    if (dir === "scripts") return /^[A-Za-z0-9_.-]+\.(sh|py)$/.test(file!);
    if (dir === "assets") return /^[A-Za-z0-9_.-]+$/.test(file!);
    if (dir === "reference") return /^[A-Za-z0-9_.-]+\.md$/.test(file!);
    return false;
  }
  if (parts.length === 3) {
    // Only assets/<subdir>/<file> permitted at depth 3.
    if (parts[0] !== "assets") return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[1]!)) return false;
    if (!/^[A-Za-z0-9_.-]+$/.test(parts[2]!)) return false;
    return true;
  }
  return false;
}

/**
 * Parse YAML frontmatter from SKILL.md and validate the required keys.
 *
 *  Returns the parsed frontmatter object on success, or an error result.
 *  Required keys: `name` (must equal `expectedName`) and `description`
 *  (1..MAX_DESCRIPTION_LEN chars). Rejects duplicate top-level keys
 *  by re-parsing the frontmatter block as text.
 */
export function validateSkillMd(
  content: string,
  expectedName: string,
):
  | { ok: true; frontmatter: Record<string, unknown> }
  | SkillAuthorError {
  if (typeof content !== "string" || content.length === 0) {
    return authorErr("E_SKILL_INVALID_FRONTMATTER", "SKILL.md is empty");
  }
  // Frontmatter must start at byte 0 with `---\n`.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "SKILL.md must begin with YAML frontmatter delimited by `---`",
    );
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endIdx = rest.indexOf("\n---");
  if (endIdx < 0) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "SKILL.md frontmatter has no closing `---`",
    );
  }
  const fmText = rest.slice(0, endIdx);

  // Duplicate-key detection: cheap line scan of top-level `key:` lines.
  const seen = new Set<string>();
  for (const line of fmText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (seen.has(key)) {
      return authorErr(
        "E_SKILL_INVALID_FRONTMATTER",
        `duplicate frontmatter key: ${key}`,
      );
    }
    seen.add(key);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fmText);
  } catch (e) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter is not valid YAML: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      "frontmatter must be a YAML mapping",
    );
  }
  const fm = parsed as Record<string, unknown>;
  if (fm.name !== expectedName) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter name=${JSON.stringify(fm.name)} must equal the skill slug ${JSON.stringify(expectedName)}`,
    );
  }
  const desc = fm.description;
  if (
    typeof desc !== "string" ||
    desc.length < 1 ||
    desc.length > MAX_DESCRIPTION_LEN
  ) {
    return authorErr(
      "E_SKILL_INVALID_FRONTMATTER",
      `frontmatter description must be a string 1..${MAX_DESCRIPTION_LEN} chars`,
    );
  }
  return { ok: true, frontmatter: fm };
}


