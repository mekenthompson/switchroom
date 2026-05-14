/**
 * Tests for edit-preparation helpers — RFC E §4.2 MCP-tool
 * foundations.
 */

import { describe, expect, it } from "vitest";

import type { DocumentSnapshot } from "./anchors.js";
import {
  countLines,
  prepareAppendToDoc,
  prepareApplyEdit,
  prepareCreateDoc,
  prepareSuggestEdit,
} from "./edits.js";

/** Fixture: a small headed doc with one paragraph per section. */
function fixtureDoc(): DocumentSnapshot {
  return {
    paragraphs: [
      { kind: "heading", level: 1, text: "Q3 Plan", index: 0 },
      { kind: "text", text: "Intro paragraph.", index: 1 },
      { kind: "heading", level: 2, text: "Goals", index: 2 },
      { kind: "text", text: "Ship the picker.", index: 3 },
      { kind: "heading", level: 2, text: "Hiring", index: 4 },
      { kind: "text", text: "TBD.", index: 5 },
    ],
  };
}

const ctxBase = {
  agentName: "klanker",
  fileId: "DOC1",
  docTitle: "Q3 Strategy Notes",
};

describe("countLines", () => {
  it("zero lines for empty text", () => {
    expect(countLines("")).toBe(0);
  });

  it("one line for a single line without trailing newline", () => {
    expect(countLines("hello")).toBe(1);
  });

  it("counts paragraph breaks", () => {
    expect(countLines("one\ntwo\nthree")).toBe(3);
  });

  it("trailing newline doesn't open a new paragraph", () => {
    expect(countLines("one\ntwo\n")).toBe(2);
  });

  it("counts multiple blank-line separated paragraphs", () => {
    expect(countLines("para 1\n\npara 2")).toBe(3);
  });
});

describe("prepareSuggestEdit — success cases", () => {
  it("resolves a heading anchor and returns mode: suggest", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals", level: 2 },
      text: "New goal: ship the folder picker.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("suggest");
    expect(r.resolved.displayName).toMatch(/Goals/);
    expect(r.operations).toEqual([
      { kind: "insert_after", paragraphIndex: 2, text: "New goal: ship the folder picker." },
    ]);
    expect(r.preview.mode).toBe("suggest");
    expect(r.preview.metrics).toEqual({ linesAdded: 1, linesRemoved: 0 });
    expect(r.preview.fileId).toBe("DOC1");
    expect(r.preview.docTitle).toBe("Q3 Strategy Notes");
  });

  it("resolves an append_to_section anchor and emits the right edit-plan op", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { append_to_section: "Hiring", level: 2 },
      text: "Reach out to Alice.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations[0]?.kind).toBe("append_to_section_end");
  });

  it("counts removed line for replace_line_matching", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { replace_line_matching: /TBD/ },
      text: "Filled in.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.metrics).toEqual({ linesAdded: 1, linesRemoved: 1 });
    expect(r.operations[0]?.kind).toBe("replace_paragraph");
  });

  it("threads through agent summary + mimeType + discussionId", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      mimeType: "application/vnd.google-apps.document",
      discussionId: "thr-1",
      agentSummary: "Added a goal",
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" },
      text: "Goal text",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.mimeType).toBe("application/vnd.google-apps.document");
    expect(r.preview.discussionId).toBe("thr-1");
    expect(r.preview.agentSummary).toBe("Added a goal");
  });
});

