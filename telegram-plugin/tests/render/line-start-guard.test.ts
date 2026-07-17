import { describe, it, expect } from "vitest";
import { guardAccidentalBlockConstructs } from "../../render/line-start-guard.js";

/** Strip the defusing backslashes so we can assert the reader-visible text is
 *  byte-identical to the original prose (Telegram consumes the `\`). */
function copyText(s: string): string {
  return s.replace(/\\([>.)#])/g, "$1");
}

describe("guardAccidentalBlockConstructs (#3252) — INTENDED formatting is never touched", () => {
  // ── Headings: deferred entirely, must pass through untouched ──
  it("leaves an intended `# ` heading untouched (deferred family)", () => {
    const s = "# Project status\nAll green.";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `## `/`### ` sub-headings untouched", () => {
    const s = "## Section\n### Subsection\nbody";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("escapes `#1` (no space) — LIVE-PROVED Telegram promotes it to a heading (guard-linestart-note.md)", () => {
    // This test previously pinned the OPPOSITE (untouched) on the unverified
    // CommonMark analogy that `#`+non-space renders literally. A live Bot API
    // probe (2026-07-17) proved Telegram promotes it to an H1 — the recorded
    // `- #3293:` giant-heading incident. Flipped to assert the escape.
    const out = guardAccidentalBlockConstructs("#1 priority is latency");
    expect(out).toBe("\\#1 priority is latency");
    expect(copyText(out)).toBe("#1 priority is latency");
  });

  it("leaves `# of items` untouched — deferred (indistinguishable from a heading)", () => {
    const s = "# of items in the cart";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Intended blockquotes: `> ` with a space, never touched ──
  it("leaves an intended `> quoted` blockquote untouched", () => {
    const s = "> This is a real quote\n> spanning two lines";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `> 50% of users` untouched — spaced form is a valid/intended blockquote", () => {
    const s = "> 50% of users prefer dark mode";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Bullet lists: deferred entirely, never touched ──
  it("leaves `- ` bullets untouched (deferred family)", () => {
    const s = "- first item\n- second item\n- 5 apples";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `* ` and `+ ` bullets untouched", () => {
    const s = "* star bullet\n+ plus bullet";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves `- 5 degrees` untouched — ambiguous with a bullet, deferred", () => {
    const s = "- 5 degrees below freezing";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Ordered lists: small numbers are real lists, never touched ──
  it("leaves a real `1.`/`2.`/`3.` numbered list untouched", () => {
    const s = "1. First we plan\n2. Then we build\n3. Finally we ship";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a 2–3 digit list marker (`42.`, `100.`) untouched — deferred", () => {
    const s = "42. answer\n100. century";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a decimal `3.14` untouched (no space after dot => not a list)", () => {
    const s = "3.14 is pi and 2.71 is e";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  // ── Non-triggering prose ──
  it("is a strict no-op for ordinary prose with no line-start triggers", () => {
    const s = "just a normal sentence about the weather today";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });
});

describe("guardAccidentalBlockConstructs (#3252) — accidental constructs ARE escaped", () => {
  it("escapes a line-start `>2x` comparison (accidental blockquote)", () => {
    const out = guardAccidentalBlockConstructs(">2x faster than before");
    expect(out).toBe("\\>2x faster than before");
    expect(copyText(out)).toBe(">2x faster than before");
  });

  it("escapes a line-start `>50%` comparison", () => {
    const out = guardAccidentalBlockConstructs(">50% of the budget");
    expect(out).toBe("\\>50% of the budget");
  });

  it("escapes a line-start `>=3` comparison", () => {
    const out = guardAccidentalBlockConstructs(">=3 retries required");
    expect(out).toBe("\\>=3 retries required");
  });

  it("escapes an accidental blockquote only on the offending line, mid-paragraph", () => {
    const s = "Latency improved.\n>2x faster now\nShipping today.";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe("Latency improved.\n\\>2x faster now\nShipping today.");
  });

  it("escapes a 4+ digit year promoted to an ordered-list item (`2026. was`)", () => {
    const out = guardAccidentalBlockConstructs("2026. was a great year for the team");
    expect(out).toBe("2026\\. was a great year for the team");
    expect(copyText(out)).toBe("2026. was a great year for the team");
  });

  it("escapes a `1999) ` year with the paren delimiter", () => {
    const out = guardAccidentalBlockConstructs("1999) marked the dot-com peak");
    expect(out).toBe("1999\\) marked the dot-com peak");
  });

  it("escapes the accidental ordered-list line only, inside a paragraph", () => {
    const s = "Consider the timeline.\n2026. was pivotal\nThat is all.";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe("Consider the timeline.\n2026\\. was pivotal\nThat is all.");
  });
});

describe("guardAccidentalBlockConstructs — accidental HEADING promotion (live-probed 2026-07-17)", () => {
  it("REGRESSION: the recorded incident line — bullet content starting `#3293:` gets escaped", () => {
    // Verbatim shape of gateway history.db message_id 19159, which rendered
    // as a giant H1 on the operator's phone. The escape renders it literal.
    const s =
      "**Landing now**\n\n- #3293: proxy-side 401s route to you as operator instead of hitting users with a bogus re-auth card";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe(
      "**Landing now**\n\n- \\#3293: proxy-side 401s route to you as operator instead of hitting users with a bogus re-auth card",
    );
    // No live heading trigger remains: every line-start / item-content `#` is escaped.
    expect(copyText(out)).toBe(s);
  });

  it("escapes a bare line-start `#3293 foo` (probe: promoted to H1)", () => {
    const out = guardAccidentalBlockConstructs("#3293 foo");
    expect(out).toBe("\\#3293 foo");
    expect(copyText(out)).toBe("#3293 foo");
  });

  it("escapes `#word` — probe proved letters promote too (NOT rendered as a hashtag)", () => {
    const out = guardAccidentalBlockConstructs("#word probe");
    expect(out).toBe("\\#word probe");
  });

  it("escapes a multi-hash glued run `##3293` with ONE leading backslash (probe: `\\##` renders literally)", () => {
    const out = guardAccidentalBlockConstructs("##3293 foo");
    expect(out).toBe("\\##3293 foo");
    expect(out).not.toContain("\\\\");
  });

  it("escapes ordered-item content `1. #3293: foo` (probe: promoted inside the item)", () => {
    const out = guardAccidentalBlockConstructs("1. #3293: foo");
    expect(out).toBe("1. \\#3293: foo");
  });

  it("escapes indented bullet content `  - #3293: foo` (probe: 1-3 space indent still promotes)", () => {
    const out = guardAccidentalBlockConstructs("  - #3293: foo");
    expect(out).toBe("  - \\#3293: foo");
  });

  it("escapes only the offending line inside a multi-line body", () => {
    const s = "Shipped today.\n#3293 merged (40c957e)\nAll green.";
    const out = guardAccidentalBlockConstructs(s);
    expect(out).toBe("Shipped today.\n\\#3293 merged (40c957e)\nAll green.");
  });

  it("leaves an intended `# Real heading` untouched (probe: renders as intended)", () => {
    const s = "# Real heading";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a spaced multi-hash `## Section` untouched — the space means an intended heading", () => {
    const s = "## Section";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a mid-sentence `see #3293 now` untouched — not a line or item-content start", () => {
    const s = "see #3293 now";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a bullet whose `#` is NOT at content start untouched (`- fix #3293 today`)", () => {
    const s = "- fix #3293 today";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("never touches `#3293` inside an inline code span", () => {
    const s = "ref `#3293` in the log";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("never touches `#` lines inside a fenced code block", () => {
    const s = "```\n#3293 in code\n- #3293: also code\n```";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a 4-space indented `#` line untouched (indented code context)", () => {
    const s = "    #3293 indented code";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("is idempotent on the heading arm — line start AND item content", () => {
    const once = guardAccidentalBlockConstructs("#3293 foo\n- #3293: bar");
    expect(guardAccidentalBlockConstructs(once)).toBe(once);
    expect(once).not.toContain("\\\\");
  });
});

describe("guardAccidentalBlockConstructs (#3252) — code / indent safety", () => {
  it("never touches a `>` at the start of a FENCED code block line", () => {
    const s = "```\n>2x in shell\n2026. code year\n```";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("never touches a `>` inside an inline code span", () => {
    const s = "use `>2x` in the expression";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("does not treat a prose `>` that begins mid-line (after a code span) as a line start", () => {
    // The `>5` is NOT at a real line start (an inline code span precedes it on
    // the same line), so it must be left alone.
    const s = "the value `x` >5 always";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("leaves a 4-space indented (code) line untouched", () => {
    const s = "    >2x indented code\n    2026. also code";
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });

  it("still escapes a construct indented 1–3 spaces (valid block context)", () => {
    const out = guardAccidentalBlockConstructs("  >2x slightly indented");
    expect(out).toBe("  \\>2x slightly indented");
  });
});

describe("guardAccidentalBlockConstructs (#3252) — idempotency & no-op signal", () => {
  it("is idempotent: guarding already-guarded text is a strict no-op", () => {
    const once = guardAccidentalBlockConstructs(">2x and\n2026. year");
    expect(guardAccidentalBlockConstructs(once)).toBe(once);
    expect(once).not.toContain("\\\\"); // never a doubled backslash
  });

  it("short-circuits to a strict no-op when there is no `>` and no 4+ digit marker", () => {
    const s = "1. a\n2. b\n- c\n# d\n> e";
    // All intended constructs; contains `>` so it runs, but produces no change.
    expect(guardAccidentalBlockConstructs(s)).toBe(s);
  });
});
