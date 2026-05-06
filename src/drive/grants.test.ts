/**
 * Drive grants — write-namespace separation tests (RFC C §12).
 */

import { describe, expect, it } from "bun:test";
import { scopeFor, canFulfill, prefixMatches } from "./grants.js";

describe("scopeFor", () => {
  it("read all → doc:gdrive:**", () => {
    expect(scopeFor({ kind: "all" }, "read")).toBe("doc:gdrive:**");
  });
  it("write all → doc:gdrive:write:**", () => {
    expect(scopeFor({ kind: "all" }, "write")).toBe("doc:gdrive:write:**");
  });
  it("read folder", () => {
    expect(scopeFor({ kind: "folder", folder_id: "F1" }, "read")).toBe(
      "doc:gdrive:folder/F1/**",
    );
  });
  it("write folder", () => {
    expect(scopeFor({ kind: "folder", folder_id: "F1" }, "write")).toBe(
      "doc:gdrive:write:folder/F1/**",
    );
  });
  it("read doc", () => {
    expect(scopeFor({ kind: "doc", doc_id: "D1" }, "read")).toBe(
      "doc:gdrive:D1",
    );
  });
  it("write doc", () => {
    expect(scopeFor({ kind: "doc", doc_id: "D1" }, "write")).toBe(
      "doc:gdrive:write:D1",
    );
  });
});

describe("canFulfill — write isolation (the load-bearing rule)", () => {
  it("read grant CANNOT fulfill a write request, even on the same doc id", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:D1",
        decisionAction: "read",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(false);
  });

  it("read grant on doc:gdrive:** CANNOT fulfill a write request", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:**",
        decisionAction: "read",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(false);
  });

  it("write grant CAN fulfill a write request on a covered doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:**",
        decisionAction: "write",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(true);
  });

  it("read grant fulfills a read request via prefix match", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:folder/F1/**",
        decisionAction: "read",
        requestedScope: "doc:gdrive:folder/F1/sub/D1",
        requestedAction: "read",
      }),
    ).toBe(true);
  });

  it("action mismatch (read decision, write request) is rejected even when scope matches", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:D1",
        decisionAction: "write",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "read",
      }),
    ).toBe(false);
  });
});

describe("prefixMatches", () => {
  it(":** matches everything in the colon-namespace", () => {
    expect(prefixMatches("doc:gdrive:**", "doc:gdrive:anything")).toBe(true);
    expect(prefixMatches("doc:gdrive:**", "doc:gdrive:write:D1")).toBe(true);
  });

  it("/** matches descendants only", () => {
    expect(
      prefixMatches("doc:gdrive:folder/F/**", "doc:gdrive:folder/F/sub"),
    ).toBe(true);
    expect(
      prefixMatches("doc:gdrive:folder/F/**", "doc:gdrive:folder/G/sub"),
    ).toBe(false);
  });

  it("exact strings match themselves", () => {
    expect(prefixMatches("doc:gdrive:D1", "doc:gdrive:D1")).toBe(true);
  });
});
