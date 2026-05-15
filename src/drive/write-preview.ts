/**
 * Diff-preview spec builder for the PreToolUse Drive-write hook —
 * RFC E §4.2 Path A Cut 2.
 *
 * Takes:
 *   1. An upstream `mcp__google-workspace__*` write tool name + its
 *      raw `tool_input` JSON (what the agent passed).
 *   2. A `FetchDocumentResult` (from `docs-get.ts`) — doc title +
 *      paragraph snapshot with offsets.
 *
 * Returns a `DiffPreviewInput` ready to feed `buildDiffPreview()`
 * (and from there `buildDiffPreviewCard()` for the actual Telegram
 * render).
 *
 * What this module ISN'T:
 *   - Not the HTTP client (that's `docs-get.ts`).
 *   - Not the kernel/IPC/Telegram caller (that's PR-2B + PR-2C).
 *   - Not the agent-summary parser (the agent doesn't supply one
 *     today — the hook receives raw tool_input from Claude Code,
 *     not a synthesized "intent" string. Future cuts may add an
 *     out-of-band sidecar; for now `agentSummary` stays undefined).
 *
 * Tool-shape-specific logic lives here because each upstream tool
 * encodes "where" and "what" differently:
 *   - `modify_doc_text` uses `start_index` + `text`
 *   - `find_and_replace_doc` uses `find_text` (no offset)
 *   - `insert_doc_elements` uses `index` + `element_type`
 *   - `batch_update_doc` uses a heterogeneous `operations[]` array
 *   - `create_doc` / `create_drive_file` use no offset (top of doc)
 *   - `update_drive_file` / `manage_drive_access` are metadata-only
 *
 * Each gets a translator below that produces a uniform
 * `DiffPreviewInput`. Tools we don't recognise return null — the
 * hook falls back to letting the tool fire ungated (defensive
 * default: hook gates known shapes only, so an upstream MCP
 * version bump that adds a new tool doesn't break agents).
 */

import { describeOffset, type DocumentSnapshot, type ResolvedAnchor } from "./anchors.js";
import type { DiffPreviewInput } from "./diff-preview.js";

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export interface BuildWritePreviewArgs {
  /** Agent slug — appears on the diff-preview card title. */
  agentName: string;
  /** Tool name as Claude Code sees it: `mcp__google-workspace__<fn>`. */
  toolName: string;
  /**
   * The raw tool_input the agent passed. Treated as untrusted JSON
   * — every field accessor narrows via runtime check.
   */
  toolInput: unknown;
  /** `documents.get` result for the doc the agent is editing. */
  doc: {
    title: string;
    document_id: string;
    snapshot: DocumentSnapshot;
  };
  /**
   * mimeType to feed the Open-in-Drive deep-link. Always
   * `application/vnd.google-apps.document` for Docs writes; passed
   * in rather than hard-coded so a future Sheets/Slides write
   * tool can reuse this path.
   */
  mimeType?: string;
}

export type BuildWritePreviewResult =
  | { ok: true; preview: DiffPreviewInput }
  | { ok: false; reason: "unrecognized_tool" | "missing_required_arg"; detail: string };

export function buildWritePreview(
  args: BuildWritePreviewArgs,
): BuildWritePreviewResult {
  const input = args.toolInput;
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      reason: "missing_required_arg",
      detail: "tool_input is not a JSON object",
    };
  }
  const toolFn = stripPrefix(args.toolName);
  if (toolFn === null) {
    return {
      ok: false,
      reason: "unrecognized_tool",
      detail: `tool name '${args.toolName}' is not an MCP google-workspace tool`,
    };
  }
  const inputObj = input as Record<string, unknown>;

  switch (toolFn) {
    case "modify_doc_text":
      return modifyDocText(args, inputObj);
    case "find_and_replace_doc":
      return findAndReplace(args, inputObj);
    case "insert_doc_elements":
      return insertDocElements(args, inputObj);
    case "insert_doc_image":
      return insertDocImage(args, inputObj);
    case "batch_update_doc":
      return batchUpdateDoc(args, inputObj);
    case "create_table_with_data":
      return createTable(args, inputObj);
    case "update_doc_headers_footers":
      return updateHeadersFooters(args, inputObj);
    case "update_paragraph_style":
      return updateParagraphStyle(args, inputObj);
    case "manage_doc_tab":
      return manageDocTab(args, inputObj);
    default:
      return {
        ok: false,
        reason: "unrecognized_tool",
        detail: `tool '${toolFn}' has no diff-preview translator (gating skipped)`,
      };
  }
}

