/**
 * Section-anchor editing primitive — RFC E §4.5.
 *
 * Pure resolver. Takes an anchor (the agent's stated where-to-edit) plus
 * a structural snapshot of the doc, returns either a `Resolved` position
 * the wrapper can act on, or an error the wrapper surfaces back to the
 * agent verbatim.
 *
 * Three anchor types, in priority order:
 *
 *   1. Heading-based (preferred for headed docs):
 *      { after_heading: "Goals", level?: number, nth_match?: number }
 *      { append_to_section: "Hiring", level?: number, nth_match?: number }
 *
 *   2. Text-snippet (covers unheaded docs — meeting notes, draft prose):
 *      { after_line_containing: "we agreed to ship by Q3", nth_match?: number }
 *      { before_line_containing: "Action items:", nth_match?: number }
 *      { replace_line_matching: /TBD: hiring section/, nth_match?: number }
 *
 *   3. Document-position fallback (last resort, empty / very short docs):
 *      { at_start: true } | { at_end: true }
 *
 * The "resolved anchor" returned on success is what the diff-preview
 * card surfaces to the user (per RFC E §4.2). The agent cannot
 * override the resolved-name string — that's the load-bearing detail
 * that defends against the "summary lies about intent" attack.
 *
 * Phase 1b ships the resolver. Phase 1c wires it to the suggesting-edit
 * tool + the diff-preview card.
 */

// ────────────────────────────────────────────────────────────────────────
// Anchor types (input — what the agent passes to gdrive_suggest_edit)
// ────────────────────────────────────────────────────────────────────────

export type Anchor =
  | HeadingAnchor
  | SnippetAnchor
  | PositionAnchor;

export interface HeadingAnchor {
  /** Insert immediately after the heading line itself. */
  after_heading?: string;
  /** Append to the end of the section under this heading (before the next same-or-higher level). */
  append_to_section?: string;
  /** Optional disambiguator: 1-based heading level (1=H1, 2=H2, etc). When unset, any level matches. */
  level?: number;
  /** Optional disambiguator when multiple headings match by title+level: 1-based index of which match to pick. Defaults to the only match (errors if ambiguous and unset). */
  nth_match?: number;
}

export interface SnippetAnchor {
  /** Insert after the FIRST line whose text contains this substring (case-insensitive). */
  after_line_containing?: string;
  /** Insert before the FIRST line whose text contains this substring (case-insensitive). */
  before_line_containing?: string;
  /** Replace the entire line whose text matches this regex. */
  replace_line_matching?: RegExp;
  /** Optional disambiguator when multiple lines match: 1-based index. Required if there are 2+ matches. */
  nth_match?: number;
}

export interface PositionAnchor {
  at_start?: boolean;
  at_end?: boolean;
}

// ────────────────────────────────────────────────────────────────────────
// Document AST (input — supplied by the wrapper from documents.get)
// ────────────────────────────────────────────────────────────────────────

export type Paragraph = HeadingParagraph | TextParagraph;

export interface HeadingParagraph {
  kind: "heading";
  /** 1-based: 1 = H1, 2 = H2, etc. */
  level: number;
  /** Plain-text rendering of the heading title (no formatting runs). */
  text: string;
  /** Stable per-doc index — what the wrapper uses to address insert/delete. */
  index: number;
  /**
   * Optional inclusive char-range covering this paragraph in the Docs
   * API `body.content[]` model. Required for `describeOffset()` to
   * find which paragraph an arbitrary character offset (the unit
   * `taylorwilsdon/google_workspace_mcp` write tools take as
   * `start_index`/`end_index`) lands in. Optional so the
   * resolver-direction tests don't need to specify ranges.
   */
  startOffset?: number;
  endOffset?: number;
}

export interface TextParagraph {
  kind: "text";
  /** Plain-text rendering of the paragraph (no formatting runs). */
  text: string;
  /** Stable per-doc index — what the wrapper uses to address insert/delete. */
  index: number;
  /** See `HeadingParagraph.startOffset`. */
  startOffset?: number;
  endOffset?: number;
}

