/**
 * Tests for `buildGrantedKeyboard` — the post-tap inline-keyboard
 * surfaced on a granted approval card (RFC E §4.3 — granted-card
 * confirmations gain the [ 📖 Open in Drive ] deep-link button).
 *
 * Scope-driven and pure, so the test runs without mocking grammy's
 * Context or the approval kernel. The full handler in
 * `approval-callback.ts` glues this onto the consumed-scope payload
 * the kernel returns; the routing decision lives entirely in this
 * builder.
 */

import { describe, expect, it } from "vitest";
import { InlineKeyboard } from "grammy";
import { buildGrantedKeyboard } from "./approval-callback.js";

/**
 * Helper — pull the `[{text, url}]` rows out of a grammy InlineKeyboard
 * so we can assert without poking into its internal shape too hard.
 */
function rows(kb: InlineKeyboard): Array<Array<{ text: string; url?: string }>> {
  return kb.inline_keyboard.map((row) =>
    row.map((btn) => ({
      text: btn.text,
      ...("url" in btn ? { url: btn.url } : {}),
    })),
  );
}

describe("buildGrantedKeyboard — Drive scopes", () => {
  it("emits Open-in-Drive for a single-doc grant", () => {
    const kb = buildGrantedKeyboard("doc:gdrive:D1");
    expect(kb).toBeDefined();
    expect(rows(kb!)).toEqual([
      [
        {
          text: "📖 Open in Drive",
          url: "https://drive.google.com/file/d/D1/view",
        },
      ],
    ]);
  });

  it("emits Open-in-Drive for a folder grant (canonical folder URL)", () => {
    const kb = buildGrantedKeyboard("doc:gdrive:folder/F1/**");
    expect(kb).toBeDefined();
    expect(rows(kb!)).toEqual([
      [
        {
          text: "📖 Open in Drive",
          url: "https://drive.google.com/drive/folders/F1",
        },
      ],
    ]);
  });

  it("emits Open-in-Drive for write-namespace grants on a single doc", () => {
    const kb = buildGrantedKeyboard("doc:gdrive:write:D1");
    expect(kb).toBeDefined();
    expect(rows(kb!)).toEqual([
      [
        {
          text: "📖 Open in Drive",
          url: "https://drive.google.com/file/d/D1/view",
        },
      ],
    ]);
  });

  it("emits Open-in-Drive for suggest-namespace folder grants", () => {
    const kb = buildGrantedKeyboard("doc:gdrive:suggest:folder/F1/**");
    expect(kb).toBeDefined();
    expect(rows(kb!)).toEqual([
      [
        {
          text: "📖 Open in Drive",
          url: "https://drive.google.com/drive/folders/F1",
        },
      ],
    ]);
  });
});

describe("buildGrantedKeyboard — no button cases", () => {
  it("returns undefined for the whole-Drive grant (no specific artifact)", () => {
    expect(buildGrantedKeyboard("doc:gdrive:**")).toBeUndefined();
    expect(buildGrantedKeyboard("doc:gdrive:suggest:**")).toBeUndefined();
    expect(buildGrantedKeyboard("doc:gdrive:write:**")).toBeUndefined();
  });

  it("returns undefined for non-Drive scopes (secrets, system, vault)", () => {
    expect(buildGrantedKeyboard("secret:OPENAI_API_KEY")).toBeUndefined();
    expect(buildGrantedKeyboard("system:reconnect:gdrive")).toBeUndefined();
    expect(buildGrantedKeyboard("vault:read:gdrive:klanker:refresh_token")).toBeUndefined();
  });

  it("returns undefined for unparseable Drive scopes (defense in depth)", () => {
    // A folder id containing a slash slips past prefix matching but is
    // rejected by parseDriveScope's id-charset check — the granted-card
    // edit MUST NOT render a URL button derived from such a string.
    expect(buildGrantedKeyboard("doc:gdrive:folder/abc/def/**")).toBeUndefined();
    expect(buildGrantedKeyboard("doc:gdrive:write:abc?evil=1")).toBeUndefined();
  });
});
