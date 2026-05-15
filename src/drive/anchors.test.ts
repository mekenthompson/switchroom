/**
 * Anchor resolver tests — RFC E §4.5.
 *
 * Covers all three anchor types (heading / snippet / position), the
 * disambiguation paths (HEADING_AMBIGUOUS, SNIPPET_AMBIGUOUS,
 * nth_match), the error shapes the wrapper surfaces back to the agent,
 * and the displayName surfaces the diff-preview card will attest.
 */

import { describe, expect, it } from "vitest";

import {
  describeOffset,
  findParagraphForOffset,
  nearestHeadingAbove,
  resolveAnchor,
  type DocumentSnapshot,
  type HeadingParagraph,
  type TextParagraph,
} from "./anchors.js";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

function h(level: number, text: string, index: number): HeadingParagraph {
  return { kind: "heading", level, text, index };
}

function p(text: string, index: number): TextParagraph {
  return { kind: "text", text, index };
}

const headedDoc: DocumentSnapshot = {
  paragraphs: [
    h(1, "Q3 Strategy Notes", 1),
    p("Intro paragraph.", 2),
    h(2, "Goals", 3),
    p("Ship hiring section.", 4),
    p("Close two roles.", 5),
    h(2, "Hiring", 6),
    p("Open roles list.", 7),
    h(2, "Risks", 8),
    p("None identified.", 9),
  ],
};

const unheadedDoc: DocumentSnapshot = {
  paragraphs: [
    p("We agreed to ship by Q3.", 1),
    p("Action items:", 2),
    p("- John to draft hiring plan.", 3),
    p("- TBD: hiring section.", 4),
    p("- Action items:", 5), // intentional duplicate of paragraph 2 to test ambiguity
  ],
};

const emptyDoc: DocumentSnapshot = { paragraphs: [] };

// ────────────────────────────────────────────────────────────────────────
// Heading-based
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — heading-based", () => {
  it("after_heading: 'Goals' resolves to insert_after at the heading's index", () => {
    const r = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 3 });
      expect(r.resolved.displayName).toBe("after heading 'Goals' (level 2)");
    }
  });

  it("append_to_section: 'Goals' resolves to the LAST paragraph in the section", () => {
    // Section runs from heading index 3 → next H2 at index 6, so last
    // paragraph in section is index 5 ("Close two roles.")
    const r = resolveAnchor({ append_to_section: "Goals" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 5,
      });
      expect(r.resolved.displayName).toBe("end of section 'Goals' (level 2)");
    }
  });

  it("append_to_section runs to end of doc when no following same-or-higher heading", () => {
    // 'Risks' is the last H2 — section runs to end of doc, last paragraph
    // is index 9 ("None identified.")
    const r = resolveAnchor({ append_to_section: "Risks" }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 9,
      });
    }
  });

  it("HEADING_NOT_FOUND with operator-actionable message", () => {
    const r = resolveAnchor({ after_heading: "Nonexistent" }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_NOT_FOUND");
      expect(r.error.message).toContain("Nonexistent");
      expect(r.error.message).toContain("after_line_containing");
    }
  });

  it("level filter — wrong level gives HEADING_NOT_FOUND", () => {
    // 'Goals' is H2 in the fixture; asking for H1 → not found.
    const r = resolveAnchor({ after_heading: "Goals", level: 1 }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_NOT_FOUND");
      expect(r.error.message).toContain("at level 1");
    }
  });

  it("HEADING_AMBIGUOUS when multiple match and nth_match unset", () => {
    // Add two same-level headings with the same title to a fresh doc.
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const r = resolveAnchor({ after_heading: "Notes" }, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("HEADING_AMBIGUOUS");
      expect(r.error.candidates).toHaveLength(2);
      expect(r.error.message).toContain("nth_match (1..2)");
    }
  });

  it("HEADING_AMBIGUOUS resolved by nth_match", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const first = resolveAnchor({ after_heading: "Notes", nth_match: 1 }, doc);
    const second = resolveAnchor({ after_heading: "Notes", nth_match: 2 }, doc);
    expect(first.ok && first.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 1 });
    expect(second.ok && second.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 3 });
  });
});