// Tool names we know about. The hook script imports this so the
// PreToolUse matcher can skip the heavy work for non-gated calls.
export const GATED_DRIVE_WRITE_TOOLS = new Set<string>([
  "modify_doc_text",
  "find_and_replace_doc",
  "insert_doc_elements",
  "insert_doc_image",
  "batch_update_doc",
  "create_table_with_data",
  "update_doc_headers_footers",
  "update_paragraph_style",
  "manage_doc_tab",
]);

/**
 * Mirrors how Claude Code prefixes MCP tools. The configured server
 * label in switchroom is `google-workspace` (see
 * `examples/personal-google-workspace-mcp/README.md`).
 */
export function stripPrefix(toolName: string): string | null {
  const prefix = "mcp__google-workspace__";
  if (!toolName.startsWith(prefix)) return null;
  return toolName.slice(prefix.length);
}

// ────────────────────────────────────────────────────────────────────────
// Per-tool translators
// ────────────────────────────────────────────────────────────────────────

function modifyDocText(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const startIndex = numberOr(input.start_index, NaN);
  const endIndex = numberOr(input.end_index, NaN);
  const text = stringOr(input.text, "");

  const description = describeOffset(args.doc.snapshot, startIndex);
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: description.displayName,
  };

  // `modify_doc_text` is the most flexible upstream tool — it can
  // insert (when start==end), replace (start<end with text), or
  // delete (start<end without text). All three are mutations the
  // user should see.
  const isReplace = Number.isFinite(endIndex) && endIndex > startIndex;
  const linesAdded = countLines(text);
  const linesRemoved = isReplace ? estimateRemovedLines(args.doc.snapshot, startIndex, endIndex) : 0;

  return ok(args, resolved, linesAdded, linesRemoved);
}

function findAndReplace(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const findText = stringOr(input.find_text, "");
  const replaceText = stringOr(input.replace_text, "");
  // find_and_replace doesn't take offsets — wrap the location as
  // "every match of '<find>'". The agent's search string IS on the
  // card here, but it's structurally tied to "find X, replace
  // with Y" semantics that the user can verify, and the wrapper
  // computes the count of matches (well, after the call lands —
  // upstream doesn't tell us up front). For pre-flight we surface
  // "every match" without a count.
  const resolved: ResolvedAnchor = {
    op: { kind: "replace_paragraph", paragraphIndex: -1 },
    displayName: `every match of '${truncateLine(findText)}'`,
  };

  return ok(
    args,
    resolved,
    countLines(replaceText),
    // Removed-line estimate is unknown without scanning the doc for
    // matches; surface 0 and let the user understand "replace" via
    // the resolved name.
    0,
  );
}

function insertDocElements(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const index = numberOr(input.index, NaN);
  const elementType = stringOr(input.element_type, "element");
  const description = describeOffset(args.doc.snapshot, index);
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `insert ${truncateLine(elementType)} ${description.displayName}`,
  };
  return ok(args, resolved, 1, 0);
}

function insertDocImage(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const index = numberOr(input.index, NaN);
  const description = describeOffset(args.doc.snapshot, index);
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `insert image ${description.displayName}`,
  };
  return ok(args, resolved, 1, 0);
}

