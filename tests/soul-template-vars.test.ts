import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Invariant: every profile's `workspace/SOUL.md.hbs` references ONLY
 * the `soul` context object (and Handlebars control helpers). This is
 * load-bearing: `renderSoulMd` in src/agents/scaffold.ts renders with a
 * `{ soul }`-only context for both seed-time and `switchroom soul
 * reset`. If a SOUL template starts consuming another key (e.g.
 * `{{name}}` or `{{topicName}}`), the lean render context would emit ""
 * for it and the persona would silently degrade — this test fails loud
 * instead.
 */

const PROFILES_DIR = join(__dirname, "..", "profiles");
const BLOCK_HELPERS = new Set(["if", "unless", "each", "with"]);

function soulTemplates(): string[] {
  return readdirSync(PROFILES_DIR)
    .map((p) => join(PROFILES_DIR, p, "workspace", "SOUL.md.hbs"))
    .filter((p) => existsSync(p));
}

function offendingTokens(src: string): string[] {
  const bad: string[] = [];
  const mustache = /\{\{([^}]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = mustache.exec(src)) !== null) {
    // Strip block/partial/escape sigils and surrounding whitespace.
    const inner = m[1].replace(/^[#/^~!>&]+/, "").replace(/~+$/, "").trim();
    if (inner === "" || inner === "else") continue; // {{/if}}, {{else}}
    const tokens = inner.split(/\s+/);
    let args = tokens;
    if (BLOCK_HELPERS.has(tokens[0])) {
      args = tokens.slice(1); // {{#if soul.x}} → check "soul.x"
    }
    for (const a of args) {
      // Allow literals (quoted) and the soul.* path only.
      if (/^["'].*["']$/.test(a)) continue;
      if (!/^soul(\.[A-Za-z0-9_]+)*$/.test(a)) {
        bad.push(`${m[0]} → "${a}"`);
      }
    }
  }
  return bad;
}

describe("profile SOUL.md.hbs templates only consume {{soul.*}}", () => {
  const templates = soulTemplates();

  it("finds at least the default profile template", () => {
    expect(templates.some((t) => t.includes("/default/"))).toBe(true);
  });

  for (const tpl of soulTemplates()) {
    it(`${tpl.replace(PROFILES_DIR + "/", "")} references only soul.*`, () => {
      const bad = offendingTokens(readFileSync(tpl, "utf-8"));
      expect(bad).toEqual([]);
    });
  }
});
