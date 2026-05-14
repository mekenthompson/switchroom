/**
 * Drive grants — namespace separation + implication tests.
 *
 * Covers RFC D §12 (read/write isolation) and RFC E §4.2 (suggest
 * namespace + `write → suggest` implication).
 */

import { describe, expect, it } from "bun:test";
import {
  scopeFor,
  canFulfill,
  prefixMatches,
  scopeNamespace,
} from "./grants.js";

describe("scopeFor", () => {
  it("read all → doc:gdrive:**", () => {
    expect(scopeFor({ kind: "all" }, "read")).toBe("doc:gdrive:**");
  });
  it("suggest all → doc:gdrive:suggest:**", () => {
    expect(scopeFor({ kind: "all" }, "suggest")).toBe("doc:gdrive:suggest:**");
  });
  it("write all → doc:gdrive:write:**", () => {
    expect(scopeFor({ kind: "all" }, "write")).toBe("doc:gdrive:write:**");
  });
  it("read folder", () => {
    expect(scopeFor({ kind: "folder", folder_id: "F1" }, "read")).toBe(
      "doc:gdrive:folder/F1/**",
    );
  });
  it("suggest folder", () => {
    expect(scopeFor({ kind: "folder", folder_id: "F1" }, "suggest")).toBe(
      "doc:gdrive:suggest:folder/F1/**",
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
  it("suggest doc", () => {
    expect(scopeFor({ kind: "doc", doc_id: "D1" }, "suggest")).toBe(
      "doc:gdrive:suggest:D1",
    );
  });
  it("write doc", () => {
    expect(scopeFor({ kind: "doc", doc_id: "D1" }, "write")).toBe(
      "doc:gdrive:write:D1",
    );
  });
});

describe("scopeNamespace", () => {
  it("classifies read", () => {
    expect(scopeNamespace("doc:gdrive:**")).toBe("read");
    expect(scopeNamespace("doc:gdrive:folder/F/**")).toBe("read");
    expect(scopeNamespace("doc:gdrive:D1")).toBe("read");
  });
  it("classifies suggest", () => {
    expect(scopeNamespace("doc:gdrive:suggest:**")).toBe("suggest");
    expect(scopeNamespace("doc:gdrive:suggest:folder/F/**")).toBe("suggest");
    expect(scopeNamespace("doc:gdrive:suggest:D1")).toBe("suggest");
  });
  it("classifies write", () => {
    expect(scopeNamespace("doc:gdrive:write:**")).toBe("write");
    expect(scopeNamespace("doc:gdrive:write:folder/F/**")).toBe("write");
    expect(scopeNamespace("doc:gdrive:write:D1")).toBe("write");
  });
});

describe("canFulfill — read/write isolation (RFC D §12)", () => {
  it("read grant CANNOT fulfil a write request, even on the same doc id", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:D1",
        decisionAction: "read",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(false);
  });

  it("read grant on doc:gdrive:** CANNOT fulfil a write request", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:**",
        decisionAction: "read",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(false);
  });

  it("write grant CAN fulfil a write request on a covered doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:**",
        decisionAction: "write",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(true);
  });

  it("read grant fulfils a read request via prefix match", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:folder/F1/**",
        decisionAction: "read",
        requestedScope: "doc:gdrive:folder/F1/sub/D1",
        requestedAction: "read",
      }),
    ).toBe(true);
  });

  it("action mismatch (write decision, read request) rejected even on identical scope-string", () => {
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

describe("canFulfill — suggest namespace + implication (RFC E §4.2)", () => {
  it("suggest grant CAN fulfil a suggest request on the same doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:suggest:D1",
        decisionAction: "suggest",
        requestedScope: "doc:gdrive:suggest:D1",
        requestedAction: "suggest",
      }),
    ).toBe(true);
  });

  it("suggest grant on a folder CAN fulfil a suggest request on a child doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:suggest:folder/F1/**",
        decisionAction: "suggest",
        requestedScope: "doc:gdrive:suggest:folder/F1/sub/D1",
        requestedAction: "suggest",
      }),
    ).toBe(true);
  });

  it("suggest grant CANNOT fulfil a write request (suggest does not imply write)", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:suggest:D1",
        decisionAction: "suggest",
        requestedScope: "doc:gdrive:write:D1",
        requestedAction: "write",
      }),
    ).toBe(false);
  });

  it("write grant CAN fulfil a suggest request on the same doc (write implies suggest)", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:D1",
        decisionAction: "write",
        requestedScope: "doc:gdrive:suggest:D1",
        requestedAction: "suggest",
      }),
    ).toBe(true);
  });

  it("write grant on a folder CAN fulfil a suggest request on a child doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:folder/F1/**",
        decisionAction: "write",
        requestedScope: "doc:gdrive:suggest:folder/F1/sub/D1",
        requestedAction: "suggest",
      }),
    ).toBe(true);
  });

  it("write grant on a different folder does NOT fulfil a suggest on an unrelated doc", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:folder/F1/**",
        decisionAction: "write",
        requestedScope: "doc:gdrive:suggest:folder/F2/D1",
        requestedAction: "suggest",
      }),
    ).toBe(false);
  });

  it("read grant CANNOT fulfil a suggest request (read does not cross into mutation)", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:**",
        decisionAction: "read",
        requestedScope: "doc:gdrive:suggest:D1",
        requestedAction: "suggest",
      }),
    ).toBe(false);
  });

  it("write-all grant CAN fulfil any suggest request", () => {
    expect(
      canFulfill({
        decisionScope: "doc:gdrive:write:**",
        decisionAction: "write",
        requestedScope: "doc:gdrive:suggest:D1",
        requestedAction: "suggest",
      }),
    ).toBe(true);
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
