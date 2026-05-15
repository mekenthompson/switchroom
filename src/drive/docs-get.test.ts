/**
 * Tests for Google Docs API client + response parser — RFC E §4.2.
 */

import { describe, expect, it } from "vitest";

import { fetchDocumentSnapshot, parseDocumentResponse } from "./docs-get.js";

function mockFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────
// Fixtures — shape mirrors what the Docs v1 API actually returns
// ────────────────────────────────────────────────────────────────────────

function paragraphElement(
  startIndex: number,
  endIndex: number,
  text: string,
  namedStyleType?: string,
): Record<string, unknown> {
  return {
    startIndex,
    endIndex,
    paragraph: {
      elements: [{ textRun: { content: text } }],
      paragraphStyle: namedStyleType ? { namedStyleType } : {},
    },
  };
}

function tableElement(
  startIndex: number,
  endIndex: number,
): Record<string, unknown> {
  return {
    startIndex,
    endIndex,
    table: { rows: 2, columns: 3 },
  };
}

const sampleDoc = {
  documentId: "DOC1ABCDEF",
  title: "Q3 Strategy Notes",
  body: {
    content: [
      paragraphElement(1, 18, "Q3 Plan\n", "HEADING_1"),
      paragraphElement(18, 36, "Intro paragraph.\n", "NORMAL_TEXT"),
      paragraphElement(36, 44, "Goals\n", "HEADING_2"),
      paragraphElement(44, 62, "Ship the picker.\n", "NORMAL_TEXT"),
    ],
  },
};

// ────────────────────────────────────────────────────────────────────────
// parseDocumentResponse — pure parser tests
// ────────────────────────────────────────────────────────────────────────

describe("parseDocumentResponse — happy path", () => {
  it("parses doc title + paragraph tree with offsets", () => {
    const r = parseDocumentResponse(sampleDoc);
    expect(r.title).toBe("Q3 Strategy Notes");
    expect(r.document_id).toBe("DOC1ABCDEF");
    expect(r.snapshot.paragraphs).toHaveLength(4);
  });

  it("maps HEADING_N → heading kind with the right level", () => {
    const r = parseDocumentResponse(sampleDoc);
    const h1 = r.snapshot.paragraphs[0]!;
    const h2 = r.snapshot.paragraphs[2]!;
    expect(h1.kind).toBe("heading");
    if (h1.kind === "heading") expect(h1.level).toBe(1);
    expect(h2.kind).toBe("heading");
    if (h2.kind === "heading") expect(h2.level).toBe(2);
  });

  it("maps NORMAL_TEXT → text kind", () => {
    const r = parseDocumentResponse(sampleDoc);
    const body = r.snapshot.paragraphs[1]!;
    expect(body.kind).toBe("text");
  });

  it("populates startOffset / endOffset from Docs API range", () => {
    const r = parseDocumentResponse(sampleDoc);
    const h1 = r.snapshot.paragraphs[0]!;
    expect(h1.startOffset).toBe(1);
    expect(h1.endOffset).toBe(18);
    const body = r.snapshot.paragraphs[1]!;
    expect(body.startOffset).toBe(18);
    expect(body.endOffset).toBe(36);
  });

  it("strips a single trailing newline from paragraph text", () => {
    const r = parseDocumentResponse(sampleDoc);
    expect(r.snapshot.paragraphs[0]!.text).toBe("Q3 Plan");
    expect(r.snapshot.paragraphs[1]!.text).toBe("Intro paragraph.");
  });

  it("assigns sequential .index starting at 1", () => {
    const r = parseDocumentResponse(sampleDoc);
    expect(r.snapshot.paragraphs.map((p) => p.index)).toEqual([1, 2, 3, 4]);
  });
});

describe("parseDocumentResponse — heading levels", () => {
  it("maps all 6 heading levels", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          paragraphElement(1, 5, "H1\n", "HEADING_1"),
          paragraphElement(5, 9, "H2\n", "HEADING_2"),
          paragraphElement(9, 13, "H3\n", "HEADING_3"),
          paragraphElement(13, 17, "H4\n", "HEADING_4"),
          paragraphElement(17, 21, "H5\n", "HEADING_5"),
          paragraphElement(21, 25, "H6\n", "HEADING_6"),
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    const levels = r.snapshot.paragraphs
      .filter((p) => p.kind === "heading")
      .map((p) => (p.kind === "heading" ? p.level : 0));
    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("treats TITLE and SUBTITLE as text (not headings)", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          paragraphElement(1, 10, "The Title\n", "TITLE"),
          paragraphElement(10, 20, "A subtitle\n", "SUBTITLE"),
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs.every((p) => p.kind === "text")).toBe(true);
  });

  it("treats unknown namedStyleType as text", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [paragraphElement(1, 10, "Body\n", "WEIRD_STYLE")],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs[0]!.kind).toBe("text");
  });
});

