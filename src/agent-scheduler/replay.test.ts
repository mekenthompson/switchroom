/**
 * Unit tests for the at-least-once replay helpers.
 *
 * Covers:
 *   - cron field matcher: literals, ranges, lists, steps, range/step
 *   - cronMatchesDate: 5-field, day-of-week 7→0, DOM/DOW Vixie OR-rule
 *   - findMissedFires: identifies the most recent past match within
 *     the replay window with no audit row, skips when audited (within
 *     ±90s tolerance), counts only successful (exitCode=0) audit rows
 *   - readRecentFires: empty array on missing file, parses JSONL,
 *     skips corrupt lines
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cronMatchesDate,
  findMissedFires,
  findStaleSkippedFires,
  matchField,
  normalizeAliases,
  readRecentFires,
} from "./replay.js";
import type { DispatchResult } from "../scheduler/dispatch.js";
import type { SchedulerEntry } from "../scheduler/dispatch.js";

describe("matchField", () => {
  it("accepts wildcards", () => {
    expect(matchField("*", 0, "minute")).toBe(true);
    expect(matchField("*", 59, "minute")).toBe(true);
    expect(matchField("*", 13, "hour")).toBe(true);
  });

  it("accepts exact literals", () => {
    expect(matchField("8", 8, "hour")).toBe(true);
    expect(matchField("8", 9, "hour")).toBe(false);
  });

  it("accepts ranges", () => {
    expect(matchField("1-5", 3, "dow")).toBe(true);
    expect(matchField("1-5", 0, "dow")).toBe(false);
    expect(matchField("1-5", 5, "dow")).toBe(true);
    expect(matchField("1-5", 6, "dow")).toBe(false);
  });

  it("accepts comma-separated lists", () => {
    expect(matchField("0,15,30,45", 15, "minute")).toBe(true);
    expect(matchField("0,15,30,45", 17, "minute")).toBe(false);
  });

  it("accepts steps with *", () => {
    expect(matchField("*/15", 0, "minute")).toBe(true);
    expect(matchField("*/15", 15, "minute")).toBe(true);
    expect(matchField("*/15", 17, "minute")).toBe(false);
    expect(matchField("*/15", 45, "minute")).toBe(true);
  });

  it("accepts steps with explicit range", () => {
    expect(matchField("0-30/10", 0, "minute")).toBe(true);
    expect(matchField("0-30/10", 10, "minute")).toBe(true);
    expect(matchField("0-30/10", 20, "minute")).toBe(true);
    expect(matchField("0-30/10", 30, "minute")).toBe(true);
    expect(matchField("0-30/10", 40, "minute")).toBe(false);
  });

  it("rejects out-of-range values", () => {
    expect(matchField("60", 60, "minute")).toBe(false); // 60 > max=59
    expect(matchField("0", 0, "dom")).toBe(false); // 0 < min=1
  });
});

