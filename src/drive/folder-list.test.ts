/**
 * Tests for Drive folder listing — RFC E §4.1.
 *
 * Covers: HTTP client shape + query string, response parsing,
 * malformed-id rejection, parent-id charset validation,
 * cache TTL + key isolation, get-or-fetch happy/refresh paths.
 */

import { describe, expect, it } from "vitest";

import {
  FolderListCache,
  fetchFolderPage,
  getOrFetchFirstPage,
} from "./folder-list.js";

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

describe("fetchFolderPage — query string + auth", () => {
  it("issues files.list with the canonical folder query and bearer auth", async () => {
    let observed = "";
    let authHeader = "";
    const fetchImpl = mockFetch((url, init) => {
      observed = url;
      const h = init.headers as Record<string, string>;
      authHeader = h.Authorization;
      return jsonResp({ files: [], nextPageToken: undefined });
    });

    await fetchFolderPage({ access_token: "TOK", fetchImpl });

    expect(observed.startsWith("https://www.googleapis.com/drive/v3/files?")).toBe(true);
    const u = new URL(observed);
    const q = u.searchParams.get("q") ?? "";
    expect(q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(q).toContain("'me' in owners");
    expect(q).toContain("trashed=false");
    expect(u.searchParams.get("pageSize")).toBe("50");
    expect(u.searchParams.get("orderBy")).toBe("name");
    expect(u.searchParams.get("fields")).toBe("files(id,name,parents),nextPageToken");
    expect(authHeader).toBe("Bearer TOK");
  });

  it("scopes to a parent folder when parent_id is set", async () => {
    let observed = "";
    const fetchImpl = mockFetch((url) => {
      observed = url;
      return jsonResp({ files: [] });
    });
    await fetchFolderPage({ access_token: "TOK", parent_id: "F1", fetchImpl });
    const q = new URL(observed).searchParams.get("q") ?? "";
    expect(q).toContain("'F1' in parents");
  });

  it("forwards page_token", async () => {
    let observed = "";
    const fetchImpl = mockFetch((url) => {
      observed = url;
      return jsonResp({ files: [] });
    });
    await fetchFolderPage({ access_token: "TOK", page_token: "TKN123", fetchImpl });
    expect(new URL(observed).searchParams.get("pageToken")).toBe("TKN123");
  });

  it("clamps page_size into [1, 1000]", async () => {
    let observed = "";
    const fetchImpl = mockFetch((url) => {
      observed = url;
      return jsonResp({ files: [] });
    });
    await fetchFolderPage({ access_token: "TOK", page_size: 99999, fetchImpl });
    expect(new URL(observed).searchParams.get("pageSize")).toBe("1000");
    await fetchFolderPage({ access_token: "TOK", page_size: 0, fetchImpl });
    expect(new URL(observed).searchParams.get("pageSize")).toBe("1");
  });

  it("rejects malformed parent_id (URL-injection guard)", async () => {
    const fetchImpl = mockFetch(() => jsonResp({ files: [] }));
    await expect(
      fetchFolderPage({ access_token: "TOK", parent_id: "abc/def", fetchImpl }),
    ).rejects.toThrow(/invalid characters/);
    await expect(
      fetchFolderPage({ access_token: "TOK", parent_id: "abc' OR '1", fetchImpl }),
    ).rejects.toThrow(/invalid characters/);
  });
});

describe("fetchFolderPage — response parsing", () => {
  it("parses the happy path with single parent", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResp({
        files: [
          { id: "F1", name: "Folder One", parents: ["P1"] },
          { id: "F2", name: "Folder Two" },
        ],
        nextPageToken: "next-page-tok",
      }),
    );
    const page = await fetchFolderPage({ access_token: "TOK", fetchImpl });
    expect(page.folders).toEqual([
      { id: "F1", name: "Folder One", parent_id: "P1" },
      { id: "F2", name: "Folder Two" },
    ]);
    expect(page.next_page_token).toBe("next-page-tok");
  });

  it("drops entries with missing id or name (defensive)", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResp({
        files: [
          { id: "F1", name: "Keep" },
          { name: "No id" },
          { id: "F3" },
          {},
        ],
      }),
    );
    const page = await fetchFolderPage({ access_token: "TOK", fetchImpl });
    expect(page.folders.map((f) => f.name)).toEqual(["Keep"]);
  });

  it("drops entries whose id contains URL-unsafe characters", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResp({
        files: [
          { id: "F1", name: "Keep" },
          { id: "abc/def", name: "Drop slash" },
          { id: "abc?x=1", name: "Drop query" },
          { id: "abc def", name: "Drop space" },
        ],
      }),
    );
    const page = await fetchFolderPage({ access_token: "TOK", fetchImpl });
    expect(page.folders.map((f) => f.name)).toEqual(["Keep"]);
  });

  it("drops a parent_id with bad characters but keeps the folder", async () => {
    const fetchImpl = mockFetch(() =>
      jsonResp({
        files: [{ id: "F1", name: "Keep", parents: ["bad/parent"] }],
      }),
    );
    const page = await fetchFolderPage({ access_token: "TOK", fetchImpl });
    expect(page.folders).toEqual([{ id: "F1", name: "Keep" }]);
  });

  it("returns empty next_page_token when absent", async () => {
    const fetchImpl = mockFetch(() => jsonResp({ files: [] }));
    const page = await fetchFolderPage({ access_token: "TOK", fetchImpl });
    expect(page.next_page_token).toBeUndefined();
  });

  it("throws on non-2xx with status code in the message", async () => {
    const fetchImpl = mockFetch(() =>
      new Response("rate limit", { status: 429, statusText: "Too Many Requests" }),
    );
    await expect(
      fetchFolderPage({ access_token: "TOK", fetchImpl }),
    ).rejects.toThrow(/429/);
  });
});

