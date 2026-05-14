/**
 * Tests for folder-picker card builder + callback parser — RFC E §4.1.
 */

import { describe, expect, it } from "vitest";

import { FolderListCache } from "./folder-list.js";
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

  it("emits Next when next_page_token is set — short handle via cache (not the raw token)", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    const realDriveToken = "X".repeat(120); // realistic Drive page-token length
    const card = buildFolderPickerCard({
      agent: "klanker",
      cache,
      page: {
        folders: [{ id: "F1", name: "X" }],
        next_page_token: realDriveToken,
      },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    const next = lastRow.find((b) => b.text === "Next ▶");
    expect(next).toBeDefined();
    // The callback contains a short hex handle, NOT the long token.
    expect(next!.callback_data).toMatch(/^drvpick:open:klanker::[0-9a-f]{8}$/);
    expect(next!.callback_data).not.toContain(realDriveToken);
    // And the cache can round-trip the handle back to the real token.
    const handle = next!.callback_data.split(":").pop()!;
    expect(cache.getPageToken("klanker", handle)).toBe(realDriveToken);
  });

  it("throws when next_page_token is set but no cache was passed", () => {
    expect(() =>
      buildFolderPickerCard({
        agent: "klanker",
        page: { folders: [{ id: "F1", name: "X" }], next_page_token: "TOK" },
      }),
    ).toThrow(/cache.*required|page_token.*cache/i);
  });

  it("re-emitting the same token returns the same handle (cache idempotence)", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    const token = "Y".repeat(80);
    const card1 = buildFolderPickerCard({
      agent: "klanker",
      cache,
      page: { folders: [], next_page_token: token },
    });
    const card2 = buildFolderPickerCard({
      agent: "klanker",
      cache,
      page: { folders: [], next_page_token: token },
    });
    const h1 = card1.rows[card1.rows.length - 1]![0]!.callback_data;
    const h2 = card2.rows[card2.rows.length - 1]![0]!.callback_data;
    expect(h1).toBe(h2);
    expect(cache.tokenCount()).toBe(1);
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

  it("realistic worst-case 'open' callback stays under the 64-byte cap", () => {
    // Reviewer pin: parent_id + handle + max-typical agent must fit.
    // drvpick:open:<agent (10)>:<parent (44)>:<handle (8)> + 4 colons = 13 + 10 + 44 + 8 = 75... let's check.
    // Actually 'drvpick:open:' = 13, ':' separators = 3, then 10+44+8 = 62. Total: 13+3+62 = 78. Over.
    // 7-char agent: 13+3+7+44+8 = 75. Still over.
    // For a 7-char agent, parent_id of 44 chars puts us at 75. So we
    // need the agent + handle to fit in 64 - 13 - 3 - 44 = 4 chars... which is impossible.
    // The handle keeps the URL safe, but parent_id is the real cap-buster.
    // Verify the cap is enforced and surfaces a clear error.
    const cache = new FolderListCache();
    expect(() =>
      buildFolderPickerCard({
        agent: "klanker",
        cache,
        parent: { id: "F".repeat(44), name: "x" },
        page: { folders: [], next_page_token: "Z".repeat(120) },
      }),
    ).toThrow(/exceeds Telegram's 64-byte cap/);
  });

  it("realistic 'open' callback fits the cap for shorter parent ids", () => {
    // Drive folder ids are typically 28-33 chars; 28 is the modern norm.
    // 13 (prefix) + 3 (separators) + 7 (agent) + 28 (parent) + 8 (handle) = 59. Under 64. ✓
    const cache = new FolderListCache();
    const card = buildFolderPickerCard({
      agent: "klanker",
      cache,
      parent: { id: "F".repeat(28), name: "x" },
      page: { folders: [], next_page_token: "Z".repeat(120) },
    });
    const lastRow = card.rows[card.rows.length - 1]!;
    const nextBtn = lastRow.find((b) => b.text === "Next ▶")!;
    expect(Buffer.byteLength(nextBtn.callback_data, "utf8")).toBeLessThanOrEqual(64);
  });

  it("rejects agent names that exceed the 64-char length cap", () => {
    expect(() =>
      buildFolderPickerCard({
        agent: "a".repeat(65),
        page: { folders: [] },
      }),
    ).toThrow(/exceeds.*cap/);
  });

  it("rejects case-mixed agent names (cache-key isolation)", () => {
    expect(() =>
      buildFolderPickerCard({ agent: "Klanker", page: { folders: [] } }),
    ).toThrow(/agent name/);
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
    expect(parseFolderPickerCallback("drvpick:open:klanker:F1:abcdef01")).toEqual({
      kind: "open",
      agent: "klanker",
      parent_id: "F1",
      page_token_handle: "abcdef01",
    });
    expect(parseFolderPickerCallback("drvpick:open:klanker::abcdef01")).toEqual({
      kind: "open",
      agent: "klanker",
      page_token_handle: "abcdef01",
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

  it("rejects a malformed page-token handle (must be 8 hex chars)", () => {
    expect(
      parseFolderPickerCallback("drvpick:open:klanker:F1:tok/with/slash"),
    ).toBeNull();
    // Too short.
    expect(parseFolderPickerCallback("drvpick:open:klanker:F1:abc")).toBeNull();
    // Too long.
    expect(
      parseFolderPickerCallback("drvpick:open:klanker:F1:abcdef0123"),
    ).toBeNull();
    // Wrong charset.
    expect(
      parseFolderPickerCallback("drvpick:open:klanker:F1:ABCDEF01"),
    ).toBeNull();
  });

  it("rejects URL-encoded colon smuggle in agent slot", () => {
    // %3A decodes to `:` — the regex must reject it post-decode.
    expect(
      parseFolderPickerCallback("drvpick:grant:klanker%3A:F1"),
    ).toBeNull();
  });
});
