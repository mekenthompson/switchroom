/**
 * Edit-preparation helpers — RFC E §4.2 MCP-tool foundations.
 *
 * Pure functions that turn the four agent-facing edit operations into
 * structured edit plans + diff-preview inputs:
 *
 *   - `prepareSuggestEdit(...)`   → gdrive_suggest_edit(doc_id, anchor, text)
 *   - `prepareApplyEdit(...)`     → gdrive_apply_edit(doc_id, anchor, text)
 *   - `prepareCreateDoc(...)`     → gdrive_create_doc(title, content, parent_folder)
 *   - `prepareAppendToDoc(...)`   → gdrive_append_to_doc(doc_id, text)
 *
 * Each returns either a typed `AnchorError` (HEADING_NOT_FOUND /
 * SNIPPET_AMBIGUOUS / SNIPPET_NOT_FOUND / NTH_MATCH_OUT_OF_RANGE /
 * EMPTY_DOC_NEEDS_POSITION / INVALID_ANCHOR) verbatim from the
 * resolver in `anchors.ts`, OR a `PrepareSuccess` carrying:
 *
 *   1. The structured `EditOperation[]` plan (paragraph-index-keyed —
 *      what the eventual MCP-server tool wrapper translates into a
 *      Google Docs `documents.batchUpdate` request).
 *   2. A ready-to-go `DiffPreviewInput` for `buildDiffPreview` (B3
 *      wires that into the approval kernel).
 *
 * The kernel-agnostic seam is deliberate — the MCP-server tool
 * registration + the actual Drive API call live in follow-up wiring.
 *
 * Suggest-vs-write semantics (RFC E §4.2 nuance worth pinning):
 *
 *   The two modes produce IDENTICAL edit-plan operations. Google
 *   Docs has no first-class "create a suggestion" API endpoint —
 *   `documents.batchUpdate` lands as a Suggestion automatically
 *   when the caller's OAuth token has Commenter (not Editor)
 *   permission on the doc. From switchroom's side the `mode` field
 *   drives:
 *
 *     - which kernel action namespace the call must be authorised
 *       against (`doc:gdrive:suggest:<id>` vs
 *       `doc:gdrive:write:<id>` — RFC E §4.2);
 *     - which card icon + button emphasis the diff-preview surfaces
 *       (✏️ + "Apply as suggestion" vs ⚠ + "Apply directly");
 *     - which audit row gets written (RFC B §5).
 *
 *   The OAuth sharing posture on the doc itself is the operator's
 *   responsibility — the wrapper just attests intent and surfaces
 *   the right card.
 */

import {
  resolveAnchor,
  type Anchor,
  type AnchorError,
  type DocumentSnapshot,
  type ResolvedAnchor,
} from "./anchors.js";
import type { DiffPreviewInput } from "./diff-preview.js";

// ────────────────────────────────────────────────────────────────────────
// Edit-plan operations
// ────────────────────────────────────────────────────────────────────────

/**
 * Structured edit-plan element. Maps 1:1 onto a Google Docs
 * `documents.batchUpdate` request, but expressed in paragraph-index
 * terms (matching `anchors.ts`'s ResolvedOp shape) so it stays
 * Google-API-agnostic. The eventual MCP-server wrapper computes the
 * underlying character ranges from these.
 */
export type EditOperation =
  | { kind: "insert_after"; paragraphIndex: number; text: string }
  | { kind: "insert_before"; paragraphIndex: number; text: string }
  | { kind: "replace_paragraph"; paragraphIndex: number; text: string }
  | {
      kind: "append_to_section_end";
      /** Last body paragraph in the section. */
      paragraphIndex: number;
      text: string;
    }
  | {
      kind: "append_to_empty_section";
      /** Heading itself — wrapper inserts a fresh body paragraph immediately after. */
      paragraphIndex: number;
      text: string;
    }
  | {
      kind: "create_doc";
      /** Title for the new Drive file. */
      title: string;
      /** Parent folder id; "root" for top-of-Drive. */
      parentFolderId: string;
      /** Initial body content (plain text — newlines preserved). */
      body: string;
    }
  | {
      kind: "append_to_doc";
      /** Plain-text content appended at end-of-document. */
      text: string;
    };

// ────────────────────────────────────────────────────────────────────────
// Common inputs (per-call)
// ────────────────────────────────────────────────────────────────────────

export interface EditCallContext {
  /** Agent slug — appears in the diff-preview title + kernel scope. */
  agentName: string;
  /** Drive file id — feeds the Open-in-Drive deep link + kernel scope. */
  fileId: string;
  /** Drive file title — diff-preview card surfaces this verbatim. */
  docTitle: string;
  /** mimeType from `files.get` — drives the deep-link kind. */
  mimeType?: string;
  /** Optional pre-allocated suggestion-thread id. */
  discussionId?: string;
  /**
   * Optional agent-supplied "what / why" summary. Stored separately
   * from wrapper-attested fields so the diff-preview can render both
   * sides side-by-side (per RFC E §4.2's intent-lie defense).
   */
  agentSummary?: string;
}

