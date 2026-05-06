/**
 * Reconciler three-state tests (RFC C §8).
 */

import { describe, expect, it } from "bun:test";
import { reconcile, isNewer, hashMetadata } from "./reconciler.js";

describe("reconcile — three-state detection", () => {
  it("404 → missing(not_found)", () => {
    const v = reconcile(null, { modifiedTime: "2026-01-01T00:00:00Z" });
    expect(v.state).toBe("missing");
    if (v.state === "missing") expect(v.reason).toBe("not_found");
  });

  it("200 with trashed:true → missing(trashed)", () => {
    const v = reconcile(
      { id: "x", trashed: true, modifiedTime: "2026-01-01T00:00:00Z" },
      { modifiedTime: "2026-01-01T00:00:00Z" },
    );
    expect(v.state).toBe("missing");
    if (v.state === "missing") expect(v.reason).toBe("trashed");
  });

  it("first observation → present (no baseline to diff)", () => {
    const v = reconcile({ id: "x", modifiedTime: "2026-01-01T00:00:00Z" }, null);
    expect(v.state).toBe("present");
  });

  it("identical metadata → present", () => {
    const seen = { modifiedTime: "2026-01-01T00:00:00Z", contentHash: "abc" };
    const v = reconcile({ id: "x", ...seen }, seen);
    expect(v.state).toBe("present");
  });

  it("modifiedTime newer → conflict(modified_time_newer)", () => {
    const v = reconcile(
      { id: "x", modifiedTime: "2026-02-01T00:00:00Z" },
      { modifiedTime: "2026-01-01T00:00:00Z" },
    );
    expect(v.state).toBe("conflict");
    if (v.state === "conflict") {
      expect(v.reasons).toContain("modified_time_newer");
    }
  });

  it("contentHash differs → conflict(content_hash_changed)", () => {
    const v = reconcile(
      { id: "x", contentHash: "new" },
      { contentHash: "old" },
    );
    expect(v.state).toBe("conflict");
    if (v.state === "conflict") expect(v.reasons).toContain("content_hash_changed");
  });

  it("mimeType change (Doc→PDF) → conflict(mime_type_changed)", () => {
    const v = reconcile(
      { id: "x", mimeType: "application/pdf" },
      { mimeType: "application/vnd.google-apps.document" },
    );
    expect(v.state).toBe("conflict");
    if (v.state === "conflict") expect(v.reasons).toContain("mime_type_changed");
  });

  it("ownerExcluded:true → conflict(owner_excluded)", () => {
    const v = reconcile({ id: "x", ownerExcluded: true }, {});
    expect(v.state).toBe("conflict");
    if (v.state === "conflict") expect(v.reasons).toContain("owner_excluded");
  });

  it("multiple deltas → all reasons surfaced", () => {
    const v = reconcile(
      {
        id: "x",
        modifiedTime: "2026-02-01T00:00:00Z",
        contentHash: "new",
        mimeType: "application/pdf",
      },
      {
        modifiedTime: "2026-01-01T00:00:00Z",
        contentHash: "old",
        mimeType: "application/vnd.google-apps.document",
      },
    );
    expect(v.state).toBe("conflict");
    if (v.state === "conflict") {
      expect(v.reasons).toEqual(
        expect.arrayContaining([
          "modified_time_newer",
          "content_hash_changed",
          "mime_type_changed",
        ]),
      );
    }
  });
});

describe("isNewer", () => {
  it("compares RFC 3339 timestamps via Date.parse", () => {
    expect(isNewer("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(true);
    expect(isNewer("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(false);
    expect(isNewer("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(false);
  });
});

describe("hashMetadata", () => {
  it("produces stable SHA-256 hex", async () => {
    const a = await hashMetadata({
      mimeType: "x",
      modifiedTime: "2026-01-01T00:00:00Z",
      size: 100,
    });
    const b = await hashMetadata({
      mimeType: "x",
      modifiedTime: "2026-01-01T00:00:00Z",
      size: 100,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when any field differs", async () => {
    const a = await hashMetadata({ mimeType: "x", modifiedTime: "t", size: 1 });
    const b = await hashMetadata({ mimeType: "x", modifiedTime: "t", size: 2 });
    expect(a).not.toBe(b);
  });
});