describe("cronMatchesDate", () => {
  it("matches the canonical morning briefing slot", () => {
    // Mon 2024-01-08 08:00 — `0 8 * * 1-5`
    const date = new Date(2024, 0, 8, 8, 0, 0); // local time
    expect(cronMatchesDate("0 8 * * 1-5", date)).toBe(true);
  });

  it("rejects the morning briefing slot on a Sunday", () => {
    // Sun 2024-01-07 08:00
    const date = new Date(2024, 0, 7, 8, 0, 0);
    expect(cronMatchesDate("0 8 * * 1-5", date)).toBe(false);
  });

  it("normalizes day-of-week 7 to 0 (both = Sunday)", () => {
    const sunday = new Date(2024, 0, 7, 12, 0, 0);
    expect(cronMatchesDate("0 12 * * 0", sunday)).toBe(true);
    expect(cronMatchesDate("0 12 * * 7", sunday)).toBe(true);
  });

  it("applies the Vixie OR-rule when DOM and DOW are both restrictive", () => {
    // `0 0 1 * 1` should fire on the 1st of the month OR on Monday.
    // Mon 2024-01-08 is a Monday but not the 1st.
    const monday = new Date(2024, 0, 8, 0, 0, 0);
    expect(cronMatchesDate("0 0 1 * 1", monday)).toBe(true);
    // Wed 2024-02-21 is neither.
    const wed = new Date(2024, 1, 21, 0, 0, 0);
    expect(cronMatchesDate("0 0 1 * 1", wed)).toBe(false);
  });

  it("returns false for malformed expressions", () => {
    expect(cronMatchesDate("0 8 * *", new Date())).toBe(false); // 4 fields
    expect(cronMatchesDate("0 8 * * 1-5 2024", new Date())).toBe(false); // 6 fields
    expect(cronMatchesDate("not-a-cron", new Date())).toBe(false);
  });

  // Name aliases (#896) — node-cron 3.x accepts these in month + dow
  // fields. Replay must too or boot replay silently drops fires for
  // any operator who wrote MON-FRI / JAN-DEC.
  describe("name aliases (#896)", () => {
    it("matches MON in dow against a Monday", () => {
      const monday = new Date("2026-05-11T08:00:00"); // Monday
      expect(cronMatchesDate("0 8 * * MON", monday)).toBe(true);
      const tuesday = new Date("2026-05-12T08:00:00");
      expect(cronMatchesDate("0 8 * * MON", tuesday)).toBe(false);
    });

    it("matches MON-FRI weekday range", () => {
      const wed = new Date("2026-05-13T08:00:00");
      const sat = new Date("2026-05-09T08:00:00");
      expect(cronMatchesDate("0 8 * * MON-FRI", wed)).toBe(true);
      expect(cronMatchesDate("0 8 * * MON-FRI", sat)).toBe(false);
    });

    it("matches JAN in month field", () => {
      const jan = new Date("2026-01-15T08:00:00");
      const feb = new Date("2026-02-15T08:00:00");
      expect(cronMatchesDate("0 8 * JAN *", jan)).toBe(true);
      expect(cronMatchesDate("0 8 * JAN *", feb)).toBe(false);
    });

    it("is case-insensitive", () => {
      const monday = new Date("2026-05-11T08:00:00");
      expect(cronMatchesDate("0 8 * * mon", monday)).toBe(true);
      expect(cronMatchesDate("0 8 * * Mon", monday)).toBe(true);
    });

    it("accepts comma-lists of aliases", () => {
      const monday = new Date("2026-05-11T08:00:00");
      const sat = new Date("2026-05-09T08:00:00");
      expect(cronMatchesDate("0 8 * * MON,WED,FRI", monday)).toBe(true);
      expect(cronMatchesDate("0 8 * * MON,WED,FRI", sat)).toBe(false);
    });

    it("normalizeAliases is a no-op for already-numeric input", () => {
      expect(normalizeAliases("1-5", "dow")).toBe("1-5");
      expect(normalizeAliases("*", "month")).toBe("*");
      expect(normalizeAliases("1,3,5", "dow")).toBe("1,3,5");
    });

    it("normalizeAliases leaves non-month/dow fields untouched", () => {
      // Defensive: a stray alias in a minute/hour/dom field (operator
      // typo) shouldn't get substituted — keep aliasing scoped to
      // fields where node-cron actually accepts it.
      expect(normalizeAliases("MON", "minute")).toBe("MON");
      expect(normalizeAliases("MON", "hour")).toBe("MON");
      expect(normalizeAliases("MON", "dom")).toBe("MON");
    });

    it("handles mixed alias + numeric forms in the same field", () => {
      // The most likely user-written form to regress: half the field
      // is named, half is numeric. Each letter-run substitutes
      // independently, numerics pass through.
      expect(normalizeAliases("MON,3,FRI", "dow")).toBe("1,3,5");
      expect(normalizeAliases("1,WED,5", "dow")).toBe("1,3,5");
      const monday = new Date("2026-05-11T08:00:00");
      const wed = new Date("2026-05-13T08:00:00");
      expect(cronMatchesDate("0 8 * * MON,3,FRI", monday)).toBe(true);
      expect(cronMatchesDate("0 8 * * MON,3,FRI", wed)).toBe(true);
    });

    it("normalizes dow=7 (Sunday) chained after alias substitution", () => {
      // Operator might write the literal '7' alongside aliases. The
      // substitute-then-normalize-7 order (in cronMatchesDate) must
      // not double-process: SUN already became 0; 7 also becomes 0.
      expect(normalizeAliases("MON,7", "dow")).toBe("1,7");
      const sun = new Date("2026-05-10T08:00:00");
      expect(cronMatchesDate("0 8 * * MON,7", sun)).toBe(true);
    });
  });
});