export interface DocumentSnapshot {
  paragraphs: Paragraph[];
}

// ────────────────────────────────────────────────────────────────────────
// Resolver result types (output — what the wrapper acts on)
// ────────────────────────────────────────────────────────────────────────

/** Where in the doc the wrapper should perform the edit. */
export type ResolvedOp =
  | { kind: "insert_after"; paragraphIndex: number }
  | { kind: "insert_before"; paragraphIndex: number }
  | { kind: "replace_paragraph"; paragraphIndex: number }
  | {
      kind: "append_to_section_end";
      /** Index of LAST body paragraph in the section. */
      paragraphIndex: number;
    }
  | {
      kind: "append_to_empty_section";
      /** Index of the heading itself — the section has no body paragraphs to append after. Wrapper inserts a new body paragraph immediately after this heading. */
      paragraphIndex: number;
    };

export interface ResolvedAnchor {
  op: ResolvedOp;
  /** Human-readable name surfaced on the diff-preview card per RFC E §4.2. AGENT CANNOT OVERRIDE THIS. */
  displayName: string;
}

export type AnchorErrorCode =
  | "HEADING_NOT_FOUND"
  | "HEADING_AMBIGUOUS"
  | "SNIPPET_NOT_FOUND"
  | "SNIPPET_AMBIGUOUS"
  | "NTH_MATCH_OUT_OF_RANGE"
  | "EMPTY_DOC_NEEDS_POSITION"
  | "INVALID_ANCHOR";

export interface AnchorError {
  code: AnchorErrorCode;
  /** Operator-actionable message the wrapper surfaces to the agent verbatim. */
  message: string;
  /** When >0, includes per-match context excerpts so the agent can pick by nth_match. */
  candidates?: Array<{ index: number; excerpt: string }>;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedAnchor }
  | { ok: false; error: AnchorError };

// ────────────────────────────────────────────────────────────────────────
// Resolver
// ────────────────────────────────────────────────────────────────────────

