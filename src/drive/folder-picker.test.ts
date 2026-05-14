/**
 * Tests for folder-picker card builder + callback parser — RFC E §4.1.
 */

import { describe, expect, it } from "vitest";

import {
  buildFolderPickerCard,
  parseFolderPickerCallback,
} from "./folder-picker.js";

describe("buildFolderPickerCard — top of Drive", () => {
  it("renders the top-level title + folder-count line + per-folder rows", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      page: {
        folders: [
          { id: "F1", name: "Work" },
          { id: "F2", name: "Personal" },
        ],
      },
    });
    expect(card.body).toContain("📁 Pick a folder");
    expect(card.body).toContain("2 folders");
    // Two folders × {Allow, Browse} = 4 folder rows + 1 nav row.
    expect(card.rows.length).toBe(5);
    expect(card.rows[0]).toEqual([
      { text: '✅ Allow "Work"', callback_data: "drvpick:grant:klanker:F1" },
    ]);
    expect(card.rows[1]).toEqual([
      { text: '📂 Browse "Work"', callback_data: "drvpick:enter:klanker:F1" },
    ]);
    expect(card.rows[2]).toEqual([
      { text: '✅ Allow "Personal"', callback_data: "drvpick:grant:klanker:F2" },
    ]);
  });

  it("renders the singular-count message when there's exactly one folder", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      page: { folders: [{ id: "F1", name: "Solo" }] },
    });
    expect(card.body).toMatch(/1 folder\b/);
    expect(card.body).not.toMatch(/folders/);
  });

  it("renders the empty-state message", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      page: { folders: [] },
    });
    expect(card.body).toContain("(no sub-folders here)");
  });
});

describe("buildFolderPickerCard — navigation rows", () => {
  it("emits Refresh on top-level, no Back, no Next without next_page_token", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      page: { folders: [{ id: "F1", name: "X" }] },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    expect(lastRow.map((b) => b.text)).toEqual(["↻ Refresh"]);
    expect(lastRow[0]!.callback_data).toBe("drvpick:refresh:klanker:");
  });

  it("emits Back when a parent is supplied", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      parent: { id: "PARENT1", name: "Work" },
      page: { folders: [{ id: "F1", name: "Sub" }] },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    expect(lastRow[0]!.text).toBe("⬅ Back");
    // Empty trailing segment = "back to top of Drive" since breadcrumb
    // is empty (parent is one level deep).
    expect(lastRow[0]!.callback_data).toBe("drvpick:back:klanker:");
  });

  it("Back returns to the deepest breadcrumb entry when given one", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      parent: { id: "GRAND", name: "Q3" },
      breadcrumb: [
        { id: "WORK", name: "Work" },
        { id: "Y2026", name: "2026" },
      ],
      page: { folders: [] },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    expect(lastRow[0]!.text).toBe("⬅ Back");
    expect(lastRow[0]!.callback_data).toBe("drvpick:back:klanker:Y2026");
  });

  it("emits Next when next_page_token is set", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      page: { folders: [{ id: "F1", name: "X" }], next_page_token: "PG2" },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    const next = lastRow.find((b) => b.text === "Next ▶");
    expect(next).toBeDefined();
    expect(next!.callback_data).toBe("drvpick:open:klanker::PG2");
  });
});

describe("buildFolderPickerCard — breadcrumb rendering", () => {
  it("renders breadcrumb path in the body", () => {
    const card = buildFolderPickerCard({
      agent: "klanker",
      parent: { id: "Q3", name: "Q3 Planning" },
      breadcrumb: [
        { id: "WORK", name: "Work" },
        { id: "Y2026", name: "2026" },
      ],
      page: { folders: [] },
    });
    expect(card.body).toContain("📁 /Work/2026/Q3 Planning");
  });

  it("truncates long folder names in the breadcrumb (not the rows)", () => {
    const longName = "X".repeat(50);
    const card = buildFolderPickerCard({
      agent: "klanker",
      parent: { id: "Q3", name: longName },
      page: { folders: [] },
    });
    expect(card.body).toContain("…");
    expect(card.body.length).toBeLessThan(100); // sanity
  });
});