// ────────────────────────────────────────────────────────────────────────
// append_to_section — empty-section semantics (post-review fix #1)
// ────────────────────────────────────────────────────────────────────────

describe("append_to_section — empty-section handling", () => {
  it("heading immediately followed by another same-level heading → append_to_empty_section at heading index", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Goals", 1), h(2, "Hiring", 2), p("Open roles.", 3)],
    };
    const r = resolveAnchor({ append_to_section: "Goals" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 1,
      });
      expect(r.resolved.displayName).toContain("currently empty");
    }
  });

  it("heading is the LAST paragraph in the doc → append_to_empty_section", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [p("Body.", 1), h(2, "Risks", 2)],
    };
    const r = resolveAnchor({ append_to_section: "Risks" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 2,
      });
    }
  });

  it("heading immediately followed by a higher-level heading (H2 → H1) → empty section", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), h(1, "Other", 2), p("body", 3)],
    };
    const r = resolveAnchor({ append_to_section: "Notes" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_empty_section",
        paragraphIndex: 1,
      });
    }
  });

  it("heading with body and nested subheading → section_end at last body paragraph (subheading bodies count)", () => {
    // 'Goals' has body paragraph (idx 2), then subheading H3 (idx 3)
    // with its own body (idx 4). Section runs to next H<=2 or EOF;
    // here EOF, so last body is idx 4.
    const doc: DocumentSnapshot = {
      paragraphs: [
        h(2, "Goals", 1),
        p("Top-level intent.", 2),
        h(3, "Subgoal", 3),
        p("Sub body.", 4),
      ],
    };
    const r = resolveAnchor({ append_to_section: "Goals" }, doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({
        kind: "append_to_section_end",
        paragraphIndex: 4,
      });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Text-snippet
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — text-snippet", () => {
  it("after_line_containing matches case-insensitively", () => {
    const r = resolveAnchor(
      { after_line_containing: "we agreed to ship" },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 1 });
      expect(r.resolved.displayName).toContain("after line:");
      expect(r.resolved.displayName).toContain("agreed to ship");
    }
  });

  it("before_line_containing places insert_before at the matched paragraph", () => {
    const r = resolveAnchor(
      { before_line_containing: "TBD: hiring section", nth_match: 1 },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_before", paragraphIndex: 4 });
    }
  });

  it("replace_line_matching uses the regex against the paragraph text", () => {
    const r = resolveAnchor(
      { replace_line_matching: /TBD:\s*hiring/ },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "replace_paragraph", paragraphIndex: 4 });
      expect(r.resolved.displayName).toContain("replacing line:");
    }
  });

  it("SNIPPET_NOT_FOUND with the search term in the error message", () => {
    const r = resolveAnchor(
      { after_line_containing: "this string is nowhere" },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SNIPPET_NOT_FOUND");
      expect(r.error.message).toContain("this string is nowhere");
    }
  });

  it("SNIPPET_AMBIGUOUS with up-to-3 candidate excerpts when multiple match", () => {
    // Both "Action items:" lines (paragraphs 2 and 5) match the snippet.
    const r = resolveAnchor(
      { after_line_containing: "Action items" },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SNIPPET_AMBIGUOUS");
      expect(r.error.candidates).toHaveLength(2);
      expect(r.error.message).toContain("nth_match (1..2)");
    }
  });

  it("SNIPPET_AMBIGUOUS resolved by nth_match", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 2 },
      unheadedDoc,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 5 });
    }
  });

  it("INVALID_ANCHOR when no snippet field is set under a snippet-shaped call", () => {
    // Empty object falls through to INVALID_ANCHOR via the dispatcher.
    const r = resolveAnchor({}, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });

  it("INVALID_ANCHOR when after_line_containing is empty string (would silently match every paragraph)", () => {
    const r = resolveAnchor({ after_line_containing: "" }, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_ANCHOR");
      expect(r.error.message).toContain("non-empty");
    }
  });

  it("INVALID_ANCHOR when before_line_containing is whitespace-only", () => {
    const r = resolveAnchor({ before_line_containing: "   " }, unheadedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

// ────────────────────────────────────────────────────────────────────────
// nth_match out-of-range — distinct error code per review fix #2
// ────────────────────────────────────────────────────────────────────────

describe("nth_match out of range → NTH_MATCH_OUT_OF_RANGE (not _AMBIGUOUS)", () => {
  it("heading: nth_match=5 when there are only 2 matches", () => {
    const doc: DocumentSnapshot = {
      paragraphs: [h(2, "Notes", 1), p("a", 2), h(2, "Notes", 3), p("b", 4)],
    };
    const r = resolveAnchor({ after_heading: "Notes", nth_match: 5 }, doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
      expect(r.error.message).toContain("nth_match=5");
      expect(r.error.message).toContain("Valid range: 1..2");
    }
  });

  it("snippet: nth_match=10 when there are only 2 matches", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 10 },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
      expect(r.error.message).toContain("nth_match=10");
    }
  });

  it("nth_match=0 (boundary, 1-based indexing) → NTH_MATCH_OUT_OF_RANGE", () => {
    const r = resolveAnchor(
      { after_line_containing: "Action items", nth_match: 0 },
      unheadedDoc,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NTH_MATCH_OUT_OF_RANGE");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Document-position
// ────────────────────────────────────────────────────────────────────────

describe("resolveAnchor — document-position", () => {
  it("at_start places insert_before at the first paragraph", () => {
    const r = resolveAnchor({ at_start: true }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_before", paragraphIndex: 1 });
      expect(r.resolved.displayName).toBe("at start of doc");
    }
  });

  it("at_end places insert_after at the last paragraph", () => {
    const r = resolveAnchor({ at_end: true }, headedDoc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.op).toEqual({ kind: "insert_after", paragraphIndex: 9 });
      expect(r.resolved.displayName).toBe("at end of doc");
    }
  });

  it("EMPTY_DOC_NEEDS_POSITION when at_start/at_end on an empty doc", () => {
    const r = resolveAnchor({ at_start: true }, emptyDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("EMPTY_DOC_NEEDS_POSITION");
  });

  it("INVALID_ANCHOR when both at_start and at_end are set", () => {
    const r = resolveAnchor({ at_start: true, at_end: true }, headedDoc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

// ────────────────────────────────────────────────────────────────────────
// displayName attestation invariants — load-bearing for RFC E §4.2
// ────────────────────────────────────────────────────────────────────────

describe("resolved displayName never contains agent-controlled text", () => {
  it("heading anchor displayName comes from the doc, not the agent param", () => {
    // Even though the agent passes the title, the displayName uses the
    // *resolved heading's text* — which in practice would be identical
    // to the agent input on a successful match. The invariant we're
    // pinning is that it's the resolver that builds the string from
    // doc state, not echoed agent input.
    const r = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r.ok && r.resolved.displayName).toBe("after heading 'Goals' (level 2)");
    // Same call, same result — pinning that no agent-supplied
    // metadata bleeds through into the display string.
    const r2 = resolveAnchor({ after_heading: "Goals" }, headedDoc);
    expect(r2.ok && r2.resolved.displayName).toBe("after heading 'Goals' (level 2)");
  });

  it("snippet anchor displayName uses the doc's actual line text, not the search term", () => {
    // The agent searches for "we agreed to ship" (truncated); the
    // displayName surfaces the FULL matched paragraph text up to the
    // ellipsis budget. Defends against an agent searching for a
    // shortened snippet to mislead the operator.
    const r = resolveAnchor(
      { after_line_containing: "we agreed" },
      unheadedDoc,
    );
    expect(r.ok && r.resolved.displayName).toContain("We agreed to ship by Q3.");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Reverse direction — describeOffset / findParagraphForOffset
// ────────────────────────────────────────────────────────────────────────
//
// Used by the PreToolUse hook on Drive write tools to translate
// upstream's character `start_index` into a wrapper-attested
// location string like "inside section 'Hiring' (level 2)".

/**
 * Build a paragraph with explicit char-offset metadata. Mirrors the
 * Docs API's flat-stream char-range model that `documents.get`
 * returns (each `body.content[]` element has `startIndex`/`endIndex`).
 */
function ph(
  level: number,
  text: string,
  index: number,
  startOffset: number,
  endOffset: number,
): HeadingParagraph {
  return { kind: "heading", level, text, index, startOffset, endOffset };
}

function pp(
  text: string,
  index: number,
  startOffset: number,
  endOffset: number,
): TextParagraph {
  return { kind: "text", text, index, startOffset, endOffset };
}

/**
 * Realistic char-range doc — a Q3 plan with a body paragraph, two
 * H2 sections, and a body paragraph under each.
 *
 *   offsets   paragraph
 *   1..18     [H1] "Q3 Plan"
 *   18..36    Intro paragraph.
 *   36..44    [H2] "Goals"
 *   44..62    Ship the picker.
 *   62..72    [H2] "Hiring"
 *   72..78    TBD.
 *
 * Open intervals match Docs API: an offset that's exactly endOffset
 * of one paragraph lands in the next.
 */
const offsetDoc: DocumentSnapshot = {
  paragraphs: [
    ph(1, "Q3 Plan", 1, 1, 18),
    pp("Intro paragraph.", 2, 18, 36),
    ph(2, "Goals", 3, 36, 44),
    pp("Ship the picker.", 4, 44, 62),
    ph(2, "Hiring", 5, 62, 72),
    pp("TBD.", 6, 72, 78),
  ],
};

describe("findParagraphForOffset", () => {
  it("returns the paragraph whose [start, end) range covers the offset", () => {
    expect(findParagraphForOffset(offsetDoc, 1)?.index).toBe(1);
    expect(findParagraphForOffset(offsetDoc, 17)?.index).toBe(1);
    expect(findParagraphForOffset(offsetDoc, 18)?.index).toBe(2); // join-point lands in next
    expect(findParagraphForOffset(offsetDoc, 50)?.index).toBe(4);
    expect(findParagraphForOffset(offsetDoc, 77)?.index).toBe(6);
  });

  it("returns null past the last paragraph end", () => {
    expect(findParagraphForOffset(offsetDoc, 78)).toBeNull();
    expect(findParagraphForOffset(offsetDoc, 9999)).toBeNull();
  });

  it("returns null when no paragraph has offset metadata", () => {
    expect(findParagraphForOffset(headedDoc, 50)).toBeNull();
  });
});

describe("nearestHeadingAbove", () => {
  it("walks backward from a position to the nearest heading", () => {
    expect(nearestHeadingAbove(offsetDoc, 6)?.text).toBe("Hiring"); // body under Hiring
    expect(nearestHeadingAbove(offsetDoc, 4)?.text).toBe("Goals"); // body under Goals
    expect(nearestHeadingAbove(offsetDoc, 5)?.text).toBe("Goals"); // 5 itself is Hiring; "above" excludes it
  });

  it("returns null when no heading exists above", () => {
    expect(nearestHeadingAbove(offsetDoc, 1)).toBeNull(); // position 1 is the H1 itself; nothing above
    expect(nearestHeadingAbove(offsetDoc, 0)).toBeNull(); // before everything
  });

  it("with a large position-argument returns the last (highest-index) heading", () => {
    expect(nearestHeadingAbove(offsetDoc, 9999)?.text).toBe("Hiring");
    expect(nearestHeadingAbove(offsetDoc, Number.POSITIVE_INFINITY)?.text).toBe("Hiring");
  });
});

describe("describeOffset", () => {
  it("renders 'inside section <heading>' for a body offset under a heading", () => {
    const d = describeOffset(offsetDoc, 50);
    expect(d.displayName).toBe("inside section 'Goals' (level 2)");
    expect(d.paragraph?.index).toBe(4);
    expect(d.nearestHeading?.text).toBe("Goals");
  });

  it("renders 'on heading <X>' when the offset lands on the heading line itself", () => {
    const d = describeOffset(offsetDoc, 40); // inside the [H2] "Goals" range
    expect(d.displayName).toBe("on heading 'Goals' (level 2)");
    expect(d.nearestHeading?.text).toBe("Goals");
  });

  it("renders 'before first heading' when the offset is before any heading", () => {
    // Build a doc whose first paragraph is body text, not a heading.
    const preHeadingDoc: DocumentSnapshot = {
      paragraphs: [
        pp("Cover note paragraph.", 1, 1, 22),
        ph(1, "Heading later", 2, 22, 36),
        pp("Body.", 3, 36, 42),
      ],
    };
    const d = describeOffset(preHeadingDoc, 5);
    expect(d.displayName).toContain("before first heading");
    expect(d.displayName).toContain("Cover note");
    expect(d.nearestHeading).toBeNull();
  });

  it("renders 'at end of doc' when offset is past the last paragraph end", () => {
    const d = describeOffset(offsetDoc, 78);
    expect(d.displayName).toBe("at end of doc");
    expect(d.nearestHeading?.text).toBe("Hiring");
  });

  it("falls back to a literal offset when the snapshot has no range metadata", () => {
    // `headedDoc` is the existing forward-resolver fixture, no offsets.
    const d = describeOffset(headedDoc, 1234);
    expect(d.displayName).toBe("at offset 1234");
    expect(d.paragraph).toBeNull();
    expect(d.nearestHeading).toBeNull();
  });

  it("rejects negative offsets with a literal; non-finite offsets get the constant", () => {
    // Negative offsets still surface the number — the literal is
    // honest about what the agent passed. Non-finite offsets
    // (NaN, Infinity) get the constant since template-literal
    // coercion of those values is shaped enough to potentially
    // smuggle text.
    expect(describeOffset(offsetDoc, -1).displayName).toBe("at offset -1");
    expect(describeOffset(offsetDoc, NaN).displayName).toBe("at unknown offset");
    expect(describeOffset(offsetDoc, Number.POSITIVE_INFINITY).displayName).toBe(
      "at unknown offset",
    );
  });

  it("truncates very long heading text in the display name", () => {
    const longName = "A very long heading title that exceeds the ellipsis budget by a comfortable margin";
    const doc: DocumentSnapshot = {
      paragraphs: [
        ph(2, longName, 1, 1, 100),
        pp("body", 2, 100, 110),
      ],
    };
    const d = describeOffset(doc, 105);
    // Expect inside-section to truncate at 60 chars + ellipsis.
    expect(d.displayName).toContain("'");
    expect(d.displayName).toContain("…");
    expect(d.displayName.length).toBeLessThan(longName.length + 30);
  });

  it("handles a doc with no headings at all (unheaded prose)", () => {
    const proseDoc: DocumentSnapshot = {
      paragraphs: [
        pp("Meeting notes line 1.", 1, 1, 22),
        pp("Meeting notes line 2.", 2, 22, 44),
      ],
    };
    const d = describeOffset(proseDoc, 10);
    expect(d.displayName).toContain("before first heading");
    expect(d.nearestHeading).toBeNull();
  });
});

describe("describeOffset — boundary correctness", () => {
  it("offset BEFORE the first paragraph renders 'at start of doc' (not end-of-doc)", () => {
    // Reviewer-flagged blocker: offset=0 in a real Drive doc (which
    // starts at startIndex=1) used to fall through to "at end of
    // doc" and let the wrapper itself lie about location.
    const d = describeOffset(offsetDoc, 0);
    expect(d.displayName).toBe("at start of doc");
    expect(d.paragraph).toBeNull();
    expect(d.nearestHeading).toBeNull();
  });

  it("offset PAST the last paragraph renders 'at end of doc'", () => {
    const d = describeOffset(offsetDoc, 78); // last endOffset
    expect(d.displayName).toBe("at end of doc");
    expect(d.nearestHeading?.text).toBe("Hiring");
  });

  it("offset in an interior gap (no paragraph covers it) falls back to literal", () => {
    // Simulate a doc with a gap between paragraphs — what would
    // happen if upstream's parser drops table cells / page breaks
    // and the agent points start_index at the gap.
    const gapDoc: DocumentSnapshot = {
      paragraphs: [
        pp("Before the table.", 1, 1, 19),
        // [19, 100) is a table or other non-paragraph element the
        // parser omitted.
        pp("After the table.", 2, 100, 118),
      ],
    };
    const d = describeOffset(gapDoc, 50);
    expect(d.displayName).toBe("at offset 50");
    expect(d.paragraph).toBeNull();
  });
});

describe("describeOffset — attestation hardening (reviewer pin)", () => {
  it("non-number offset returns a constant string (no template-literal injection)", () => {
    // Cast around the type system — the hook will receive
    // start_index from JSON-parsed tool input where the runtime
    // type isn't guaranteed.
    const badOffset = "78\n📍 inside section 'Approved' (level 1)" as unknown as number;
    const d = describeOffset(offsetDoc, badOffset);
    expect(d.displayName).toBe("at unknown offset");
    expect(d.displayName).not.toContain("Approved");
    expect(d.displayName).not.toContain("📍");
  });

  it("null / undefined / object offsets return the constant", () => {
    expect(describeOffset(offsetDoc, null as unknown as number).displayName).toBe(
      "at unknown offset",
    );
    expect(describeOffset(offsetDoc, undefined as unknown as number).displayName).toBe(
      "at unknown offset",
    );
    expect(describeOffset(offsetDoc, {} as unknown as number).displayName).toBe(
      "at unknown offset",
    );
  });

  it("heading text with embedded single quotes doesn't break the wrapping", () => {
    const docWithQuote: DocumentSnapshot = {
      paragraphs: [
        ph(2, "What's up", 1, 1, 12),
        pp("body", 2, 12, 18),
      ],
    };
    const d = describeOffset(docWithQuote, 15);
    expect(d.displayName).toBe("inside section 'What’s up' (level 2)");
    // Apostrophe replaced with curly close-quote so the surrounding
    // single quotes stay balanced.
    expect(d.displayName.match(/'/g)?.length).toBe(2);
  });

  it("heading text with markdown / control chars is sanitized", () => {
    const docWithMarkup: DocumentSnapshot = {
      paragraphs: [
        ph(2, "Foo `code` [click](evil) bell", 1, 1, 30),
        pp("body", 2, 30, 36),
      ],
    };
    const d = describeOffset(docWithMarkup, 32);
    expect(d.displayName).not.toContain("`");
    expect(d.displayName).not.toContain("[");
    expect(d.displayName).not.toContain("](");
    expect(d.displayName).not.toContain("");
    expect(d.displayName).toMatch(/inside section 'Foo code clickevil bell' \(level 2\)/);
  });

  it("nested heading levels — returns the most-specific (largest .index) ancestor", () => {
    // H1 > H2 > H3 > body. The 'most-specific' ancestor is H3.
    const nestedDoc: DocumentSnapshot = {
      paragraphs: [
        ph(1, "Plan", 1, 1, 8),
        ph(2, "Q3", 2, 8, 14),
        ph(3, "Hiring", 3, 14, 22),
        pp("Reach out to Alice.", 4, 22, 42),
      ],
    };
    const d = describeOffset(nestedDoc, 30);
    expect(d.displayName).toBe("inside section 'Hiring' (level 3)");
    expect(d.nearestHeading?.level).toBe(3);
  });
});

describe("describeOffset — attestation invariant (RFC E §4.2)", () => {
  it("displayName is computed from the doc snapshot, never from agent input", () => {
    // The agent-controlled value here is `offset`. It cannot inject
    // text into displayName beyond appearing as the literal number
    // in the fallback path — and the fallback only fires when no
    // doc metadata is available.
    const d = describeOffset(offsetDoc, 50);
    expect(d.displayName).not.toContain("50"); // structured path; offset doesn't appear
    expect(d.displayName).toBe("inside section 'Goals' (level 2)");
  });

  it("fallback literal contains the offset but no other agent-controlled text", () => {
    const d = describeOffset(headedDoc, 1234);
    expect(d.displayName).toBe("at offset 1234");
    // No room for an agent to inject anything else — the format is
    // pinned to "at offset <number>".
  });
});