describe("prepareSuggestEdit — anchor errors surface verbatim", () => {
  it("HEADING_NOT_FOUND for unknown heading", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Nonexistent" },
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("HEADING_NOT_FOUND");
  });

  it("SNIPPET_NOT_FOUND for unknown snippet", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_line_containing: "never appears" },
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("SNIPPET_NOT_FOUND");
  });

  it("INVALID_ANCHOR for empty edit text", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" },
      text: "",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

describe("prepareApplyEdit", () => {
  it("returns mode: write for the same anchor input as suggest", () => {
    const r = prepareApplyEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" },
      text: "Goal text",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("write");
    expect(r.preview.mode).toBe("write");
  });

  it("emits the identical edit plan to suggest — only the mode tag differs", () => {
    const args = {
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" as const },
      text: "Goal text",
    };
    const s = prepareSuggestEdit(args);
    const w = prepareApplyEdit(args);
    expect(s.ok && w.ok).toBe(true);
    if (!s.ok || !w.ok) return;
    expect(s.operations).toEqual(w.operations);
  });
});

describe("prepareCreateDoc", () => {
  it("emits a create_doc op + synthetic resolved anchor", () => {
    const r = prepareCreateDoc({
      agentName: "klanker",
      title: "New Plan",
      body: "Line 1\nLine 2",
      parentFolderId: "FOLDER1",
      parentFolderName: "Work",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("write");
    expect(r.operations).toEqual([
      {
        kind: "create_doc",
        title: "New Plan",
        parentFolderId: "FOLDER1",
        body: "Line 1\nLine 2",
      },
    ]);
    expect(r.resolved.displayName).toBe("new doc in /Work");
    expect(r.preview.metrics).toEqual({ linesAdded: 2, linesRemoved: 0 });
    expect(r.preview.fileId).toBe("pending-create");
  });

  it("falls back to the folder id when no parent name is provided", () => {
    const r = prepareCreateDoc({
      agentName: "klanker",
      title: "New Plan",
      body: "x",
      parentFolderId: "FOLDER1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.displayName).toBe("new doc in /FOLDER1");
  });

  it("renders 'root' for top-of-Drive", () => {
    const r = prepareCreateDoc({
      agentName: "klanker",
      title: "Top",
      body: "x",
      parentFolderId: "root",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.displayName).toBe("new doc in /root");
  });

  it("rejects empty title", () => {
    const r = prepareCreateDoc({
      agentName: "klanker",
      title: "   ",
      body: "x",
      parentFolderId: "F1",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ANCHOR");
  });

  it("rejects empty parent folder id", () => {
    const r = prepareCreateDoc({
      agentName: "klanker",
      title: "T",
      body: "x",
      parentFolderId: "",
    });
    expect(r.ok).toBe(false);
  });
});

describe("prepareAppendToDoc", () => {
  it("emits append_to_doc with the right line metrics + display name", () => {
    const r = prepareAppendToDoc({
      agentName: "klanker",
      fileId: "DOC1",
      docTitle: "Daily Log",
      text: "Entry 1\nEntry 2\nEntry 3",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.operations).toEqual([
      { kind: "append_to_doc", text: "Entry 1\nEntry 2\nEntry 3" },
    ]);
    expect(r.resolved.displayName).toBe("at end of doc (append)");
    expect(r.preview.metrics).toEqual({ linesAdded: 3, linesRemoved: 0 });
    expect(r.mode).toBe("write");
  });

  it("rejects empty text", () => {
    const r = prepareAppendToDoc({
      agentName: "klanker",
      fileId: "DOC1",
      docTitle: "X",
      text: "",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_ANCHOR");
  });
});

describe("wrapper-attested invariants (RFC E §4.2)", () => {
  it("agentSummary cannot override the wrapper's resolved.displayName", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" },
      text: "Edit text",
      agentSummary: "Added Hiring section",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Agent claimed Hiring; wrapper says Goals. Both are surfaced
    // separately on the preview; the resolved displayName is from
    // the wrapper.
    expect(r.resolved.displayName).toMatch(/Goals/);
    expect(r.preview.agentSummary).toBe("Added Hiring section");
    expect(r.preview.resolvedAnchor.displayName).toMatch(/Goals/);
    expect(r.preview.resolvedAnchor.displayName).not.toMatch(/Hiring/);
  });

  it("agent cannot inflate line counts via the summary string", () => {
    const r = prepareSuggestEdit({
      ...ctxBase,
      doc: fixtureDoc(),
      anchor: { after_heading: "Goals" },
      text: "single line",
      agentSummary: "+5 lines",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.metrics).toEqual({ linesAdded: 1, linesRemoved: 0 });
  });
});