export interface AnchoredEditInputs extends EditCallContext {
  /** Document snapshot from `documents.get` — feeds the anchor resolver. */
  doc: DocumentSnapshot;
  /** Where to land the edit, in agent-stated terms. */
  anchor: Anchor;
  /**
   * Body text to insert. Newlines split into paragraphs by the
   * wrapper (`countLines()` below tracks the delta the diff-preview
   * surfaces).
   */
  text: string;
}

// ────────────────────────────────────────────────────────────────────────
// Outputs
// ────────────────────────────────────────────────────────────────────────

export type PrepareSuccess<TMode extends "suggest" | "write"> = {
  ok: true;
  mode: TMode;
  /** Resolved anchor — wrapper-attested display name (RFC §4.2). */
  resolved: ResolvedAnchor;
  /** Structured edit plan — feeds the eventual Docs-API caller. */
  operations: EditOperation[];
  /** Ready-to-go input for `buildDiffPreview` (B3). */
  preview: DiffPreviewInput;
};

/** Convenience union — both modes have identical body shape (different mode tag). */
export type PrepareEditResult =
  | { ok: false; error: AnchorError }
  | PrepareSuccess<"suggest">
  | PrepareSuccess<"write">;

export type PrepareCreateResult =
  | { ok: false; error: AnchorError }
  | (Omit<PrepareSuccess<"write">, "resolved"> & {
      /**
       * Synthetic resolved anchor for create-doc: there's no anchor
       * to resolve, but the diff-preview card surfaces "📍 New doc in
       * /<folder>" via the same DiffPreviewInput shape so users see
       * the same wrapper-truth alongside the agent's summary.
       */
      resolved: ResolvedAnchor;
    });

export type PrepareAppendResult =
  | { ok: false; error: AnchorError }
  | (Omit<PrepareSuccess<"write">, "resolved"> & { resolved: ResolvedAnchor });

// ────────────────────────────────────────────────────────────────────────
// Public prep functions
// ────────────────────────────────────────────────────────────────────────

/**
 * Prepare `gdrive_suggest_edit(doc_id, anchor, text)` — RFC E §4.2.
 *
 * Resolves the anchor; on success returns the edit plan + a
 * diff-preview input with `mode: "suggest"`. The eventual MCP tool
 * wrapper checks kernel authorisation against
 * `doc:gdrive:suggest:<doc_id>` before executing the plan.
 */
export function prepareSuggestEdit(
  input: AnchoredEditInputs,
): PrepareEditResult {
  return prepareAnchoredEdit(input, "suggest");
}

/**
 * Prepare `gdrive_apply_edit(doc_id, anchor, text)` — RFC E §4.2.
 *
 * Same shape as suggest; the `mode: "write"` distinction drives
 * kernel-side authorisation against `doc:gdrive:write:<doc_id>` and
 * the diff-preview's ⚠ "Apply directly" emphasis (per RFC §4.2).
 */
export function prepareApplyEdit(
  input: AnchoredEditInputs,
): PrepareEditResult {
  return prepareAnchoredEdit(input, "write");
}

/**
 * Prepare `gdrive_create_doc(title, content, parent_folder)` — RFC E §4.2.
 *
 * Always `write` namespace (no Suggestions equivalent for a fresh
 * doc — the doc doesn't exist yet, there's nothing to suggest into).
 * The MCP tool wrapper authorises against
 * `doc:gdrive:write:folder/<parent_folder_id>/**`.
 */
export function prepareCreateDoc(input: {
  agentName: string;
  /** Title for the new doc — surfaced on the diff-preview. */
  title: string;
  /** Body content (plain text, newlines preserved). */
  body: string;
  /** Parent folder id; `"root"` for top-of-Drive. */
  parentFolderId: string;
  /** Optional human-readable parent folder name for the preview. */
  parentFolderName?: string;
  /** Optional agent-supplied "what / why" summary. */
  agentSummary?: string;
}): PrepareCreateResult {
  if (input.title.trim().length === 0) {
    return invalidAnchor("Doc title must not be empty.");
  }
  if (input.parentFolderId.length === 0) {
    return invalidAnchor("Parent folder id must not be empty (use 'root' for top-of-Drive).");
  }

  const operations: EditOperation[] = [
    {
      kind: "create_doc",
      title: input.title,
      parentFolderId: input.parentFolderId,
      body: input.body,
    },
  ];

  const folderLabel =
    input.parentFolderName !== undefined && input.parentFolderName.length > 0
      ? input.parentFolderName
      : input.parentFolderId === "root"
        ? "root"
        : input.parentFolderId;

  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: `new doc in /${folderLabel}`,
  };

  const preview: DiffPreviewInput = {
    agentName: input.agentName,
    docTitle: input.title,
    // Create-doc has no fileId yet — the open-in-Drive button is
    // synthesised post-creation. The kernel-side card builder
    // patches fileId in once Drive returns it. Use a placeholder
    // that the consumer can check for.
    fileId: "pending-create",
    resolvedAnchor: resolved,
    metrics: {
      linesAdded: countLines(input.body),
      linesRemoved: 0,
    },
    mode: "write",
    ...(input.agentSummary !== undefined ? { agentSummary: input.agentSummary } : {}),
  };

  return { ok: true, mode: "write", resolved, operations, preview };
}

