/**
 * Unit tests for the skill-coverage UAT runner's pure pieces:
 * label extractor + sidecar JSONL reader. Live driver/network paths
 * are validated by operator-driven runs (see runbook).
 */

import { describe, it, expect } from "vitest";
import {
  extractSkillFromLabel,
  readSkillRowsSince,
} from "./skill-coverage.js";

describe("extractSkillFromLabel", () => {
  it("pulls the slug from the hook's canonical label", () => {
    expect(extractSkillFromLabel("Running skill switchroom-cli")).toBe(
      "switchroom-cli",
    );
  });

  it("is case-insensitive on the label but lowercases the slug", () => {
    expect(extractSkillFromLabel("RUNNING SKILL BUILDKITE-API")).toBe(
      "buildkite-api",
    );
  });

  it("returns null for non-Skill labels", () => {
    expect(extractSkillFromLabel("Reading scaffold.ts")).toBeNull();
    expect(extractSkillFromLabel("Replying")).toBeNull();
  });

  it("returns null when the slug is missing or malformed", () => {
    expect(extractSkillFromLabel("running skill")).toBeNull();
    expect(extractSkillFromLabel("running skill (and)")).toBeNull();
  });
});

describe("readSkillRowsSince", () => {
  const files: Record<string, string> = {
    "tool-labels-A.jsonl": [
      // before sinceMs: ignored
      JSON.stringify({ ts: 100, tool_use_id: "u1", agent_id: "ag", label: "Running skill docx", tool_name: "Skill" }),
      // after sinceMs, Skill: kept
      JSON.stringify({ ts: 1500, tool_use_id: "u2", agent_id: "ag", label: "Running skill switchroom-cli", tool_name: "Skill" }),
      // after sinceMs, non-Skill: ignored
      JSON.stringify({ ts: 1600, tool_use_id: "u3", agent_id: "ag", label: "Reading foo.ts", tool_name: "Read" }),
    ].join("\n") + "\n",
    "tool-labels-B.jsonl": [
      JSON.stringify({ ts: 2000, tool_use_id: "u4", agent_id: "ag", label: "Running skill buildkite-cli", tool_name: "Skill" }),
      // malformed line: ignored
      "{not-json",
      "",
    ].join("\n") + "\n",
    "other.jsonl": JSON.stringify({ ts: 2500, tool_name: "Skill", label: "Running skill x" }),
  };

  const fakeReaddir = (_p: string): string[] => Object.keys(files);
  const fakeReadFile = (p: string): string => {
    const name = p.split("/").pop()!;
    if (files[name] === undefined) throw new Error("ENOENT");
    return files[name]!;
  };

  it("returns only Skill rows from tool-labels-*.jsonl with ts >= sinceMs", () => {
    const got = readSkillRowsSince("/fake", 1000, fakeReaddir, fakeReadFile);
    const labels = got.map((r) => r.label).sort();
    expect(labels).toEqual([
      "Running skill buildkite-cli",
      "Running skill switchroom-cli",
    ]);
  });

  it("returns [] when the dir read throws", () => {
    expect(
      readSkillRowsSince("/fake", 0, () => { throw new Error("EACCES"); }, fakeReadFile),
    ).toEqual([]);
  });

  it("skips files that fail to read but keeps siblings", () => {
    const breakingRead = (p: string): string => {
      if (p.endsWith("tool-labels-A.jsonl")) throw new Error("EACCES");
      return fakeReadFile(p);
    };
    const got = readSkillRowsSince("/fake", 0, fakeReaddir, breakingRead);
    expect(got.map((r) => r.label)).toEqual(["Running skill buildkite-cli"]);
  });

  it("ignores files that don't match the tool-labels-*.jsonl pattern", () => {
    const files2: Record<string, string> = {
      "other.jsonl": JSON.stringify({ ts: 100, tool_name: "Skill", label: "x" }),
      "tool-labels-A.jsonl": "",
    };
    const got = readSkillRowsSince(
      "/fake",
      0,
      () => Object.keys(files2),
      (p) => files2[p.split("/").pop()!]!,
    );
    expect(got).toEqual([]);
  });
});
