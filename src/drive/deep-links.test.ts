/**
 * Tests for open-in-Drive URL builders — RFC E §4.3.
 */

import { describe, expect, it } from "vitest";

import {
  classifyMimeType,
  myDriveButton,
  openInDriveButton,
  openInDriveUrl,
  parseDriveScope,
  scopeToOpenInDriveButton,
} from "./deep-links.js";

describe("classifyMimeType", () => {
  it("classifies the core Workspace mime types", () => {
    expect(classifyMimeType("application/vnd.google-apps.document")).toBe("doc");
    expect(classifyMimeType("application/vnd.google-apps.spreadsheet")).toBe("spreadsheet");
    expect(classifyMimeType("application/vnd.google-apps.presentation")).toBe("presentation");
    expect(classifyMimeType("application/vnd.google-apps.form")).toBe("form");
    expect(classifyMimeType("application/vnd.google-apps.drawing")).toBe("drawing");
    expect(classifyMimeType("application/vnd.google-apps.folder")).toBe("folder");
  });

  it("falls back to 'file' for non-Workspace mime types", () => {
    expect(classifyMimeType("application/pdf")).toBe("file");
    expect(classifyMimeType("image/png")).toBe("file");
    expect(classifyMimeType("application/octet-stream")).toBe("file");
  });

  it("falls back to 'file' when mimeType is undefined", () => {
    expect(classifyMimeType(undefined)).toBe("file");
  });
});