describe("parseDocumentResponse — gap handling (non-paragraph elements)", () => {
  it("skips tables — offsets between paragraphs reflect the gap", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          paragraphElement(1, 19, "Before table.\n", "NORMAL_TEXT"),
          tableElement(19, 100),
          paragraphElement(100, 118, "After table.\n", "NORMAL_TEXT"),
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs).toHaveLength(2);
    expect(r.snapshot.paragraphs[0]!.endOffset).toBe(19);
    expect(r.snapshot.paragraphs[1]!.startOffset).toBe(100);
  });

  it("skips sectionBreak elements", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          paragraphElement(1, 10, "Body.\n", "NORMAL_TEXT"),
          { startIndex: 10, endIndex: 12, sectionBreak: {} },
          paragraphElement(12, 20, "After.\n", "NORMAL_TEXT"),
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs).toHaveLength(2);
  });
});

describe("parseDocumentResponse — malformed response", () => {
  it("throws on non-object body", () => {
    expect(() => parseDocumentResponse(null)).toThrow(/non-object/);
    expect(() => parseDocumentResponse([1, 2, 3])).toThrow(/non-object/);
    expect(() => parseDocumentResponse("oops")).toThrow(/non-object/);
  });

  it("throws on missing documentId", () => {
    expect(() => parseDocumentResponse({ title: "x" })).toThrow(/documentId/);
  });

  it("throws on documentId with invalid charset (URL-injection guard)", () => {
    expect(() => parseDocumentResponse({ documentId: "abc/def" })).toThrow(/documentId/);
    expect(() => parseDocumentResponse({ documentId: "abc?evil=1" })).toThrow(/documentId/);
  });

  it("returns empty snapshot when body is missing or content is empty", () => {
    const r1 = parseDocumentResponse({ documentId: "D", title: "T" });
    expect(r1.snapshot.paragraphs).toEqual([]);
    const r2 = parseDocumentResponse({ documentId: "D", title: "T", body: { content: [] } });
    expect(r2.snapshot.paragraphs).toEqual([]);
  });

  it("skips paragraph entries with missing or inverted offsets", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          paragraphElement(1, 10, "OK\n", "NORMAL_TEXT"),
          { startIndex: 10, paragraph: { elements: [] } }, // no endIndex
          { startIndex: 30, endIndex: 20, paragraph: { elements: [] } }, // inverted
          paragraphElement(40, 50, "Also OK\n", "NORMAL_TEXT"),
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs).toHaveLength(2);
    expect(r.snapshot.paragraphs.map((p) => p.text)).toEqual(["OK", "Also OK"]);
  });

  it("handles paragraphs with multiple textRun elements", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 30,
            paragraph: {
              elements: [
                { textRun: { content: "Hello " } },
                { textRun: { content: "world" } },
                { textRun: { content: "!\n" } },
              ],
            },
          },
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs[0]!.text).toBe("Hello world!");
  });

  it("handles paragraphs with no textRun elements (e.g. inline-image-only)", () => {
    const doc = {
      documentId: "D",
      title: "T",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: 10,
            paragraph: {
              elements: [{ inlineObjectElement: { inlineObjectId: "obj1" } }],
            },
          },
        ],
      },
    };
    const r = parseDocumentResponse(doc);
    expect(r.snapshot.paragraphs[0]!.text).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────
// fetchDocumentSnapshot — HTTP integration
// ────────────────────────────────────────────────────────────────────────

describe("fetchDocumentSnapshot — request shape", () => {
  it("calls documents.get with bearer auth and the right URL", async () => {
    let observedUrl = "";
    let observedAuth = "";
    const fetchImpl = mockFetch((url, init) => {
      observedUrl = url;
      const h = (init.headers ?? {}) as Record<string, string>;
      observedAuth = h.Authorization;
      return jsonResp(sampleDoc);
    });
    await fetchDocumentSnapshot({
      access_token: "TOK",
      document_id: "DOC1ABCDEF",
      fetchImpl,
    });
    expect(observedUrl).toBe("https://docs.googleapis.com/v1/documents/DOC1ABCDEF");
    expect(observedAuth).toBe("Bearer TOK");
  });

  it("forwards suggestions_view_mode as a query param", async () => {
    let observedUrl = "";
    const fetchImpl = mockFetch((url) => {
      observedUrl = url;
      return jsonResp(sampleDoc);
    });
    await fetchDocumentSnapshot({
      access_token: "TOK",
      document_id: "DOC1ABCDEF",
      suggestions_view_mode: "PREVIEW_WITHOUT_SUGGESTIONS",
      fetchImpl,
    });
    expect(observedUrl).toContain("suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS");
  });

  it("throws on non-2xx with status in the message", async () => {
    const fetchImpl = mockFetch(
      () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      fetchDocumentSnapshot({ access_token: "TOK", document_id: "DOC1ABCDEF", fetchImpl }),
    ).rejects.toThrow(/401/);
  });

  it("rejects malformed document_id (URL-injection guard)", async () => {
    const fetchImpl = mockFetch(() => jsonResp(sampleDoc));
    await expect(
      fetchDocumentSnapshot({ access_token: "TOK", document_id: "../etc/passwd", fetchImpl }),
    ).rejects.toThrow(/invalid document_id/);
  });
});