function batchUpdateDoc(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const ops = input.operations;
  if (!Array.isArray(ops)) {
    return {
      ok: false,
      reason: "missing_required_arg",
      detail: "batch_update_doc requires operations: array",
    };
  }
  // Aggregate: count distinct mutation ops, find the lowest start
  // offset for the location surface.
  let minOffset = Number.POSITIVE_INFINITY;
  let opTypes: string[] = [];
  let totalAdded = 0;
  for (const op of ops as Array<Record<string, unknown>>) {
    if (typeof op !== "object" || op === null) continue;
    const type = stringOr(op.type, "?");
    opTypes.push(type);
    const start = numberOr(op.start_index ?? op.index, NaN);
    if (Number.isFinite(start) && start < minOffset) {
      minOffset = start;
    }
    const text = stringOr(op.text ?? op.replace_text, "");
    totalAdded += countLines(text);
  }
  const description = Number.isFinite(minOffset)
    ? describeOffset(args.doc.snapshot, minOffset).displayName
    : "across doc";
  const typesLabel =
    opTypes.length <= 3
      ? opTypes.join(", ")
      : `${opTypes.slice(0, 3).join(", ")} +${opTypes.length - 3} more`;
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `${ops.length} ops (${typesLabel}) starting ${description}`,
  };
  return ok(args, resolved, totalAdded, 0);
}

function createTable(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const index = numberOr(input.index, NaN);
  const data = input.table_data;
  const rowCount = Array.isArray(data) ? data.length : 0;
  const description = describeOffset(args.doc.snapshot, index);
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `insert ${rowCount}-row table ${description.displayName}`,
  };
  return ok(args, resolved, rowCount, 0);
}

function updateHeadersFooters(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const sectionType = stringOr(input.section_type, "header");
  const content = stringOr(input.content, "");
  const resolved: ResolvedAnchor = {
    op: { kind: "replace_paragraph", paragraphIndex: -1 },
    displayName: `update ${truncateLine(sectionType)}`,
  };
  return ok(args, resolved, countLines(content), 0);
}

function updateParagraphStyle(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const startIndex = numberOr(input.start_index, NaN);
  const description = describeOffset(args.doc.snapshot, startIndex);
  const resolved: ResolvedAnchor = {
    op: { kind: "replace_paragraph", paragraphIndex: -1 },
    displayName: `restyle paragraphs ${description.displayName}`,
  };
  return ok(args, resolved, 0, 0);
}

function manageDocTab(
  args: BuildWritePreviewArgs,
  input: Record<string, unknown>,
): BuildWritePreviewResult {
  const action = stringOr(input.action, "?");
  const title = stringOr(input.title, "");
  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `${truncateLine(action)} tab${title ? ` '${truncateLine(title)}'` : ""}`,
  };
  // markdown_text drives the line count when populating; otherwise 0
  const md = stringOr(input.markdown_text, "");
  return ok(args, resolved, countLines(md), 0);
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function ok(
  args: BuildWritePreviewArgs,
  resolved: ResolvedAnchor,
  linesAdded: number,
  linesRemoved: number,
): BuildWritePreviewResult {
  return {
    ok: true,
    preview: {
      agentName: args.agentName,
      docTitle: args.doc.title,
      fileId: args.doc.document_id,
      resolvedAnchor: resolved,
      metrics: { linesAdded, linesRemoved },
      mode: "write",
      ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
    },
  };
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  if (text.charCodeAt(text.length - 1) === 10) count -= 1;
  return count;
}

function estimateRemovedLines(
  snapshot: DocumentSnapshot,
  start: number,
  end: number,
): number {
  // Walk paragraphs that overlap [start, end) and sum their line
  // contribution. Each paragraph counts for at minimum 1 line.
  let removed = 0;
  for (const p of snapshot.paragraphs) {
    if (typeof p.startOffset !== "number" || typeof p.endOffset !== "number") continue;
    if (p.endOffset <= start) continue;
    if (p.startOffset >= end) break;
    removed += 1;
  }
  return removed;
}

/**
 * Identical-shape sanitizer to `anchors.ts:truncateLine` — kept
 * local rather than imported because anchors.ts doesn't export it
 * and the displayName-sanitization concerns are independent here
 * (this module composes displayName fragments that get passed back
 * into describeOffset's output via `${frag} ${description.displayName}`).
 */
function truncateLine(s: string): string {
  const cleaned = s
    // eslint-disable-next-line no-control-regex -- intentional strip of C0 + DEL
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[`[\]()]/g, "")
    .replace(/'/g, "’")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 59)}…`;
}
