/**
 * Tests for src/setup/profile-picker.ts (epic #543, workstream 4 — closes #190).
 *
 * Covers:
 *   - Fast path: --profile flag is validated against listAvailableProfiles
 *     and returned without entering the interactive picker.
 *   - Fast path errors: unknown profile name → actionable error.
 *   - Interactive path: numbered list, pick by number, pick by name,
 *     bad input re-prompts up to maxAttempts then throws.
 *   - Skills: --skills "all" / "none" / comma-list resolved correctly,
 *     unknown skill name throws, "" defaults to all.
 *   - Interactive skills: empty input → keep all, "none" → drop, list →
 *     subset.
 *   - No reader + no --profile → throws (non-interactive, no fallback).
 */

import { describe, it, expect, vi } from "vitest";
import {
  runProfilePicker,
  resolveSkillsSelection,
  defaultListProfileSkills,
} from "./profile-picker.js";

const PROFILES = ["coding", "default", "executive-assistant", "health-coach"];
const SKILLS_BY_PROFILE: Record<string, string[]> = {
  coding: ["architecture", "code-review"],
  default: [],
  "executive-assistant": ["daily-briefing", "meeting-prep"],
  "health-coach": ["check-in", "weekly-review"],
};

const fakeListProfiles = () => [...PROFILES];
const fakeListProfileSkills = (name: string) => [...(SKILLS_BY_PROFILE[name] ?? [])];