/**
 * Prepare `gdrive_append_to_doc(doc_id, text)` — RFC E §4.2.
 *
 * Always `write` namespace (no Suggestions equivalent for pure
 * appends — see RFC §9 first bullet "Drive's Suggestions API has
 * gaps"). The MCP tool wrapper authorises against
 * `doc:gdrive:write:<doc_id>`.
 */
export function prepareAppendToDoc(input: {
  agentName: string;
  fileId: string;
  docTitle: string;
  mimeType?: string;
  text: string;
  agentSummary?: string;
}): PrepareAppendResult {
  if (input.text.length === 0) {
    return invalidAnchor("Append text must not be empty.");
  }

  const operations: EditOperation[] = [
    { kind: "append_to_doc", text: input.text },
  ];

  const resolved: ResolvedAnchor = {
    op: { kind: "insert_after", paragraphIndex: -1 },
    displayName: "at end of doc (append)",
  };

  const preview: DiffPreviewInput = {
    agentName: input.agentName,
    docTitle: input.docTitle,
    fileId: input.fileId,
    resolvedAnchor: resolved,
    metrics: { linesAdded: countLines(input.text), linesRemoved: 0 },
    mode: "write",
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    ...(input.agentSummary !== undefined ? { agentSummary: input.agentSummary } : {}),
  };

  return { ok: true, mode: "write", resolved, operations, preview };
}

// ────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────

function prepareAnchoredEdit(
  input: AnchoredEditInputs,
  mode: "suggest" | "write",
): PrepareEditResult {
  if (input.text.length === 0) {
    return invalidAnchor("Edit text must not be empty.");
  }

  const result = resolveAnchor(input.anchor, input.doc);
  if (!result.ok) return { ok: false, error: result.error };

  const op = result.resolved.op;
  const operations = anchoredOpToEditPlan(op, input.text, input.doc);

  // Diff-metrics calculation. `replace_paragraph` removes one line
  // from the existing doc; everything else is additive. The wrapper
  // computes both sides so the agent's summary cannot lie about
  // size (RFC E §4.2 "size lies" defense).
  const linesAdded = countLines(input.text);
  const linesRemoved = op.kind === "replace_paragraph" ? 1 : 0;

  const preview: DiffPreviewInput = {
    agentName: input.agentName,
    docTitle: input.docTitle,
    fileId: input.fileId,
    resolvedAnchor: result.resolved,
    metrics: { linesAdded, linesRemoved },
    mode,
    ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
    ...(input.discussionId !== undefined ? { discussionId: input.discussionId } : {}),
    ...(input.agentSummary !== undefined ? { agentSummary: input.agentSummary } : {}),
  };

  if (mode === "suggest") {
    return { ok: true, mode: "suggest", resolved: result.resolved, operations, preview };
  }
  return { ok: true, mode: "write", resolved: result.resolved, operations, preview };
}

function anchoredOpToEditPlan(
  op: ResolvedAnchor["op"],
  text: string,
  _doc: DocumentSnapshot,
): EditOperation[] {
  switch (op.kind) {
    case "insert_after":
      return [{ kind: "insert_after", paragraphIndex: op.paragraphIndex, text }];
    case "insert_before":
      return [{ kind: "insert_before", paragraphIndex: op.paragraphIndex, text }];
    case "replace_paragraph":
      return [{ kind: "replace_paragraph", paragraphIndex: op.paragraphIndex, text }];
    case "append_to_section_end":
      return [
        { kind: "append_to_section_end", paragraphIndex: op.paragraphIndex, text },
      ];
    case "append_to_empty_section":
      return [
        { kind: "append_to_empty_section", paragraphIndex: op.paragraphIndex, text },
      ];
  }
}

/**
 * Wrapper-attested line count for a proposed insertion. Counts
 * "lines" the same way the diff-preview card surfaces them —
 * paragraph-breaks (`\n`) plus the implicit first line. Empty text
 * counts as zero lines (the prep functions reject empty bodies
 * upstream, but the counter stays consistent in case a follow-up
 * relaxes that).
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  // `\n` count + 1 — same metric as `wc -l` for files without a
  // trailing newline. Lines that don't end in \n still count as a
  // line.
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  // If the text ends in a trailing newline, that newline doesn't
  // open a new paragraph in the Drive view — subtract one so the
  // count matches what the user sees.
  if (text.charCodeAt(text.length - 1) === 10) count -= 1;
  return count;
}

function invalidAnchor(message: string): { ok: false; error: AnchorError } {
  return { ok: false, error: { code: "INVALID_ANCHOR", message } };
}