describe("findMissedFires", () => {
  function entry(idx: number, cron: string): SchedulerEntry {
    return {
      agent: "klanker",
      scheduleIndex: idx,
      cron,
      prompt: `prompt-${idx}`,
      promptKey: `key${idx}`,
    };
  }

  function audit(idx: number, startedAt: number, exitCode = 0): DispatchResult {
    return {
      agent: "klanker",
      scheduleIndex: idx,
      promptKey: `key${idx}`,
      exitCode,
      outputSummary: "ok",
      startedAt,
      finishedAt: startedAt + 100,
    };
  }

  it("identifies a missed fire within the window with no audit row", () => {
    // 09:30 now; entry fires every 15min.
    const now = new Date(2024, 0, 8, 9, 30, 0);
    const result = findMissedFires({
      entries: [entry(0, "*/15 * * * *")],
      recentFires: [],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.entry.scheduleIndex).toBe(0);
    // Most recent past match is :30 itself.
    expect(new Date(result[0]!.expectedFireMs).getMinutes()).toBe(30);
  });

  it("skips when there's a successful audit row close to the expected time", () => {
    const now = new Date(2024, 0, 8, 9, 30, 0);
    const expected = now.getTime();
    const result = findMissedFires({
      entries: [entry(0, "*/15 * * * *")],
      recentFires: [audit(0, expected + 5_000)], // 5s after expected
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(0);
  });

  it("treats an audit row with exitCode != 0 as still-missing", () => {
    const now = new Date(2024, 0, 8, 9, 30, 0);
    const expected = now.getTime();
    const result = findMissedFires({
      entries: [entry(0, "*/15 * * * *")],
      recentFires: [audit(0, expected + 5_000, -1)], // failed delivery
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(1);
  });

  it("ignores fires older than the window", () => {
    // Entry fires once a day at 08:00. Now is 09:00 and window is 30min,
    // so the 08:00 fire is outside the window — no replay.
    const now = new Date(2024, 0, 8, 9, 0, 0); // Monday 09:00
    const result = findMissedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(0);
  });

  it("returns at most one miss per entry (most recent only)", () => {
    // Every-15-min entry across a 30-min window has 2-3 candidate
    // fires; we only return the most recent miss.
    const now = new Date(2024, 0, 8, 9, 31, 0);
    const result = findMissedFires({
      entries: [entry(0, "*/15 * * * *")],
      recentFires: [],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(1);
    expect(new Date(result[0]!.expectedFireMs).getMinutes()).toBe(30);
  });

  it("handles multiple entries independently", () => {
    const now = new Date(2024, 0, 8, 9, 30, 0);
    const result = findMissedFires({
      entries: [
        entry(0, "*/15 * * * *"), // missed at :30
        entry(1, "0 8 * * 1-5"),  // outside window
        entry(2, "*/10 * * * *"), // missed at :30
      ],
      recentFires: [],
      now,
      windowMinutes: 30,
    });
    const missedIdx = result.map((r) => r.entry.scheduleIndex).sort();
    expect(missedIdx).toEqual([0, 2]);
  });
});

describe("findStaleSkippedFires", () => {
  function entry(idx: number, cron: string): SchedulerEntry {
    return {
      agent: "klanker",
      scheduleIndex: idx,
      cron,
      prompt: `prompt-${idx}`,
      promptKey: `key${idx}`,
    };
  }
  function audit(idx: number, startedAt: number, exitCode = 0): DispatchResult {
    return {
      agent: "klanker",
      scheduleIndex: idx,
      promptKey: `key${idx}`,
      exitCode,
      outputSummary: "ok",
      startedAt,
      finishedAt: startedAt + 100,
    };
  }

  // Wed 2024-01-10 12:00 local; daily-weekday 08:00 entry. The 08:00
  // run is 240 min ago — well outside a 30-min replay window.
  const now = new Date(2024, 0, 10, 12, 0, 0);
  const eightAm = new Date(2024, 0, 10, 8, 0, 0).getTime();

  it("reports the most recent out-of-window run with no audit", () => {
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.entry.scheduleIndex).toBe(0);
    expect(result[0]!.expectedFireMs).toBe(eightAm);
  });

  it("does not report when a successful audit covers the run", () => {
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [audit(0, eightAm + 3_000)],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(0);
  });

  it("does not report when a later run already caught the user up", () => {
    // No 08:00 audit, but a 09:00 success — user isn't in the dark.
    const nineAm = new Date(2024, 0, 10, 9, 0, 0).getTime();
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [audit(0, nineAm)],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(0);
  });

  it("treats a failed (exitCode!=0) audit as still-missing", () => {
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [audit(0, eightAm, -1)],
      now,
      windowMinutes: 30,
    });
    expect(result).toHaveLength(1);
  });

  it("ignores in-window occurrences (those are replay's job)", () => {
    // Fires at 09:15 only. now 09:30, window 30 → 09:15 is in-window.
    // Cap at 60 so yesterday's 09:15 is out of reach: nothing stale.
    const at930 = new Date(2024, 0, 10, 9, 30, 0);
    const result = findStaleSkippedFires({
      entries: [entry(0, "15 9 * * *")],
      recentFires: [],
      now: at930,
      windowMinutes: 30,
      maxLookbackMinutes: 60,
    });
    expect(result).toHaveLength(0);
  });

  it("respects the maxLookback ceiling", () => {
    // Only the 08:00 run exists; cap 60 min only scans back to 11:00.
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [],
      now,
      windowMinutes: 30,
      maxLookbackMinutes: 60,
    });
    expect(result).toHaveLength(0);
  });

  it("returns [] when the cap is <= the replay window", () => {
    const result = findStaleSkippedFires({
      entries: [entry(0, "0 8 * * 1-5")],
      recentFires: [],
      now,
      windowMinutes: 30,
      maxLookbackMinutes: 30,
    });
    expect(result).toHaveLength(0);
  });

  it("handles multiple entries independently", () => {
    const result = findStaleSkippedFires({
      entries: [
        entry(0, "0 8 * * 1-5"), // stale, uncovered
        entry(1, "0 8 * * 1-5"), // covered by a success
      ],
      recentFires: [audit(1, eightAm + 2_000)],
      now,
      windowMinutes: 30,
    });
    expect(result.map((r) => r.entry.scheduleIndex)).toEqual([0]);
  });
});

describe("readRecentFires", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agent-scheduler-replay-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns [] when the file doesn't exist", () => {
    expect(readRecentFires(join(tmp, "missing.jsonl"))).toEqual([]);
  });

  it("parses a JSONL file of audit rows", () => {
    const path = join(tmp, "scheduler.jsonl");
    const rows: DispatchResult[] = [
      {
        agent: "klanker",
        scheduleIndex: 0,
        promptKey: "a",
        exitCode: 0,
        outputSummary: "ok",
        startedAt: 100,
        finishedAt: 200,
      },
      {
        agent: "klanker",
        scheduleIndex: 1,
        promptKey: "b",
        exitCode: -1,
        outputSummary: "no client",
        startedAt: 300,
        finishedAt: 400,
      },
    ];
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(readRecentFires(path)).toEqual(rows);
  });

  it("skips corrupt lines silently", () => {
    const path = join(tmp, "scheduler.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        agent: "x",
        scheduleIndex: 0,
        promptKey: "k",
        exitCode: 0,
        outputSummary: "",
        startedAt: 1,
        finishedAt: 2,
      }) + "\n" +
        "{not json\n" +
        "\n" + // blank line OK
        JSON.stringify({
          agent: "y",
          scheduleIndex: 1,
          promptKey: "j",
          exitCode: 0,
          outputSummary: "",
          startedAt: 3,
          finishedAt: 4,
        }) + "\n",
    );
    const out = readRecentFires(path);
    expect(out).toHaveLength(2);
    expect(out[0]!.agent).toBe("x");
    expect(out[1]!.agent).toBe("y");
  });
});
