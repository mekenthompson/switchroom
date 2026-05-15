/**
 * Google Docs API `documents.get` client + parser — RFC E §4.2.
 *
 * The PreToolUse hook (Path A Cut 2) intercepts upstream
 * `mcp__google-workspace__*` write tools and needs the doc's
 * paragraph structure to translate the agent's char-offset
 * `start_index` into a wrapper-attested location string. The
 * upstream MCP doesn't expose the unparsed Docs response shape, so
 * switchroom calls Docs API v1 directly using the same access token
 * the broker hands out.
 *
 * What this module ships:
 *   - `fetchDocumentSnapshot(args)`: HTTP call + parse to
 *     `DocumentSnapshot` (from `anchors.ts`) with paragraph-level
 *     `startOffset`/`endOffset` populated. Drops non-paragraph
 *     `body.content[]` elements (tables, page breaks, section
 *     breaks) — the reverse-anchor resolver handles their gaps as
 *     literal-offset fallbacks.
 *   - `parseDocumentResponse(raw)`: pure parser, exported for tests
 *     so the HTTP client doesn't have to be exercised every time.
 *
 * Used only by the PreToolUse hook today. Could be reused if more
 * features need read access to doc structure, but the agent-facing
 * read tools live in `taylorwilsdon/google_workspace_mcp` — this is
 * deliberately a private hook-side path.
 */

import type {
  DocumentSnapshot,
  HeadingParagraph,
  Paragraph,
  TextParagraph,
} from "./anchors.js";

// ────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────

export interface FetchDocumentOptions {
  /** Bearer token from auth-broker `get-credentials` (provider=google). */
  access_token: string;
  /** Drive doc id. */
  document_id: string;
  /** Test injection seam. */
  fetchImpl?: typeof fetch;
  /**
   * Optional include suggestions in the response. Default `DEFAULT_FOR_CURRENT_ACCESS`
   * which matches what upstream MCP does for its read tools.
   */
  suggestions_view_mode?:
    | "DEFAULT_FOR_CURRENT_ACCESS"
    | "SUGGESTIONS_INLINE"
    | "PREVIEW_SUGGESTIONS_ACCEPTED"
    | "PREVIEW_WITHOUT_SUGGESTIONS";
}

export interface FetchDocumentResult {
  /** The doc's title from Docs API `title` field. */
  title: string;
  /** Doc id (echoed for callers that pipe this straight into card builders). */
  document_id: string;
  /** Parsed paragraph tree, with offsets, ready for `describeOffset`. */
  snapshot: DocumentSnapshot;
}

// ────────────────────────────────────────────────────────────────────────
// HTTP client
// ────────────────────────────────────────────────────────────────────────

const DRIVE_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Call `documents.get` and parse the response into a structured
 * snapshot. Throws on non-2xx response or malformed body.
 *
 * Auth failure (401) is surfaced as an Error — the caller (hook)
 * maps that to the existing invalid_grant reconnect path. Rate
 * limits (429) and other 5xx errors get the literal HTTP status
 * in the error message so the hook's log line is diagnostic.
 */