describe("runProfilePicker — fast path (--profile flag)", () => {
  it("validates and returns the profile without prompting", async () => {
    const log = vi.fn();
    const readLine = vi.fn();
    const result = await runProfilePicker({
      existingProfile: "health-coach",
      readLine,
      log,
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.profile).toBe("health-coach");
    expect(result.skills).toEqual(["check-in", "weekly-review"]);
    expect(result.allSkills).toEqual(["check-in", "weekly-review"]);
    expect(result.pickerShown).toBe(false);
    expect(readLine).not.toHaveBeenCalled();
  });

  it("rejects an unknown profile with the available list", async () => {
    await expect(
      runProfilePicker({
        existingProfile: "totally-bogus",
        listProfiles: fakeListProfiles,
        listProfileSkills: fakeListProfileSkills,
      }),
    ).rejects.toThrow(/Unknown profile.*coding.*health-coach/s);
  });

  it("honours --skills none alongside --profile", async () => {
    const result = await runProfilePicker({
      existingProfile: "coding",
      existingSkills: "none",
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.skills).toEqual([]);
    expect(result.allSkills).toEqual(["architecture", "code-review"]);
  });

  it("honours --skills with a comma-separated subset", async () => {
    const result = await runProfilePicker({
      existingProfile: "coding",
      existingSkills: "code-review",
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.skills).toEqual(["code-review"]);
  });

  it("rejects --skills naming a skill the profile doesn't bundle", async () => {
    await expect(
      runProfilePicker({
        existingProfile: "coding",
        existingSkills: "code-review,does-not-exist",
        listProfiles: fakeListProfiles,
        listProfileSkills: fakeListProfileSkills,
      }),
    ).rejects.toThrow(/Unknown skill "does-not-exist"/);
  });
});

describe("runProfilePicker — interactive", () => {
  it("picks by number", async () => {
    const log = vi.fn();
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("2") // pick "default" (alphabetically second)
      .mockResolvedValueOnce(""); // skill prompt — keep all
    const result = await runProfilePicker({
      readLine,
      log,
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.profile).toBe("default");
    expect(result.skills).toEqual([]); // default ships no skills, no prompt
    expect(result.pickerShown).toBe(true);
    // skill prompt is skipped when allSkills is empty, so readLine is
    // called exactly once (for the profile choice).
    expect(readLine).toHaveBeenCalledTimes(1);
  });

  it("picks by name", async () => {
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("health-coach")
      .mockResolvedValueOnce(""); // keep all skills
    const result = await runProfilePicker({
      readLine,
      log: () => {},
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.profile).toBe("health-coach");
    expect(result.skills).toEqual(["check-in", "weekly-review"]);
  });

  it('skill prompt: "none" drops all', async () => {
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("coding")
      .mockResolvedValueOnce("none");
    const result = await runProfilePicker({
      readLine,
      log: () => {},
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.profile).toBe("coding");
    expect(result.skills).toEqual([]);
    expect(result.allSkills).toEqual(["architecture", "code-review"]);
  });

  it("skill prompt: comma-list of numbers and names", async () => {
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("coding")
      .mockResolvedValueOnce("1,code-review"); // 1=architecture + code-review (de-duped if needed)
    const result = await runProfilePicker({
      readLine,
      log: () => {},
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
    });
    expect(result.skills).toEqual(["architecture", "code-review"]);
  });

  it("re-prompts on bad profile input then succeeds", async () => {
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("99") // out of range
      .mockResolvedValueOnce("nope") // unknown
      .mockResolvedValueOnce("coding")
      .mockResolvedValueOnce(""); // keep all skills
    const result = await runProfilePicker({
      readLine,
      log: () => {},
      listProfiles: fakeListProfiles,
      listProfileSkills: fakeListProfileSkills,
      maxAttempts: 5,
    });
    expect(result.profile).toBe("coding");
  });

  it("throws after maxAttempts of bad profile input", async () => {
    const readLine = vi
      .fn()
      .mockResolvedValueOnce("nope")
      .mockResolvedValueOnce("nope")
      .mockResolvedValueOnce("nope");
    await expect(
      runProfilePicker({
        readLine,
        log: () => {},
        listProfiles: fakeListProfiles,
        listProfileSkills: fakeListProfileSkills,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/Profile picker failed after 3 attempts/);
  });

  it("throws when no profile flag and no readLine supplied", async () => {
    await expect(
      runProfilePicker({
        listProfiles: fakeListProfiles,
        listProfileSkills: fakeListProfileSkills,
      }),
    ).rejects.toThrow(/No --profile supplied.*coding.*health-coach/s);
  });

  it("throws when listProfiles returns an empty array", async () => {
    await expect(
      runProfilePicker({
        existingProfile: "default",
        listProfiles: () => [],
        listProfileSkills: fakeListProfileSkills,
      }),
    ).rejects.toThrow(/No profiles are available/);
  });
});

describe("resolveSkillsSelection", () => {
  it('treats undefined / "" / "all" as keep-all', () => {
    expect(resolveSkillsSelection("coding", undefined, fakeListProfileSkills)).toEqual([
      "architecture",
      "code-review",
    ]);
    expect(resolveSkillsSelection("coding", "", fakeListProfileSkills)).toEqual([
      "architecture",
      "code-review",
    ]);
    expect(resolveSkillsSelection("coding", "all", fakeListProfileSkills)).toEqual([
      "architecture",
      "code-review",
    ]);
    expect(resolveSkillsSelection("coding", "ALL", fakeListProfileSkills)).toEqual([
      "architecture",
      "code-review",
    ]);
  });

  it('treats "none" (any case) as empty', () => {
    expect(resolveSkillsSelection("coding", "none", fakeListProfileSkills)).toEqual([]);
    expect(resolveSkillsSelection("coding", "NONE", fakeListProfileSkills)).toEqual([]);
  });

  it("de-dupes a repeated skill name", () => {
    expect(
      resolveSkillsSelection(
        "coding",
        "code-review,code-review,architecture",
        fakeListProfileSkills,
      ),
    ).toEqual(["code-review", "architecture"]);
  });

  it("rejects unknown skill names with the available list", () => {
    expect(() =>
      resolveSkillsSelection("coding", "nope", fakeListProfileSkills),
    ).toThrow(/Unknown skill "nope".*architecture, code-review/s);
  });
});

describe("defaultListProfileSkills", () => {
  it("returns [] for a profile that doesn't exist on disk", () => {
    expect(defaultListProfileSkills("totally-bogus-profile-xyz")).toEqual([]);
  });

  it("lists at least one entry for a known profile bundling skills", () => {
    // health-coach ships at least 'check-in' and 'weekly-review' in
    // the repo at the time of writing — be tolerant in case the bundle
    // changes, but assert non-empty.
    const skills = defaultListProfileSkills("health-coach");
    expect(skills.length).toBeGreaterThan(0);
  });
});
