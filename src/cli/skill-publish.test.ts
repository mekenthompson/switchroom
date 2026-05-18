import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillPublish, skillUnpublish } from "./agent-config-skill-author.js";

const AGENT = "alice";
const ADMIN = () => true;

let tmp: string;
let agentRoot: string; // SkillPublishOpts.root → <root>/<agent>/.claude/skills
let globalRoot: string; // SkillPublishOpts.globalRoot → /skills-rw stand-in
let savedPin: string | undefined;

function srcSkillDir(slug: string): string {
  return join(agentRoot, AGENT, ".claude", "skills", slug);
}

function seedSource(
  slug: string,
  files: Record<string, string> = {
    "SKILL.md": `---\nname: ${slug}\ndescription: a ${slug} skill\n---\n# ${slug}\n`,
  },
): void {
  const dir = srcSkillDir(slug);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-publish-"));
  agentRoot = join(tmp, "agents");
  globalRoot = join(tmp, "skills-rw");
  mkdirSync(globalRoot, { recursive: true });
  savedPin = process.env.SWITCHROOM_AGENT_NAME;
  process.env.SWITCHROOM_AGENT_NAME = AGENT;
});

afterEach(() => {
  if (savedPin === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
  else process.env.SWITCHROOM_AGENT_NAME = savedPin;
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("skillPublish", () => {
  it("publishes an own agent-scope skill into the global pool with a marker", () => {
    seedSource("demo", {
      "SKILL.md": "---\nname: demo\ndescription: d\n---\n# Demo\n",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "reference/notes.md": "# notes\n",
    });
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok).toBe(true);
    if (!("ok" in r) || !r.ok) return;
    const dest = join(globalRoot, "demo");
    expect(r.path).toBe(dest);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(dest, "reference", "notes.md"))).toBe(true);
    // Marker stamped (RFC §3.5 — present in the published dir).
    expect(existsSync(join(dest, `.authored-by-${AGENT}`))).toBe(true);
    expect(r.files).toEqual(
      expect.arrayContaining(["SKILL.md", "scripts/run.sh", "reference/notes.md"]),
    );
    // No staging / trash residue in the pool root.
    const residue = readdirSync(globalRoot).filter(
      (n) => n.startsWith(".publish-") || n.startsWith(".trash-"),
    );
    expect(residue).toEqual([]);
  });

  it("re-publish overwrites an own (marker-carrying) global skill", () => {
    seedSource("demo", {
      "SKILL.md": "---\nname: demo\ndescription: v1\n---\n# v1\n",
    });
    expect(
      skillPublish({ name: "demo", root: agentRoot, globalRoot, isAdmin: ADMIN })
        .ok,
    ).toBe(true);

    seedSource("demo", {
      "SKILL.md": "---\nname: demo\ndescription: v2\n---\n# v2\n",
    });
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok).toBe(true);
    const body = readFileSync(join(globalRoot, "demo", "SKILL.md"), "utf-8");
    expect(body).toContain("description: v2");
    expect(existsSync(join(globalRoot, "demo", `.authored-by-${AGENT}`))).toBe(
      true,
    );
    expect(
      readdirSync(globalRoot).filter(
        (n) => n.startsWith(".publish-") || n.startsWith(".trash-"),
      ),
    ).toEqual([]);
  });

  it("refuses to overwrite an operator-curated global (no marker)", () => {
    // Pre-existing global skill with NO authorship marker.
    const dest = join(globalRoot, "demo");
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      join(dest, "SKILL.md"),
      "---\nname: demo\ndescription: operator\n---\n# operator\n",
    );
    seedSource("demo");
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false).toBe(true);
    if (!("ok" in r) || r.ok !== false) return;
    expect(r.code).toBe("E_SKILL_OPERATOR_OWNED");
    // Untouched.
    expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain(
      "description: operator",
    );
  });

  it("refuses to overwrite a peer-authored global", () => {
    const dest = join(globalRoot, "demo");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: demo\ndescription: p\n---\n");
    writeFileSync(join(dest, ".authored-by-bob"), "");
    seedSource("demo");
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_OPERATOR_OWNED");
  });

  it("E_SKILL_NOT_FOUND when the agent has no such skill", () => {
    const r = skillPublish({
      name: "ghost",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_NOT_FOUND");
  });

  it("rejects a malformed source SKILL.md", () => {
    seedSource("demo", { "SKILL.md": "# no frontmatter\n" });
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe(
      "E_SKILL_INVALID_FRONTMATTER",
    );
    expect(existsSync(join(globalRoot, "demo"))).toBe(false);
  });

  it("rejects a source file outside the path allowlist", () => {
    seedSource("demo", {
      "SKILL.md": "---\nname: demo\ndescription: d\n---\n",
      "scripts/run.js": "console.log(1)",
    });
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_INVALID_PATH");
  });

  it("enforces the per-skill byte cap", () => {
    seedSource("demo", {
      "SKILL.md": "---\nname: demo\ndescription: d\n---\n",
      "reference/big.md": "x".repeat(2 * 1024 * 1024 + 16),
    });
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe(
      "E_SKILL_BUNDLE_TOO_LARGE",
    );
  });

  it("requires admin", () => {
    seedSource("demo");
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: () => false,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_SCOPE_DENIED");
  });

  it("E_SKILL_GLOBAL_MOUNT_UNCONFIGURED when /skills-rw is absent", () => {
    seedSource("demo");
    const r = skillPublish({
      name: "demo",
      root: agentRoot,
      globalRoot: join(tmp, "does-not-exist"),
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe(
      "E_SKILL_GLOBAL_MOUNT_UNCONFIGURED",
    );
  });

  it("enforces the identity pin", () => {
    seedSource("demo");
    const r = skillPublish({
      agent: "bob", // != SWITCHROOM_AGENT_NAME (alice)
      name: "demo",
      root: agentRoot,
      globalRoot,
      isAdmin: ADMIN,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_AGENT_PIN_REQUIRED");
  });
});

describe("skillUnpublish", () => {
  it("removes a global skill the agent published", () => {
    seedSource("demo");
    expect(
      skillPublish({ name: "demo", root: agentRoot, globalRoot, isAdmin: ADMIN })
        .ok,
    ).toBe(true);
    const r = skillUnpublish({ name: "demo", globalRoot, isAdmin: ADMIN });
    expect("ok" in r && r.ok).toBe(true);
    expect(existsSync(join(globalRoot, "demo"))).toBe(false);
  });

  it("refuses to unpublish an operator-curated skill (no marker)", () => {
    const dest = join(globalRoot, "demo");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: demo\ndescription: o\n---\n");
    const r = skillUnpublish({ name: "demo", globalRoot, isAdmin: ADMIN });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_OPERATOR_OWNED");
    expect(existsSync(dest)).toBe(true);
  });

  it("refuses to unpublish a peer-authored skill", () => {
    const dest = join(globalRoot, "demo");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "---\nname: demo\ndescription: p\n---\n");
    writeFileSync(join(dest, ".authored-by-bob"), "");
    const r = skillUnpublish({ name: "demo", globalRoot, isAdmin: ADMIN });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_OPERATOR_OWNED");
    expect(existsSync(dest)).toBe(true);
  });

  it("E_SKILL_NOT_FOUND for a slug not in the pool", () => {
    const r = skillUnpublish({ name: "ghost", globalRoot, isAdmin: ADMIN });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_NOT_FOUND");
  });

  it("requires admin", () => {
    const r = skillUnpublish({
      name: "demo",
      globalRoot,
      isAdmin: () => false,
    });
    expect("ok" in r && r.ok === false && r.code).toBe("E_SKILL_SCOPE_DENIED");
  });
});