export async function fetchDocumentSnapshot(
  options: FetchDocumentOptions,
): Promise<FetchDocumentResult> {
  if (!DRIVE_ID_RE.test(options.document_id)) {
    throw new Error(
      `Docs documents.get: invalid document_id '${options.document_id.slice(0, 30)}' — expected URL-safe-base64`,
    );
  }

  const url = new URL(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(options.document_id)}`,
  );
  if (options.suggestions_view_mode !== undefined) {
    url.searchParams.set("suggestionsViewMode", options.suggestions_view_mode);
  }

  const resp = await (options.fetchImpl ?? fetch)(url.toString(), {
    headers: {
      Authorization: `Bearer ${options.access_token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await safeReadText(resp);
    throw new Error(
      `Docs documents.get failed: HTTP ${resp.status} ${resp.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const raw = (await resp.json()) as unknown;
  return parseDocumentResponse(raw);
}

async function safeReadText(resp: Response): Promise<string | null> {
  try {
    const t = await resp.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────────

/**
 * Docs API response → DocumentSnapshot.
 *
 * The Docs v1 response shape we care about:
 *   {
 *     title: string,
 *     documentId: string,
 *     body: { content: [
 *       { startIndex, endIndex, paragraph: { elements: [{ textRun: { content } }], paragraphStyle: { namedStyleType } } },
 *       { startIndex, endIndex, table: ... },           // skipped
 *       { startIndex, endIndex, sectionBreak: ... },    // skipped
 *       { startIndex, endIndex, tableOfContents: ... }, // skipped
 *     ] }
 *   }
 *
 * paragraphStyle.namedStyleType determines whether a paragraph is a
 * heading: `HEADING_1` through `HEADING_6` map to levels 1-6;
 * anything else (`NORMAL_TEXT`, `TITLE`, `SUBTITLE`, undefined) is
 * a text paragraph.
 *
 * Pure — no I/O — so tests can verify the gap-handling, heading
 * level mapping, and edge cases without an HTTP stub.
 */
export function parseDocumentResponse(raw: unknown): FetchDocumentResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `Docs documents.get returned non-object body (got ${describeShape(raw)})`,
    );
  }
  const doc = raw as Record<string, unknown>;
  const documentId = typeof doc.documentId === "string" ? doc.documentId : "";
  if (!DRIVE_ID_RE.test(documentId)) {
    throw new Error(
      `Docs documents.get response missing valid documentId (got '${String(doc.documentId).slice(0, 30)}')`,
    );
  }
  const title = typeof doc.title === "string" ? doc.title : "";
  const body = doc.body as Record<string, unknown> | undefined;
  const contentArr = body !== undefined && Array.isArray(body.content)
    ? (body.content as Array<Record<string, unknown>>)
    : [];

  const paragraphs: Paragraph[] = [];
  let nextIndex = 1; // matches the .index field convention used by the forward resolver

  for (const element of contentArr) {
    if (typeof element !== "object" || element === null) continue;
    const startOffset = numberOr(element.startIndex);
    const endOffset = numberOr(element.endIndex);
    if (startOffset === null || endOffset === null) continue;
    if (endOffset <= startOffset) continue;

    const paragraph = element.paragraph as Record<string, unknown> | undefined;
    if (paragraph === undefined) {
      // Table / sectionBreak / tableOfContents / etc. — skip;
      // describeOffset's interior-gap branch handles offsets that
      // land in these regions.
      continue;
    }

    const text = flattenParagraphText(paragraph);
    const headingLevel = headingLevelFromStyle(paragraph);
    if (headingLevel !== null) {
      const h: HeadingParagraph = {
        kind: "heading",
        level: headingLevel,
        text,
        index: nextIndex,
        startOffset,
        endOffset,
      };
      paragraphs.push(h);
    } else {
      const p: TextParagraph = {
        kind: "text",
        text,
        index: nextIndex,
        startOffset,
        endOffset,
      };
      paragraphs.push(p);
    }
    nextIndex += 1;
  }

  return {
    title,
    document_id: documentId,
    snapshot: { paragraphs },
  };
}

function flattenParagraphText(paragraph: Record<string, unknown>): string {
  const elements = paragraph.elements;
  if (!Array.isArray(elements)) return "";
  const parts: string[] = [];
  for (const el of elements as Array<Record<string, unknown>>) {
    if (typeof el !== "object" || el === null) continue;
    const textRun = el.textRun as Record<string, unknown> | undefined;
    if (textRun === undefined) continue;
    if (typeof textRun.content === "string") {
      parts.push(textRun.content);
    }
  }
  // Drive's textRun.content for a paragraph typically ends in `\n`
  // (the paragraph break char that the Docs API counts in the
  // offset stream). Strip a single trailing newline so the
  // .text we hand to anchors.ts doesn't carry it — the offset
  // metadata captures the boundary; the displayed text doesn't
  // need to.
  let joined = parts.join("");
  if (joined.endsWith("\n")) joined = joined.slice(0, -1);
  return joined;
}

function headingLevelFromStyle(paragraph: Record<string, unknown>): number | null {
  const style = paragraph.paragraphStyle as Record<string, unknown> | undefined;
  if (style === undefined) return null;
  const named = style.namedStyleType;
  if (typeof named !== "string") return null;
  const m = /^HEADING_([1-6])$/.exec(named);
  return m === null ? null : parseInt(m[1]!, 10);
}

function numberOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function describeShape(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
