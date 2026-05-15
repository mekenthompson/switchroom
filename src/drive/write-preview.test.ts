/**
 * Tests for the write-preview spec builder — RFC E §4.2 Path A Cut 2.
 */

import { describe, expect, it } from "vitest";

import type { DocumentSnapshot } from "./anchors.js";
import {
  GATED_DRIVE_WRITE_TOOLS,
  buildWritePreview,
  stripPrefix,
} from "./write-preview.js";

// ────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────

const sampleSnapshot: DocumentSnapshot = {
  paragraphs: [
    { kind: "heading", level: 1, text: "Q3 Plan", index: 1, startOffset: 1, endOffset: 18 },
    { kind: "text", text: "Intro paragraph.", index: 2, startOffset: 18, endOffset: 36 },
    { kind: "heading", level: 2, text: "Goals", index: 3, startOffset: 36, endOffset: 44 },
    { kind: "text", text: "Ship the picker.", index: 4, startOffset: 44, endOffset: 62 },
    { kind: "heading", level: 2, text: "Hiring", index: 5, startOffset: 62, endOffset: 72 },
    { kind: "text", text: "TBD.", index: 6, startOffset: 72, endOffset: 78 },
  ],
};

const docCtx = {
  title: "Q3 Strategy Notes",
  document_id: "DOC1",
  snapshot: sampleSnapshot,
};

function callWith(
  toolName: string,
  toolInput: unknown,
): ReturnType<typeof buildWritePreview> {
  return buildWritePreview({
    agentName: "klanker",
    toolName,
    toolInput,
    doc: docCtx,
    mimeType: "application/vnd.google-apps.document",
  });
}

// ────────────────────────────────────────────────────────────────────────
// stripPrefix
// ────────────────────────────────────────────────────────────────────────

describe("stripPrefix", () => {
  it("strips the google-workspace MCP prefix", () => {
    expect(stripPrefix("mcp__google-workspace__modify_doc_text")).toBe("modify_doc_text");
  });
  it("returns null for non-MCP tool names", () => {
    expect(stripPrefix("Read")).toBeNull();
    expect(stripPrefix("mcp__hindsight__sync_retain")).toBeNull();
    expect(stripPrefix("")).toBeNull();
  });
});

