import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hook is a .ts that bundles to .mjs at build time; drive it
// through `bun` against source so the test doesn't depend on build
// order (mirrors server.author.test.ts). Skip cleanly if bun absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(process.cwd(), "src", "cli", "skill-validate-pretool.ts");

function run(payload: unknown): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bun", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

let tmp: string;
let skillsRoot: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-lint-"));
  // Mimic an agent's <agentDir>/.claude/skills/ tree.
  skillsRoot = join(tmp, ".claude", "skills");
  mkdirSync(join(skillsRoot, "demo"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\n# Demo\n",
  );
});

afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("skill-validate-pretool hook", () => {
  it("fails open on empty / non-JSON / unknown stdin", () => {
    if (!bunOk) return;
    for (const bad of ["", "not-json", "{}", '{"tool_name":"Read"}']) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("ignores non-edit tools and writes outside .claude/skills/", () => {
    if (!bunOk) return;
    const notEdit = run({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(notEdit.status).toBe(0);
    expect(notEdit.stdout).toBe("");

    const outside = run({
      tool_name: "Write",
      tool_input: { file_path: join(tmp, "notes.md"), content: "hi" },
    });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe("");
  });

  it("allows a well-formed SKILL.md write silently", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        content: "---\nname: demo\ndescription: a demo skill\n---\n# Demo\n",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("nudges (not blocks) on bad frontmatter — returns additionalContext", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        content: "# no frontmatter here\n",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBeUndefined(); // NOT blocked
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/frontmatter/i);
  });

  it("nudges on an out-of-allowlist path", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "scripts", "run.js"),
        content: "console.log(1)",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/allowlist/i);
  });

  it("nudges on an invalid skill slug", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "Bad Slug", "SKILL.md"),
        content: "---\nname: x\ndescription: y\n---\n",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/slug/i);
  });

  it("BLOCKS only on the per-skill byte cap", () => {
    if (!bunOk) return;
    const huge = "x".repeat(2 * 1024 * 1024 + 1024);
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "reference", "big.md"),
        content: huge,
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/per-skill cap/);
  });

  it("Edit with no content does not block (can't project — fail open)", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Edit",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        old_string: "Demo",
        new_string: "Demo 2",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("MultiEdit on a skill path with no content fails open", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        edits: [{ old_string: "a", new_string: "b" }],
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("byte-cap projection: add-to-existing blocks, shrink-overwrite allows", () => {
    if (!bunOk) return;
    // Seed a skill that already holds ~1.6 MiB.
    const bigDir = join(skillsRoot, "big");
    mkdirSync(join(bigDir, "reference"), { recursive: true });
    writeFileSync(
      join(bigDir, "SKILL.md"),
      "---\nname: big\ndescription: big skill\n---\n",
    );
    const existing = join(bigDir, "reference", "existing.md");
    writeFileSync(existing, "y".repeat(1.6 * 1024 * 1024));

    // Adding a new ~0.6 MiB file pushes the total past 2 MiB → block,
    // even though the new file alone is well under the cap (proves the
    // projection sums the existing dir, not just the new content).
    const add = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(bigDir, "reference", "more.md"),
        content: "z".repeat(0.6 * 1024 * 1024),
      },
    });
    const addOut = JSON.parse(add.stdout);
    expect(addOut.decision).toBe("block");
    expect(addOut.reason).toMatch(/per-skill cap/);

    // Overwriting the existing 1.6 MiB file with tiny content nets the
    // skill far below the cap → allowed (proves it subtracts the
    // target file's current size before adding the new content).
    const shrink = run({
      tool_name: "Write",
      tool_input: { file_path: existing, content: "small" },
    });
    expect(shrink.status).toBe(0);
    expect(shrink.stdout).toBe("");
  });

  it("a path containing .claude/skills/ twice never wrong-blocks", () => {
    if (!bunOk) return;
    // Pathological: first occurrence wins → slug "docs". Worst case is
    // a spurious advisory nudge; it must never block and the write
    // must proceed (no decision:block).
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(
          skillsRoot,
          "docs",
          ".claude",
          "skills",
          "demo",
          "SKILL.md",
        ),
        content: "---\nname: demo\ndescription: d\n---\n",
      },
    });
    expect(r.status).toBe(0);
    if (r.stdout) {
      expect(JSON.parse(r.stdout).decision).toBeUndefined();
    }
  });
});