describe("FolderListCache", () => {
  it("returns null on miss and sets/gets correctly", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    expect(cache.get("klanker")).toBeNull();
    cache.set("klanker", { folders: [{ id: "F", name: "X" }] });
    expect(cache.get("klanker")).toEqual({ folders: [{ id: "F", name: "X" }] });
  });

  it("expires entries past the TTL", () => {
    let now = 1000;
    const cache = new FolderListCache({ ttl_ms: 5_000, now: () => now });
    cache.set("klanker", { folders: [] });
    expect(cache.get("klanker")).not.toBeNull();
    now = 1000 + 5_000 + 1;
    expect(cache.get("klanker")).toBeNull();
    expect(cache.size()).toBe(0); // expiry purges
  });

  it("keys independently per (agent, parent_id)", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("klanker", { folders: [{ id: "TOP", name: "top" }] });
    cache.set("klanker", { folders: [{ id: "SUB", name: "sub" }] }, "PARENT1");
    expect(cache.get("klanker")?.folders[0]?.id).toBe("TOP");
    expect(cache.get("klanker", "PARENT1")?.folders[0]?.id).toBe("SUB");
  });

  it("does not collide on agent-name vs agent-name-and-parent (separator not in either charset)", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("ab", { folders: [{ id: "A", name: "A" }] }, "c");
    cache.set("a", { folders: [{ id: "B", name: "B" }] }, "bc");
    expect(cache.get("ab", "c")?.folders[0]?.id).toBe("A");
    expect(cache.get("a", "bc")?.folders[0]?.id).toBe("B");
  });

  it("invalidateAgent drops all entries for that agent (across parents)", () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("klanker", { folders: [] });
    cache.set("klanker", { folders: [] }, "P1");
    cache.set("klanker", { folders: [] }, "P2");
    cache.set("clerk", { folders: [] });
    cache.invalidateAgent("klanker");
    expect(cache.get("klanker")).toBeNull();
    expect(cache.get("klanker", "P1")).toBeNull();
    expect(cache.get("klanker", "P2")).toBeNull();
    expect(cache.get("clerk")).not.toBeNull();
  });
});

describe("getOrFetchFirstPage", () => {
  it("returns from cache on hit (no network)", async () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("klanker", { folders: [{ id: "CACHED", name: "C" }] });
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResp({ files: [{ id: "FRESH", name: "F" }] });
    });
    const result = await getOrFetchFirstPage({
      agent: "klanker",
      cache,
      access_token: "TOK",
      fetchImpl,
    });
    expect(result.folders[0]?.id).toBe("CACHED");
    expect(calls).toBe(0);
  });

  it("fetches on miss and writes through to the cache", async () => {
    const cache = new FolderListCache({ now: () => 1000 });
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls += 1;
      return jsonResp({ files: [{ id: "FRESH", name: "F" }] });
    });
    const result = await getOrFetchFirstPage({
      agent: "klanker",
      cache,
      access_token: "TOK",
      fetchImpl,
    });
    expect(result.folders[0]?.id).toBe("FRESH");
    expect(calls).toBe(1);
    expect(cache.get("klanker")?.folders[0]?.id).toBe("FRESH");
  });

  it("bypasses cache on force_refresh: true", async () => {
    const cache = new FolderListCache({ now: () => 1000 });
    cache.set("klanker", { folders: [{ id: "STALE", name: "S" }] });
    const fetchImpl = mockFetch(() =>
      jsonResp({ files: [{ id: "FRESH", name: "F" }] }),
    );
    const result = await getOrFetchFirstPage({
      agent: "klanker",
      cache,
      access_token: "TOK",
      force_refresh: true,
      fetchImpl,
    });
    expect(result.folders[0]?.id).toBe("FRESH");
    expect(cache.get("klanker")?.folders[0]?.id).toBe("FRESH");
  });
});