describe("buildFolderPickerCard — validation", () => {
  it("rejects an invalid agent name", () => {
    expect(() =>
      buildFolderPickerCard({
        agent: "../etc/passwd",
        page: { folders: [] },
      }),
    ).toThrow(/agent name/);
  });

  it("rejects a folder with a malformed id", () => {
    expect(() =>
      buildFolderPickerCard({
        agent: "klanker",
        page: { folders: [{ id: "abc/def", name: "evil" }] },
      }),
    ).toThrow(/invalid characters/);
  });

  it("rejects a parent with a malformed id", () => {
    expect(() =>
      buildFolderPickerCard({
        agent: "klanker",
        parent: { id: "abc?evil=1", name: "x" },
        page: { folders: [] },
      }),
    ).toThrow(/invalid characters/);
  });

  it("throws if any callback_data exceeds Telegram's 64-byte cap", () => {
    // Worst-case: max-length agent name + max-length Drive id.
    // Drive ids are ~44 chars; agent name + verb + colons must fit
    // within 20 bytes for grant: drvpick:grant:<agent>:<44-char-id>.
    // A 30-char agent name pushes us over.
    const agent = "a".repeat(30);
    expect(() =>
      buildFolderPickerCard({
        agent,
        page: { folders: [{ id: "F".repeat(44), name: "x" }] },
      }),
    ).toThrow(/exceeds Telegram's 64-byte cap/);
  });
});

describe("parseFolderPickerCallback", () => {
  it("returns null for non-drvpick callbacks", () => {
    expect(parseFolderPickerCallback("apv:abc:once")).toBeNull();
    expect(parseFolderPickerCallback("op:dismiss:foo")).toBeNull();
    expect(parseFolderPickerCallback("")).toBeNull();
  });

  it("parses grant / enter / back / refresh / open", () => {
    expect(parseFolderPickerCallback("drvpick:grant:klanker:F1")).toEqual({
      kind: "grant",
      agent: "klanker",
      folder_id: "F1",
    });
    expect(parseFolderPickerCallback("drvpick:enter:klanker:F2")).toEqual({
      kind: "enter",
      agent: "klanker",
      folder_id: "F2",
    });
    expect(parseFolderPickerCallback("drvpick:back:klanker:F3")).toEqual({
      kind: "back",
      agent: "klanker",
      parent_id: "F3",
    });
    expect(parseFolderPickerCallback("drvpick:back:klanker:")).toEqual({
      kind: "back",
      agent: "klanker",
    });
    expect(parseFolderPickerCallback("drvpick:refresh:klanker:")).toEqual({
      kind: "refresh",
      agent: "klanker",
    });
    expect(parseFolderPickerCallback("drvpick:open:klanker:F1:PGTOK")).toEqual({
      kind: "open",
      agent: "klanker",
      parent_id: "F1",
      page_token: "PGTOK",
    });
    expect(parseFolderPickerCallback("drvpick:open:klanker::PGTOK")).toEqual({
      kind: "open",
      agent: "klanker",
      page_token: "PGTOK",
    });
  });

  it("rejects an invalid agent name (defense in depth)", () => {
    // URL-encoded malicious agent name.
    expect(parseFolderPickerCallback("drvpick:grant:..%2Fetc:F1")).toBeNull();
    expect(parseFolderPickerCallback("drvpick:grant::F1")).toBeNull();
  });

  it("rejects malformed folder ids", () => {
    expect(parseFolderPickerCallback("drvpick:grant:klanker:abc/def")).toBeNull();
    expect(parseFolderPickerCallback("drvpick:enter:klanker:abc?x=1")).toBeNull();
  });

  it("rejects an unknown verb", () => {
    expect(parseFolderPickerCallback("drvpick:nuke:klanker:F1")).toBeNull();
  });

  it("rejects a malformed page token (URL-injection guard)", () => {
    expect(
      parseFolderPickerCallback("drvpick:open:klanker:F1:tok/with/slash"),
    ).toBeNull();
  });
});