export function resolveAnchor(
  anchor: Anchor,
  doc: DocumentSnapshot,
): ResolveResult {
  // Dispatch in RFC E §4.5 priority order.
  if (isHeadingAnchor(anchor)) return resolveHeading(anchor, doc);
  if (isSnippetAnchor(anchor)) return resolveSnippet(anchor, doc);
  if (isPositionAnchor(anchor)) return resolvePosition(anchor, doc);
  return {
    ok: false,
    error: {
      code: "INVALID_ANCHOR",
      message:
        "Anchor must specify one of: heading-based (after_heading / append_to_section), text-snippet (after_line_containing / before_line_containing / replace_line_matching), or document-position (at_start / at_end).",
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Heading-based
// ────────────────────────────────────────────────────────────────────────

function resolveHeading(
  anchor: HeadingAnchor,
  doc: DocumentSnapshot,
): ResolveResult {
  const target = anchor.after_heading ?? anchor.append_to_section;
  if (target === undefined) {
    return invalidAnchor("Heading anchor must set after_heading or append_to_section");
  }

  const matches: HeadingParagraph[] = [];
  for (const p of doc.paragraphs) {
    if (p.kind !== "heading") continue;
    if (p.text !== target) continue;
    if (anchor.level !== undefined && p.level !== anchor.level) continue;
    matches.push(p);
  }

  if (matches.length === 0) {
    return notFound(
      "HEADING_NOT_FOUND",
      `Couldn't find heading '${target}'${anchor.level !== undefined ? ` at level ${anchor.level}` : ""} in current doc. Try after_line_containing: "..." or pick a different anchor.`,
    );
  }

  const picked = pickByNthMatch(matches, anchor.nth_match);
  if (picked === null) {
    if (anchor.nth_match !== undefined) {
      // Operator did disambiguate — they just picked an index that
      // doesn't exist. Distinct error so the message is honest.
      return outOfRange(
        `nth_match=${anchor.nth_match} exceeds the ${matches.length} matching heading${matches.length === 1 ? "" : "s"} titled '${target}'${anchor.level !== undefined ? ` at level ${anchor.level}` : ""}. Valid range: 1..${matches.length}.`,
        matches.map((m) => ({
          index: m.index,
          excerpt: `(${ordinalLevel(m.level)}) ${m.text}`,
        })),
      );
    }
    return ambiguous(
      "HEADING_AMBIGUOUS",
      `Found ${matches.length} headings titled '${target}'${anchor.level !== undefined ? ` at level ${anchor.level}` : ""}. Specify nth_match (1..${matches.length}) to disambiguate.`,
      matches.map((m) => ({
        index: m.index,
        excerpt: `(${ordinalLevel(m.level)}) ${m.text}`,
      })),
    );
  }

  if (anchor.append_to_section !== undefined) {
    // Find the last BODY paragraph in this heading's section. If the
    // section is empty (heading immediately followed by another
    // same-or-higher heading, or heading is the last paragraph in the
    // doc), we return a distinct op so the wrapper knows to insert
    // a fresh paragraph after the heading rather than appending to
    // the heading itself (which would corrupt heading text).
    const sectionEnd = findSectionEnd(picked, doc);
    if (sectionEnd.empty) {
      return {
        ok: true,
        resolved: {
          op: {
            kind: "append_to_empty_section",
            paragraphIndex: picked.index,
          },
          displayName: `end of section '${picked.text}' (${ordinalLevel(picked.level)}, currently empty)`,
        },
      };
    }
    return {
      ok: true,
      resolved: {
        op: {
          kind: "append_to_section_end",
          paragraphIndex: sectionEnd.lastBodyIndex,
        },
        displayName: `end of section '${picked.text}' (${ordinalLevel(picked.level)})`,
      },
    };
  }

  return {
    ok: true,
    resolved: {
      op: { kind: "insert_after", paragraphIndex: picked.index },
      displayName: `after heading '${picked.text}' (${ordinalLevel(picked.level)})`,
    },
  };
}

/**
 * Result of locating the end of a heading's section.
 * - `empty: true`      — the heading has no body paragraphs (next sibling
 *                        is another same-or-higher heading, or the heading
 *                        is the last paragraph in the doc).
 * - `lastBodyIndex`    — paragraphIndex of the LAST body paragraph in the
 *                        section. Only set when `empty: false`.
 */
type SectionEnd =
  | { empty: true }
  | { empty: false; lastBodyIndex: number };

function findSectionEnd(
  heading: HeadingParagraph,
  doc: DocumentSnapshot,
): SectionEnd {
  const arrPos = doc.paragraphs.findIndex((p) => p === heading);
  if (arrPos === -1) return { empty: true }; // shouldn't happen — defensive
  for (let i = arrPos + 1; i < doc.paragraphs.length; i++) {
    const p = doc.paragraphs[i];
    if (p.kind === "heading" && p.level <= heading.level) {
      // Section ends at the paragraph BEFORE this same-or-higher heading.
      // If that paragraph IS the heading we started from (i.e. arrPos +
      // 1 == this heading), the section is empty.
      if (i === arrPos + 1) return { empty: true };
      return { empty: false, lastBodyIndex: doc.paragraphs[i - 1].index };
    }
  }
  // No following same-or-higher heading.
  if (arrPos === doc.paragraphs.length - 1) {
    // Heading is the last paragraph — section is empty.
    return { empty: true };
  }
  return {
    empty: false,
    lastBodyIndex: doc.paragraphs[doc.paragraphs.length - 1].index,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Text-snippet
// ────────────────────────────────────────────────────────────────────────

function resolveSnippet(
  anchor: SnippetAnchor,
  doc: DocumentSnapshot,
): ResolveResult {
  const after = anchor.after_line_containing;
  const before = anchor.before_line_containing;
  const replace = anchor.replace_line_matching;
  const setCount = [after, before, replace].filter((x) => x !== undefined).length;
  if (setCount !== 1) {
    return invalidAnchor(
      "Snippet anchor must set exactly one of: after_line_containing, before_line_containing, replace_line_matching.",
    );
  }
  // Reject empty/whitespace-only snippet strings up front. `''.includes('')`
  // is true, so an empty string would silently match every paragraph and
  // dump the operator into a SNIPPET_AMBIGUOUS error with no clue what
  // went wrong.
  if (after !== undefined && after.trim() === "") {
    return invalidAnchor(
      "after_line_containing must be a non-empty, non-whitespace search string.",
    );
  }
  if (before !== undefined && before.trim() === "") {
    return invalidAnchor(
      "before_line_containing must be a non-empty, non-whitespace search string.",
    );
  }

  type Match = { paragraph: Paragraph; matchedText: string };
  const matches: Match[] = [];
  for (const p of doc.paragraphs) {
    const matchedText = matchSnippet(p, after, before, replace);
    if (matchedText !== null) matches.push({ paragraph: p, matchedText });
  }

  if (matches.length === 0) {
    const term = (after ?? before ?? String(replace ?? "")).slice(0, 50);
    return notFound(
      "SNIPPET_NOT_FOUND",
      `Couldn't find any line containing/matching '${term}' in current doc. Re-read the doc and try a different snippet, or use a heading anchor if the doc has headings.`,
    );
  }

  if (matches.length > 1 && anchor.nth_match === undefined) {
    return ambiguous(
      "SNIPPET_AMBIGUOUS",
      `Found ${matches.length} lines matching the snippet. Specify nth_match (1..${matches.length}) to disambiguate.`,
      matches.slice(0, 3).map((m, i) => ({
        index: m.paragraph.index,
        excerpt: `match ${i + 1}: "${ellipsize(m.matchedText, 80)}"`,
      })),
    );
  }

  const picked = pickByNthMatch(matches, anchor.nth_match);
  if (picked === null) {
    if (anchor.nth_match !== undefined) {
      return outOfRange(
        `nth_match=${anchor.nth_match} exceeds the ${matches.length} matching line${matches.length === 1 ? "" : "s"}. Valid range: 1..${matches.length}.`,
        matches.slice(0, 3).map((m, i) => ({
          index: m.paragraph.index,
          excerpt: `match ${i + 1}: "${ellipsize(m.matchedText, 80)}"`,
        })),
      );
    }
    return ambiguous(
      "SNIPPET_AMBIGUOUS",
      `Found ${matches.length} lines matching the snippet. Specify nth_match (1..${matches.length}) to disambiguate.`,
      matches.slice(0, 3).map((m, i) => ({
        index: m.paragraph.index,
        excerpt: `match ${i + 1}: "${ellipsize(m.matchedText, 80)}"`,
      })),
    );
  }

  if (after !== undefined) {
    return {
      ok: true,
      resolved: {
        op: { kind: "insert_after", paragraphIndex: picked.paragraph.index },
        displayName: `after line: "${ellipsize(picked.matchedText, 60)}"`,
      },
    };
  }
  if (before !== undefined) {
    return {
      ok: true,
      resolved: {
        op: { kind: "insert_before", paragraphIndex: picked.paragraph.index },
        displayName: `before line: "${ellipsize(picked.matchedText, 60)}"`,
      },
    };
  }
  // replace
  return {
    ok: true,
    resolved: {
      op: { kind: "replace_paragraph", paragraphIndex: picked.paragraph.index },
      displayName: `replacing line: "${ellipsize(picked.matchedText, 60)}"`,
    },
  };
}

function matchSnippet(
  p: Paragraph,
  after?: string,
  before?: string,
  replace?: RegExp,
): string | null {
  const haystack = p.text;
  const lc = haystack.toLowerCase();
  if (after !== undefined) {
    return lc.includes(after.toLowerCase()) ? haystack : null;
  }
  if (before !== undefined) {
    return lc.includes(before.toLowerCase()) ? haystack : null;
  }
  if (replace !== undefined) {
    return replace.test(haystack) ? haystack : null;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Document-position
// ────────────────────────────────────────────────────────────────────────

function resolvePosition(
  anchor: PositionAnchor,
  doc: DocumentSnapshot,
): ResolveResult {
  if (doc.paragraphs.length === 0) {
    return {
      ok: false,
      error: {
        code: "EMPTY_DOC_NEEDS_POSITION",
        message:
          "Doc is empty — nothing to anchor against. The wrapper will insert at position 1.",
      },
    };
  }
  if (anchor.at_start === true && anchor.at_end !== true) {
    const first = doc.paragraphs[0];
    return {
      ok: true,
      resolved: {
        op: { kind: "insert_before", paragraphIndex: first.index },
        displayName: "at start of doc",
      },
    };
  }
  if (anchor.at_end === true && anchor.at_start !== true) {
    const last = doc.paragraphs[doc.paragraphs.length - 1];
    return {
      ok: true,
      resolved: {
        op: { kind: "insert_after", paragraphIndex: last.index },
        displayName: "at end of doc",
      },
    };
  }
  return invalidAnchor(
    "Position anchor must set exactly one of at_start: true or at_end: true.",
  );
}

// ────────────────────────────────────────────────────────────────────────
// Type guards + helpers
// ────────────────────────────────────────────────────────────────────────

function isHeadingAnchor(a: Anchor): a is HeadingAnchor {
  return (
    (a as HeadingAnchor).after_heading !== undefined ||
    (a as HeadingAnchor).append_to_section !== undefined
  );
}

function isSnippetAnchor(a: Anchor): a is SnippetAnchor {
  return (
    (a as SnippetAnchor).after_line_containing !== undefined ||
    (a as SnippetAnchor).before_line_containing !== undefined ||
    (a as SnippetAnchor).replace_line_matching !== undefined
  );
}

function isPositionAnchor(a: Anchor): a is PositionAnchor {
  return (
    (a as PositionAnchor).at_start === true ||
    (a as PositionAnchor).at_end === true
  );
}

function pickByNthMatch<T>(matches: T[], nthMatch: number | undefined): T | null {
  if (matches.length === 1) return matches[0];
  if (nthMatch === undefined) return null;
  if (nthMatch < 1 || nthMatch > matches.length) return null;
  return matches[nthMatch - 1];
}

function ordinalLevel(level: number): string {
  return `level ${level}`;
}

function ellipsize(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function notFound(
  code: AnchorErrorCode,
  message: string,
): ResolveResult {
  return { ok: false, error: { code, message } };
}

function ambiguous(
  code: AnchorErrorCode,
  message: string,
  candidates: AnchorError["candidates"],
): ResolveResult {
  return { ok: false, error: { code, message, candidates } };
}

function outOfRange(
  message: string,
  candidates: AnchorError["candidates"],
): ResolveResult {
  return { ok: false, error: { code: "NTH_MATCH_OUT_OF_RANGE", message, candidates } };
}

function invalidAnchor(message: string): ResolveResult {
  return { ok: false, error: { code: "INVALID_ANCHOR", message } };
}

// ────────────────────────────────────────────────────────────────────────
// Reverse direction — character offset → wrapper-attested location
// ────────────────────────────────────────────────────────────────────────
//
// The forward path (resolveAnchor) is "agent gives an anchor name,
// wrapper computes the doc position." Reverse goes the other way:
// "upstream MCP write tool gives a `start_index` (Docs API character
// offset), wrapper computes the human-readable location the agent
// can't override." This is the load-bearing piece of the PreToolUse
// hook gating mcp__google-workspace__* writes — the user has to see
// where the edit lands, attested by the wrapper, before they tap
// Allow.
//
// taylorwilsdon/google_workspace_mcp tools all take character
// offsets (`start_index`, `end_index`) into the Docs API's
// flat character stream. `documents.get` returns each paragraph
// with its own `startIndex`/`endIndex` range in that stream;
// `parseDocsApiResponse` (callsite, not here) flattens that into
// our `DocumentSnapshot` with `startOffset`/`endOffset` per
// paragraph. `describeOffset` then locates which paragraph
// contains the requested offset and renders the heading-based
// display name.

export interface OffsetDescription {
  /** Human-readable, wrapper-attested. Goes on the `📍` line of the diff-preview card. */
  displayName: string;
  /** The paragraph the offset lands in, or null if the snapshot has no offset metadata. */
  paragraph: Paragraph | null;
  /** Nearest heading at or above the located paragraph, if any. */
  nearestHeading: HeadingParagraph | null;
}

/**
 * Locate which paragraph contains a Docs-API character offset and
 * render a wrapper-attested display name like `after heading
 * 'Goals' (level 2)` or `inside section 'Hiring'` or `at end of
 * doc`.
 *
 * Falls back to a literal `at offset N` when the snapshot has no
 * `startOffset`/`endOffset` metadata — the hook prefers the
 * structured form when Drive returned full paragraph ranges, and
 * the literal form when it couldn't (e.g. `documents.get` quota
 * error and the hook proceeds without doc context).
 */
export function describeOffset(
  doc: DocumentSnapshot,
  offset: number,
): OffsetDescription {
  // Hard runtime guard on the agent-controlled value. The PreToolUse
  // hook will pass `start_index` straight from a JSON-parsed tool
  // input; if a non-number sneaks past TypeScript (e.g. via the JSON
  // path), template-literal coercion would let the value land
  // verbatim in `displayName`. That's an attestation hole — return a
  // constant string instead.
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    return {
      displayName:
        typeof offset === "number" && Number.isFinite(offset)
          ? `at offset ${offset}`
          : "at unknown offset",
      paragraph: null,
      nearestHeading: null,
    };
  }

  const located = findParagraphForOffset(doc, offset);
  if (located === null) {
    // Distinguish before-start, past-end, and "no metadata" — the
    // earlier code treated all three as "at end of doc" which lets
    // an offset=0 write be attested as end-of-doc (RFC §4.2 lie-by-
    // wrapper). Now:
    //   * No paragraph has offset metadata → literal fallback.
    //   * Offset < first paragraph startOffset → "at start of doc".
    //   * Offset >= last paragraph endOffset → "at end of doc".
    //   * Offset in an interior gap (table cells, page breaks, etc.
    //     between paragraphs) → literal fallback rather than
    //     guessing — the parser is upstream's concern and we'd
    //     rather mis-render than mis-attest.
    if (doc.paragraphs.length === 0) {
      return {
        displayName: `at offset ${offset}`,
        paragraph: null,
        nearestHeading: null,
      };
    }
    const first = doc.paragraphs[0]!;
    const last = doc.paragraphs[doc.paragraphs.length - 1]!;
    if (!hasOffsets(first) || !hasOffsets(last)) {
      return {
        displayName: `at offset ${offset}`,
        paragraph: null,
        nearestHeading: null,
      };
    }
    if (offset < first.startOffset!) {
      return {
        displayName: "at start of doc",
        paragraph: null,
        nearestHeading: null,
      };
    }
    if (offset >= last.endOffset!) {
      // For "end of doc" we want the *last* heading in the entire
      // document, regardless of its `.index` value. Pass Infinity
      // so the "strictly above" filter degenerates to "any
      // heading", and the largest-index one wins.
      return {
        displayName: "at end of doc",
        paragraph: null,
        nearestHeading: nearestHeadingAbove(doc, Number.POSITIVE_INFINITY),
      };
    }
    // Interior gap — surface the literal offset and let the user
    // see the raw number rather than confidently attesting the
    // wrong location.
    return {
      displayName: `at offset ${offset}`,
      paragraph: null,
      nearestHeading: null,
    };
  }

  // If the located paragraph IS a heading, the agent is editing the
  // heading line itself — surface that directly so the user sees
  // they're touching the section title, not the body.
  if (located.kind === "heading") {
    return {
      displayName: `on heading '${truncateLine(located.text)}' (${ordinalLevel(located.level)})`,
      paragraph: located,
      nearestHeading: located,
    };
  }

  const heading = nearestHeadingAbove(doc, located.index);
  if (heading === null) {
    // No heading above — either an unheaded doc or the edit lands
    // before the first heading.
    const preview = previewOfNeighborhood(doc, located.index);
    return {
      displayName: preview
        // Same single-quote wrapping as the other displayName shapes
        // so truncateLine's `'` → `’` substitution covers the
        // body-text-contains-quote case symmetrically (otherwise a
        // body line with a literal `"` would unbalance the
        // parenthetical).
        ? `before first heading (near '${preview}')`
        : `before first heading`,
      paragraph: located,
      nearestHeading: null,
    };
  }

  return {
    displayName: `inside section '${truncateLine(heading.text)}' (${ordinalLevel(heading.level)})`,
    paragraph: located,
    nearestHeading: heading,
  };
}

/**
 * Find the paragraph whose char-range covers `offset`. Returns null
 * when no paragraph has offset metadata, or when `offset` lies
 * past the last paragraph's `endOffset`.
 *
 * Linear walk — doc paragraph counts are O(100s) for the realistic
 * case; binary search would be premature.
 */
export function findParagraphForOffset(
  doc: DocumentSnapshot,
  offset: number,
): Paragraph | null {
  for (const p of doc.paragraphs) {
    if (!hasOffsets(p)) continue;
    // Docs API ranges are half-open: paragraph covers [startIndex, endIndex).
    // Replicate that semantics so an offset that's the exact endOffset
    // of paragraph N lands in paragraph N+1 (the join-point).
    if (offset >= p.startOffset! && offset < p.endOffset!) {
      return p;
    }
  }
  return null;
}

/**
 * Find the heading with the largest `.index` that's STRICTLY less
 * than `paragraphPosition` (i.e. strictly above). Returns null when
 * no such heading exists.
 *
 * Semantics work in terms of the paragraph `.index` field — not
 * the position in `doc.paragraphs[]`. Mirrors how the forward
 * resolvers index into the doc, and lets callers reason in the
 * same coordinate system the agent-facing tools use.
 *
 * Callers should typically NOT call this with a heading's own
 * `.index` and expect to get that heading back — the "strictly
 * above" semantics deliberately excludes self. See `describeOffset`
 * for the offset-lands-on-a-heading case, which short-circuits
 * before calling here.
 */
export function nearestHeadingAbove(
  doc: DocumentSnapshot,
  paragraphPosition: number,
): HeadingParagraph | null {
  let best: HeadingParagraph | null = null;
  for (const p of doc.paragraphs) {
    if (p.kind !== "heading") continue;
    if (p.index >= paragraphPosition) continue;
    if (best === null || p.index > best.index) best = p;
  }
  return best;
}

function hasOffsets(p: Paragraph): p is Paragraph & { startOffset: number; endOffset: number } {
  return (
    typeof p.startOffset === "number" &&
    typeof p.endOffset === "number" &&
    p.endOffset > p.startOffset
  );
}

/**
 * Sanitize doc-content text before embedding in the `displayName`
 * string. The wrapper-attested name lands on the diff-preview card
 * and (after PR-2) gets HTML-escaped by the gateway renderer — but
 * defense in depth here keeps the *intermediate* form safe in the
 * audit row, log lines, and any non-Telegram surface that doesn't
 * apply its own escape.
 *
 * Strips: control chars, backticks (markdown code marker), brackets
 * and parens that could form a markdown link. Escapes embedded
 * single quotes so the surrounding `'…'` wrapping in the
 * displayName ("on heading 'X' (level 2)") doesn't get
 * unbalanced by a heading whose text already contains `'`.
 */
function truncateLine(s: string): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex -- intentional strip
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[`[\]()]/g, "")
    .replace(/'/g, "’") // ' → ’ (curly close-single-quote)
    .replace(/\s+/g, " ")
    .trim();
  return ellipsize(cleaned, 60);
}

function previewOfNeighborhood(
  doc: DocumentSnapshot,
  paragraphIndex: number,
): string | null {
  for (let i = 0; i < doc.paragraphs.length; i++) {
    const p = doc.paragraphs[i]!;
    if (p.index === paragraphIndex && p.text.trim().length > 0) {
      return truncateLine(p.text);
    }
  }
  return null;
}