describe("openInDriveUrl", () => {
  const id = "1abcDEFxyz789";

  it("builds the canonical edit URL for Google Docs", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.document" }),
    ).toBe(`https://docs.google.com/document/d/${id}/edit`);
  });

  it("builds the canonical edit URL for Sheets", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.spreadsheet" }),
    ).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit`);
  });

  it("builds the canonical edit URL for Slides", () => {
    expect(
      openInDriveUrl({ fileId: id, mimeType: "application/vnd.google-apps.presentation" }),
    ).toBe(`https://docs.google.com/presentation/d/${id}/edit`);
  });

  it("builds the generic file viewer URL for unknown mime types", () => {
    expect(openInDriveUrl({ fileId: id, mimeType: "application/pdf" })).toBe(
      `https://drive.google.com/file/d/${id}/view`,
    );
  });

  it("builds the generic file viewer URL when mimeType is omitted", () => {
    expect(openInDriveUrl({ fileId: id })).toBe(
      `https://drive.google.com/file/d/${id}/view`,
    );
  });

  it("appends ?disco=<id> when discussionId is set", () => {
    const u = openInDriveUrl({
      fileId: id,
      mimeType: "application/vnd.google-apps.document",
      discussionId: "thread-abc-123",
    });
    expect(u).toBe(`https://docs.google.com/document/d/${id}/edit?disco=thread-abc-123`);
  });

  // ──── ID validation — defends against URL-smuggling via inline-keyboard buttons
  it("rejects fileId containing a slash (path-injection guard)", () => {
    expect(() => openInDriveUrl({ fileId: "abc/def" })).toThrow(/invalid characters/);
  });

  it("rejects fileId containing query / fragment characters", () => {
    expect(() => openInDriveUrl({ fileId: "abc?evil=1" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc#fragment" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc:def" })).toThrow(/invalid characters/);
  });

  it("rejects fileId containing whitespace", () => {
    expect(() => openInDriveUrl({ fileId: "abc def" })).toThrow(/invalid characters/);
    expect(() => openInDriveUrl({ fileId: "abc\ndef" })).toThrow(/invalid characters/);
  });

  it("rejects empty fileId", () => {
    expect(() => openInDriveUrl({ fileId: "" })).toThrow(/must not be empty/);
  });

  it("rejects an entire URL passed as fileId", () => {
    expect(() =>
      openInDriveUrl({ fileId: "https://attacker.example.com/abc" }),
    ).toThrow(/invalid characters/);
  });

  it("validates discussionId same as fileId (no URL injection)", () => {
    expect(() =>
      openInDriveUrl({ fileId: "abc", discussionId: "thread/../etc" }),
    ).toThrow(/invalid characters/);
  });

  it("accepts the full Drive id charset (alnum + - + _)", () => {
    const wide = "1A_b-2C-d_3-EFG-hijklm-NOP-qrs_TUV-wxyz";
    expect(openInDriveUrl({ fileId: wide })).toContain(wide);
  });
});

describe("openInDriveButton", () => {
  it("returns the Telegram inline-keyboard {text, url} pair with the canonical button text", () => {
    const btn = openInDriveButton({
      fileId: "1abc",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(btn).toEqual({
      text: "📖 Open in Drive",
      url: "https://docs.google.com/document/d/1abc/edit",
    });
  });

  it("builds the canonical folder URL when isFolder is set", () => {
    expect(openInDriveUrl({ fileId: "F1", isFolder: true })).toBe(
      "https://drive.google.com/drive/folders/F1",
    );
  });

  it("isFolder overrides the mimeType-derived kind", () => {
    expect(
      openInDriveUrl({
        fileId: "F1",
        isFolder: true,
        mimeType: "application/vnd.google-apps.document",
      }),
    ).toBe("https://drive.google.com/drive/folders/F1");
  });

  it("folder mimeType also yields the folder URL", () => {
    expect(
      openInDriveUrl({
        fileId: "F1",
        mimeType: "application/vnd.google-apps.folder",
      }),
    ).toBe("https://drive.google.com/drive/folders/F1");
  });
});

describe("parseDriveScope", () => {
  it("returns null for non-Drive scopes", () => {
    expect(parseDriveScope("secret:OPENAI_API_KEY")).toBeNull();
    expect(parseDriveScope("system:reconnect:gdrive")).toBeNull();
    expect(parseDriveScope("")).toBeNull();
  });

  it("parses the read namespace shapes", () => {
    expect(parseDriveScope("doc:gdrive:**")).toEqual({
      action: "read",
      target: { kind: "all" },
    });
    expect(parseDriveScope("doc:gdrive:folder/F1/**")).toEqual({
      action: "read",
      target: { kind: "folder", folder_id: "F1" },
    });
    expect(parseDriveScope("doc:gdrive:D1")).toEqual({
      action: "read",
      target: { kind: "doc", doc_id: "D1" },
    });
  });

  it("parses the suggest namespace shapes", () => {
    expect(parseDriveScope("doc:gdrive:suggest:**")).toEqual({
      action: "suggest",
      target: { kind: "all" },
    });
    expect(parseDriveScope("doc:gdrive:suggest:folder/F1/**")).toEqual({
      action: "suggest",
      target: { kind: "folder", folder_id: "F1" },
    });
    expect(parseDriveScope("doc:gdrive:suggest:D1")).toEqual({
      action: "suggest",
      target: { kind: "doc", doc_id: "D1" },
    });
  });

  it("parses the write namespace shapes", () => {
    expect(parseDriveScope("doc:gdrive:write:**")).toEqual({
      action: "write",
      target: { kind: "all" },
    });
    expect(parseDriveScope("doc:gdrive:write:folder/F1/**")).toEqual({
      action: "write",
      target: { kind: "folder", folder_id: "F1" },
    });
    expect(parseDriveScope("doc:gdrive:write:D1")).toEqual({
      action: "write",
      target: { kind: "doc", doc_id: "D1" },
    });
  });

  it("rejects malformed folder ids (URL-injection guard)", () => {
    // A folder id containing a slash would let a crafted scope smuggle
    // a path into the inline-keyboard URL — same rule as validateDriveId.
    expect(parseDriveScope("doc:gdrive:folder/abc/def/**")).toBeNull();
    expect(parseDriveScope("doc:gdrive:folder//**")).toBeNull();
    expect(parseDriveScope("doc:gdrive:folder/F?evil=1/**")).toBeNull();
  });

  it("rejects malformed doc ids", () => {
    expect(parseDriveScope("doc:gdrive:abc/def")).toBeNull();
    expect(parseDriveScope("doc:gdrive:abc?evil=1")).toBeNull();
    expect(parseDriveScope("doc:gdrive:abc#frag")).toBeNull();
  });

  it("rejects an unterminated folder scope (no /**)", () => {
    expect(parseDriveScope("doc:gdrive:folder/F1")).toBeNull();
    expect(parseDriveScope("doc:gdrive:folder/F1/*")).toBeNull();
  });
});

describe("scopeToOpenInDriveButton", () => {
  it("returns null for non-Drive scopes", () => {
    expect(scopeToOpenInDriveButton("secret:FOO")).toBeNull();
  });

  it("returns null for the whole-Drive globs (no specific artifact)", () => {
    expect(scopeToOpenInDriveButton("doc:gdrive:**")).toBeNull();
    expect(scopeToOpenInDriveButton("doc:gdrive:suggest:**")).toBeNull();
    expect(scopeToOpenInDriveButton("doc:gdrive:write:**")).toBeNull();
  });

  it("builds a folder button for folder scopes (all namespaces)", () => {
    const expected = {
      text: "📖 Open in Drive",
      url: "https://drive.google.com/drive/folders/F1",
    };
    expect(scopeToOpenInDriveButton("doc:gdrive:folder/F1/**")).toEqual(expected);
    expect(scopeToOpenInDriveButton("doc:gdrive:suggest:folder/F1/**")).toEqual(expected);
    expect(scopeToOpenInDriveButton("doc:gdrive:write:folder/F1/**")).toEqual(expected);
  });

  it("builds a doc button for single-doc scopes (all namespaces)", () => {
    // No mimeType hint → generic file-viewer URL.
    const expected = {
      text: "📖 Open in Drive",
      url: "https://drive.google.com/file/d/D1/view",
    };
    expect(scopeToOpenInDriveButton("doc:gdrive:D1")).toEqual(expected);
    expect(scopeToOpenInDriveButton("doc:gdrive:suggest:D1")).toEqual(expected);
    expect(scopeToOpenInDriveButton("doc:gdrive:write:D1")).toEqual(expected);
  });

  it("uses the mimeType hint to pick the canonical edit URL", () => {
    expect(
      scopeToOpenInDriveButton(
        "doc:gdrive:D1",
        "application/vnd.google-apps.document",
      ),
    ).toEqual({
      text: "📖 Open in Drive",
      url: "https://docs.google.com/document/d/D1/edit",
    });
    expect(
      scopeToOpenInDriveButton(
        "doc:gdrive:write:D1",
        "application/vnd.google-apps.spreadsheet",
      ),
    ).toEqual({
      text: "📖 Open in Drive",
      url: "https://docs.google.com/spreadsheets/d/D1/edit",
    });
  });

  it("returns null for unparseable Drive scopes (safe default)", () => {
    expect(scopeToOpenInDriveButton("doc:gdrive:abc/def")).toBeNull();
    expect(scopeToOpenInDriveButton("doc:gdrive:folder/abc?x=1/**")).toBeNull();
  });
});

describe("myDriveButton", () => {
  it("returns the my-drive homepage URL button", () => {
    expect(myDriveButton()).toEqual({
      text: "📂 Open my Drive",
      url: "https://drive.google.com/drive/my-drive",
    });
  });
});
