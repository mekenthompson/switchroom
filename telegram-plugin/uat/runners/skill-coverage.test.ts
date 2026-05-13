/**
 * Unit tests for the skill-coverage UAT runner's pure pieces:
 * label extractor, corpus loader, scoring math, markdown render.
 *
 * Network/driver paths are not exercised here — those are validated
 * by a live operator-driven run against the test-harness agent
 * (see docs/skill-coverage/runbook.md).
 */

import { describe, it, expect } from "vitest";
import { extractSkillsFromText } from "./skill-coverage.js";

describe("extractSkillsFromText", () => {
  it("pulls a single skill name from a card-style label", () => {
    expect(extractSkillsFromText("🛠 running skill switchroom-cli")).toEqual([
      "switchroom-cli",
    ]);
  });

  it("dedupes repeated mentions of the same skill", () => {
    const t = "running skill docx\n…\nrunning skill docx";
    expect(extractSkillsFromText(t)).toEqual(["docx"]);
  });

  it("collects multiple distinct skills across one progress card", () => {
    const t = [
      "🛠 running skill buildkite-cli",
      "📖 reading file…",
      "🛠 running skill switchroom-status",
    ].join("\n");
    const got = extractSkillsFromText(t).sort();
    expect(got).toEqual(["buildkite-cli", "switchroom-status"]);
  });

  it("is case-insensitive on the label but lowercases the slug", () => {
    expect(extractSkillsFromText("Running Skill BUILDKITE-API")).toEqual([
      "buildkite-api",
    ]);
  });

  it("ignores noise that doesn't match a kebab-case slug", () => {
    expect(extractSkillsFromText("running skill (and reading)")).toEqual([]);
  });

  it("returns [] when no labels are present", () => {
    expect(
      extractSkillsFromText("Sure, let me check the agent status for you."),
    ).toEqual([]);
  });
});