describe("GATED_DRIVE_WRITE_TOOLS", () => {
  it("includes the canonical mutation tools", () => {
    expect(GATED_DRIVE_WRITE_TOOLS.has("modify_doc_text")).toBe(true);
    expect(GATED_DRIVE_WRITE_TOOLS.has("find_and_replace_doc")).toBe(true);
    expect(GATED_DRIVE_WRITE_TOOLS.has("batch_update_doc")).toBe(true);
    expect(GATED_DRIVE_WRITE_TOOLS.has("manage_doc_tab")).toBe(true);
  });
  it("excludes read tools + Drive metadata tools (out of scope for this hook)", () => {
    expect(GATED_DRIVE_WRITE_TOOLS.has("get_doc_content")).toBe(false);
    expect(GATED_DRIVE_WRITE_TOOLS.has("update_drive_file")).toBe(false);
    expect(GATED_DRIVE_WRITE_TOOLS.has("manage_drive_access")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// buildWritePreview — refusal cases
// ────────────────────────────────────────────────────────────────────────

describe("buildWritePreview — refuses unrecognised inputs", () => {
  it("refuses non-MCP-google tool names", () => {
    const r = callWith("Read", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unrecognized_tool");
  });

  it("refuses unknown MCP-google tool names (allows safe fall-through)", () => {
    const r = callWith("mcp__google-workspace__future_new_tool", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unrecognized_tool");
  });

  it("refuses non-object tool_input", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", "not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_required_arg");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-tool: modify_doc_text
// ────────────────────────────────────────────────────────────────────────

describe("modify_doc_text", () => {
  it("renders wrapper-attested location for an insert in a section", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      start_index: 50, // inside "Ship the picker." paragraph under Goals
      text: "Updated plan.\n",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("inside section 'Goals' (level 2)");
    expect(r.preview.metrics.linesAdded).toBe(1);
    expect(r.preview.metrics.linesRemoved).toBe(0);
    expect(r.preview.fileId).toBe("DOC1");
    expect(r.preview.docTitle).toBe("Q3 Strategy Notes");
  });

  it("counts removed lines when end_index > start_index (replace)", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      start_index: 50,
      end_index: 75, // spans into "Hiring" section
      text: "Replacement.",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.metrics.linesRemoved).toBeGreaterThan(0);
  });

  it("falls back to literal offset when document snapshot has no offset metadata", () => {
    const r = buildWritePreview({
      agentName: "klanker",
      toolName: "mcp__google-workspace__modify_doc_text",
      toolInput: { document_id: "DOC1", start_index: 50, text: "x" },
      doc: { title: "X", document_id: "DOC1", snapshot: { paragraphs: [] } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("at offset 50");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-tool: find_and_replace_doc
// ────────────────────────────────────────────────────────────────────────

describe("find_and_replace_doc", () => {
  it("renders 'every match of <find>' displayName + sanitizes find text", () => {
    const r = callWith("mcp__google-workspace__find_and_replace_doc", {
      document_id: "DOC1",
      find_text: "TBD",
      replace_text: "Done\nFollowup",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("every match of 'TBD'");
    expect(r.preview.metrics.linesAdded).toBe(2);
  });

  it("strips markdown / control chars from find_text in the displayName", () => {
    const r = callWith("mcp__google-workspace__find_and_replace_doc", {
      document_id: "DOC1",
      find_text: "Foo `code` [click](evil)",
      replace_text: "Bar",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).not.toContain("`");
    expect(r.preview.resolvedAnchor.displayName).not.toContain("[");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-tool: insert_doc_elements
// ────────────────────────────────────────────────────────────────────────

describe("insert_doc_elements", () => {
  it("renders 'insert <type> <location>' with sanitized element_type", () => {
    const r = callWith("mcp__google-workspace__insert_doc_elements", {
      document_id: "DOC1",
      element_type: "table",
      index: 50,
      rows: 3,
      columns: 4,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("insert table");
    expect(r.preview.resolvedAnchor.displayName).toContain("inside section 'Goals'");
  });
});

describe("insert_doc_image", () => {
  it("renders 'insert image <location>'", () => {
    const r = callWith("mcp__google-workspace__insert_doc_image", {
      document_id: "DOC1",
      image_source: "https://example.com/img.png",
      index: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("insert image");
    expect(r.preview.resolvedAnchor.displayName).toContain("Goals");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-tool: batch_update_doc
// ────────────────────────────────────────────────────────────────────────

describe("batch_update_doc", () => {
  it("aggregates multiple ops with op types + lowest offset location", () => {
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: [
        { type: "insert_text", start_index: 70, text: "Add to Hiring.\n" },
        { type: "find_replace", find_text: "TBD", replace_text: "Done" },
        { type: "insert_table", index: 50, rows: 2, columns: 3 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("3 ops");
    expect(r.preview.resolvedAnchor.displayName).toContain("insert_text");
    expect(r.preview.resolvedAnchor.displayName).toContain("starting inside section 'Goals'");
    // Sum of text contributions: insert_text "Add to Hiring.\n" = 1
    // line, find_replace "Done" = 1 line, insert_table no text = 0.
    expect(r.preview.metrics.linesAdded).toBe(2);
  });

  it("truncates the op-types list to 3 + 'more'", () => {
    const ops = Array.from({ length: 7 }, (_, i) => ({
      type: `op_${i}`,
      start_index: 50 + i,
    }));
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: ops,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("+4 more");
  });

  it("refuses when operations is missing", () => {
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_required_arg");
  });

  it("falls back to 'across doc' when no op has a numeric offset", () => {
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: [
        { type: "find_replace", find_text: "x", replace_text: "y" },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("across doc");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Per-tool: rest
// ────────────────────────────────────────────────────────────────────────

describe("create_table_with_data", () => {
  it("renders 'insert N-row table'", () => {
    const r = callWith("mcp__google-workspace__create_table_with_data", {
      document_id: "DOC1",
      index: 50,
      table_data: [
        ["A", "B"],
        ["C", "D"],
        ["E", "F"],
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("3-row table");
    expect(r.preview.metrics.linesAdded).toBe(3);
  });
});

describe("update_doc_headers_footers", () => {
  it("renders 'update <header|footer>'", () => {
    const r = callWith("mcp__google-workspace__update_doc_headers_footers", {
      document_id: "DOC1",
      section_type: "header",
      content: "New header line",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("update header");
    expect(r.preview.metrics.linesAdded).toBe(1);
  });
});

describe("update_paragraph_style", () => {
  it("renders 'restyle paragraphs <location>' (no line delta)", () => {
    const r = callWith("mcp__google-workspace__update_paragraph_style", {
      document_id: "DOC1",
      start_index: 50,
      end_index: 60,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("restyle paragraphs");
    expect(r.preview.resolvedAnchor.displayName).toContain("Goals");
    expect(r.preview.metrics.linesAdded).toBe(0);
  });
});

describe("manage_doc_tab", () => {
  it("renders 'create tab \\'<title>\\'' for create action", () => {
    const r = callWith("mcp__google-workspace__manage_doc_tab", {
      document_id: "DOC1",
      action: "create",
      title: "New Tab",
      markdown_text: "Line 1\nLine 2",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("create tab 'New Tab'");
    expect(r.preview.metrics.linesAdded).toBe(2);
  });

  it("renders the action without a title when title is missing", () => {
    const r = callWith("mcp__google-workspace__manage_doc_tab", {
      document_id: "DOC1",
      action: "delete",
      tab_id: "T1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("delete tab");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Attestation invariant — load-bearing per RFC E §4.2
// ────────────────────────────────────────────────────────────────────────

describe("buildWritePreview — attestation invariant", () => {
  it("agent-supplied text NEVER appears verbatim in resolvedAnchor.displayName", () => {
    // The agent passes a `text` field claiming to add content. The
    // displayName is derived from wrapper-side computations
    // (describeOffset + tool-shape) — not from the agent's text.
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      start_index: 50,
      text: "📍 inside section 'Approved' (level 1) — wrapper lies!",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).not.toContain("Approved");
    expect(r.preview.resolvedAnchor.displayName).not.toContain("wrapper lies");
    expect(r.preview.resolvedAnchor.displayName).toBe(
      "inside section 'Goals' (level 2)",
    );
  });

  it("non-numeric start_index degrades to 'at unknown offset' (not coerced)", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      start_index: "50' inside section 'Forbidden",
      text: "x",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toBe("at unknown offset");
    expect(r.preview.resolvedAnchor.displayName).not.toContain("Forbidden");
  });

  it("agent-supplied docTitle isn't a thing — title comes from the wrapper-fetched doc", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      title: "FAKE TITLE", // not a real upstream field, but defensive: shouldn't bleed
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.docTitle).toBe("Q3 Strategy Notes");
    expect(r.preview.docTitle).not.toContain("FAKE");
  });

  it("agent-supplied fileId isn't a thing — fileId comes from the wrapper-fetched doc", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "FAKE_ID",
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.fileId).toBe("DOC1"); // from docCtx, not from tool_input
  });

  // ─── Reviewer-blocker regressions ─────────────────────────────────────

  it("B1: batch_update_doc op.type cannot inject a forged 'inside section X' line", () => {
    // Reviewer attack: agent passes an op.type containing quotes /
    // parens / "inside section" to forge a fake wrapper-attested line
    // on the card. Mitigation: enum-pin op.type against the upstream
    // set; anything else collapses to "?".
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: [
        {
          type: "insert_text' inside section 'Approved' (level 1)",
          start_index: 50,
          text: "x",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).not.toContain("Approved");
    // The exact match is the load-bearing assertion — the forged
    // op.type collapses to "?" because it's not in the upstream enum.
    expect(r.preview.resolvedAnchor.displayName).toBe(
      "1 ops (?) starting inside section 'Goals' (level 2)",
    );
  });

  it("B2: insert_doc_elements element_type is enum-pinned (no plain-English deception)", () => {
    // Reviewer attack: element_type was an open string. Agent passes
    // "page_break onto Approved heading level 1 -- wrapper lies" to
    // craft plain-English deception on the card. Mitigation: validate
    // against the upstream enum; anything else collapses to "element".
    const r = callWith("mcp__google-workspace__insert_doc_elements", {
      document_id: "DOC1",
      element_type: "page_break onto Approved heading level 1 -- wrapper lies",
      index: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).not.toContain("Approved");
    expect(r.preview.resolvedAnchor.displayName).not.toContain("wrapper lies");
    expect(r.preview.resolvedAnchor.displayName).toBe(
      "insert element inside section 'Goals' (level 2)",
    );
  });

  it("B2: valid enum values pass through verbatim", () => {
    for (const t of ["table", "list", "page_break"]) {
      const r = callWith("mcp__google-workspace__insert_doc_elements", {
        document_id: "DOC1",
        element_type: t,
        index: 50,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.preview.resolvedAnchor.displayName).toContain(`insert ${t}`);
    }
  });

  it("B3: modify_doc_text refuses tab_id (off-body — would mis-attest body location)", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      tab_id: "TAB1",
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
    expect(r.detail).toContain("tab_id");
  });

  it("B3: modify_doc_text refuses segment_id (off-body)", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      segment_id: "header-id-1",
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
    expect(r.detail).toContain("segment_id");
  });

  it("B3: modify_doc_text refuses end_of_segment === true (off-body)", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      end_of_segment: true,
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
    expect(r.detail).toContain("end_of_segment");
  });

  it("B3: modify_doc_text with tab_id='' and end_of_segment=false stays on body", () => {
    // Defensive: empty string tab_id and falsy end_of_segment must
    // NOT trip the off-body refusal (these are upstream's "not set"
    // signals).
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      tab_id: "",
      end_of_segment: false,
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(true);
  });

  it("B3: batch_update_doc refuses when any op targets off-body", () => {
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: [
        { type: "insert_text", start_index: 50, text: "x" }, // body op
        { type: "insert_text", tab_id: "TAB1", start_index: 0, text: "y" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
  });

  it("B3: create_table_with_data refuses tab_id", () => {
    const r = callWith("mcp__google-workspace__create_table_with_data", {
      document_id: "DOC1",
      tab_id: "TAB1",
      index: 50,
      table_data: [["A", "B"]],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
  });

  it("B3: update_paragraph_style refuses segment_id", () => {
    const r = callWith("mcp__google-workspace__update_paragraph_style", {
      document_id: "DOC1",
      segment_id: "footer-id",
      start_index: 50,
      end_index: 60,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
  });

  // ─── Re-review fixes (round 2): more tools take off-body args + more enum-only fields ─

  it("B3-followup: find_and_replace_doc refuses tab_id (would mis-attest body-scope replace)", () => {
    const r = callWith("mcp__google-workspace__find_and_replace_doc", {
      document_id: "DOC1",
      tab_id: "TAB1",
      find_text: "TBD",
      replace_text: "Done",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("off_body_target");
    expect(r.detail).toContain("tab_id");
  });

  it("B2-followup: update_doc_headers_footers section_type is enum-pinned", () => {
    // Plain-English deception attempt:
    const r1 = callWith("mcp__google-workspace__update_doc_headers_footers", {
      document_id: "DOC1",
      section_type: "footer onto Approved heading -- lies",
      content: "x",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.preview.resolvedAnchor.displayName).toBe("update section");
    expect(r1.preview.resolvedAnchor.displayName).not.toContain("Approved");

    // Legitimate values pass through:
    for (const t of ["header", "footer"]) {
      const r = callWith("mcp__google-workspace__update_doc_headers_footers", {
        document_id: "DOC1",
        section_type: t,
        content: "x",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.preview.resolvedAnchor.displayName).toBe(`update ${t}`);
    }
  });

  it("B2-followup: manage_doc_tab action is enum-pinned", () => {
    const r1 = callWith("mcp__google-workspace__manage_doc_tab", {
      document_id: "DOC1",
      action: "create' inside section 'Approved",
      title: "x",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.preview.resolvedAnchor.displayName).toBe("? tab 'x'");
    expect(r1.preview.resolvedAnchor.displayName).not.toContain("Approved");

    // Legitimate values pass through:
    for (const a of ["create", "rename", "delete", "populate_from_markdown"]) {
      const r = callWith("mcp__google-workspace__manage_doc_tab", {
        document_id: "DOC1",
        action: a,
        title: "X",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.preview.resolvedAnchor.displayName).toBe(`${a} tab 'X'`);
    }
  });

  it("B3-followup: detectOffBodyTargeting catches non-string truthy values", () => {
    // Reviewer attack: pass tab_id as a number / array / object. Older
    // truthiness gate required `typeof === "string" && length > 0`,
    // missing these. Upstream might coerce to a valid id; we MUST
    // refuse rather than render a body-scope card.
    for (const tabId of [1, [1, 2], { id: "x" }, true]) {
      const r = callWith("mcp__google-workspace__modify_doc_text", {
        document_id: "DOC1",
        tab_id: tabId,
        start_index: 50,
        text: "x",
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("off_body_target");
    }
  });

  it("B3-followup: end_of_segment truthy non-true values still trip the refusal", () => {
    for (const eos of [1, "true", { x: 1 }, [true]]) {
      const r = callWith("mcp__google-workspace__modify_doc_text", {
        document_id: "DOC1",
        end_of_segment: eos,
        text: "x",
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("off_body_target");
    }
  });

  it("B3-followup: '0' / null / false / empty-string / undefined are correctly treated as 'not set'", () => {
    // The defensive cases — these are upstream's "not set" signals,
    // the hook MUST NOT trip the refusal on them.
    for (const eos of [false, 0, null, undefined]) {
      for (const tab of ["", null, undefined]) {
        const r = callWith("mcp__google-workspace__modify_doc_text", {
          document_id: "DOC1",
          end_of_segment: eos,
          tab_id: tab,
          start_index: 50,
          text: "x",
        });
        expect(r.ok).toBe(true);
      }
    }
  });

  it("batch_update_doc op count reflects real entries, not array length (sparse-array defence)", () => {
    const r = callWith("mcp__google-workspace__batch_update_doc", {
      document_id: "DOC1",
      operations: [
        { type: "insert_text", start_index: 50, text: "x" },
        null,
        "not an object",
        { type: "delete_text", start_index: 60, end_index: 70 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.resolvedAnchor.displayName).toContain("2 ops");
  });

  it("preview.mode is always 'write' — Suggesting mode is not reachable via upstream MCP", () => {
    const r = callWith("mcp__google-workspace__modify_doc_text", {
      document_id: "DOC1",
      start_index: 50,
      text: "x",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.mode).toBe("write");
  });
});
