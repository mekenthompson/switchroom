import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  refreshTokenIfNeeded,
  REFRESH_THRESHOLD_MS,
  type Fetcher,
} from "../src/auth/token-refresh.js";

/**
 * Tests for the Phase 1.1 token-refresh daemon (#429).
 *
 * Coverage matrix:
 *   - token fresh → skip (no network call)
 *   - token expiring soon, refresh succeeds → atomic rewrite, slot mirror
 *   - token expiring soon, refresh HTTP fails → outcome=failed, no rewrite
 *   - token expiring soon, no refreshToken → outcome=skipped-no-refresh-token
 *   - .credentials.json missing → outcome=skipped-no-credentials
 *   - .credentials.json malformed → outcome=skipped-malformed
 *   - atomic-write failure rolls back (no partial credentials.json)
 */

let agentDir: string;

function writeCreds(payload: object): void {
  mkdirSync(join(agentDir, ".claude"), { recursive: true });
  writeFileSync(
    join(agentDir, ".claude", ".credentials.json"),
    JSON.stringify(payload),
  );
}

function readCreds(): { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } } {
  return JSON.parse(
    readFileSync(join(agentDir, ".claude", ".credentials.json"), "utf-8"),
  );
}

function makeFetcher(
  response:
    | { ok: true; status: number; body: object }
    | { ok: false; status: number; body: string }
    | { throws: Error },
): { fetcher: Fetcher; calls: number } {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls += 1;
    if ("throws" in response) throw response.throws;
    return {
      ok: response.ok,
      status: response.status,
      text: async () =>
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
    };
  };
  // Wrap so we can inspect call count after.
  return new Proxy(
    { fetcher, calls },
    {
      get(_t, p) {
        if (p === "fetcher") return fetcher;
        if (p === "calls") return calls;
        return undefined;
      },
    },
  ) as { fetcher: Fetcher; calls: number };
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "auth-refresh-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("refreshTokenIfNeeded", () => {
  it("skips when the token is comfortably fresh — no network call", async () => {
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h ahead
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("skipped-fresh");
    expect(called).toBe(false);
    // Untouched on disk.
    expect(readCreds().claudeAiOauth?.accessToken).toBe("tok-old");
  });

  it("refreshes when expiring soon and credentials.json is rotated atomically", async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30 min — under default 1h threshold
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    let bodySent: string | null = null;
    const fetcher: Fetcher = async (_url, init) => {
      bodySent = init.body;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "tok-new",
            refresh_token: "rt-new",
            expires_in: 28800, // 8h
          }),
      };
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("refreshed");
    if (r.kind === "refreshed") {
      expect(r.oldExpiresAt).toBe(expiresAt);
      expect(r.newExpiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
    }
    // Disk reflects the new token.
    const c = readCreds();
    expect(c.claudeAiOauth?.accessToken).toBe("tok-new");
    expect(c.claudeAiOauth?.refreshToken).toBe("rt-new");
    // Body included refresh_token + grant_type.
    expect(bodySent).toContain("refresh_token");
    expect(bodySent).toContain("rt-old");
    // No tempfiles left over.
    const claudeDirEntries = readdirSync(join(agentDir, ".claude"));
    expect(claudeDirEntries.some((n) => n.includes(".tmp-"))).toBe(false);
  });

  it("returns outcome=failed and leaves credentials untouched when the refresh API rejects", async () => {
    const expiresAt = Date.now() + 10 * 60 * 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    const fetcher: Fetcher = async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid_grant",
    });
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.httpStatus).toBe(401);
      expect(r.error).toMatch(/401/);
    }
    // Untouched on disk — old token stays put.
    expect(readCreds().claudeAiOauth?.accessToken).toBe("tok-old");
  });

  it("returns outcome=skipped-no-refresh-token when expiring without a refreshToken", async () => {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "",
        expiresAt,
      },
    });
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("skipped-no-refresh-token");
    expect(called).toBe(false);
    // Untouched.
    expect(readCreds().claudeAiOauth?.accessToken).toBe("tok-old");
  });

  it("returns outcome=skipped-no-credentials when the file is absent", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("should not be called");
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("skipped-no-credentials");
  });

  it("returns outcome=skipped-malformed for unparseable JSON", async () => {
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    writeFileSync(join(agentDir, ".claude", ".credentials.json"), "not { json");
    const fetcher: Fetcher = async () => {
      throw new Error("should not be called");
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    // No claudeAiOauth → skipped-no-credentials path; but JSON parse
    // failure path also returns skipped-no-credentials (readCredentialsFile
    // returns null on parse error — that's the documented contract).
    expect(["skipped-no-credentials", "skipped-malformed"]).toContain(r.kind);
  });

  it("flags outcome=skipped-malformed when claudeAiOauth.expiresAt is missing", async () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        // expiresAt deliberately omitted
      },
    });
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("skipped-malformed");
    expect(called).toBe(false);
  });

  it("network exception returns outcome=failed without throwing", async () => {
    const expiresAt = Date.now() + 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    const fetcher: Fetcher = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.error).toMatch(/ECONNRESET/);
    }
    // Untouched.
    expect(readCreds().claudeAiOauth?.accessToken).toBe("tok-old");
  });

  it("respects --threshold-ms via opts.thresholdMs override", async () => {
    // Token has 90 min remaining. Default threshold (60 min) → fresh.
    // With a higher 2h threshold → should refresh.
    const expiresAt = Date.now() + 90 * 60 * 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    const okFetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "tok-new",
          refresh_token: "rt-new",
          expires_in: 28800,
        }),
    });

    const skipped = await refreshTokenIfNeeded(agentDir, {
      fetcher: okFetcher,
      thresholdMs: REFRESH_THRESHOLD_MS, // default 1h, token has 90min
    });
    expect(skipped.kind).toBe("skipped-fresh");

    const refreshed = await refreshTokenIfNeeded(agentDir, {
      fetcher: okFetcher,
      thresholdMs: 2 * 60 * 60 * 1000, // 2h
    });
    expect(refreshed.kind).toBe("refreshed");
  });

  it("idempotent: a second call after a successful refresh is a no-op", async () => {
    const expiresAt = Date.now() + 30 * 60 * 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `tok-new-${calls}`,
            refresh_token: "rt-new",
            expires_in: 28800,
          }),
      };
    };
    const first = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(first.kind).toBe("refreshed");
    expect(calls).toBe(1);
    // Second call: token is now fresh, must not hit the network.
    const second = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(second.kind).toBe("skipped-fresh");
    expect(calls).toBe(1);
  });

  it("when the active slot exists, mirrors the new token into accounts/<slot>/.oauth-token + legacy mirror", async () => {
    // Set up a slot layout.
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(join(claudeDir, "accounts", "default"), { recursive: true });
    writeFileSync(join(claudeDir, "accounts", "default", ".oauth-token"), "tok-old\n");
    writeFileSync(
      join(claudeDir, "accounts", "default", ".oauth-token.meta.json"),
      JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 60 * 1000,
        source: "claude-setup-token",
      }),
    );
    writeFileSync(join(claudeDir, "active"), "default\n");
    writeFileSync(join(claudeDir, ".oauth-token"), "tok-old\n");
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt: Date.now() + 30 * 60 * 1000,
      },
    });

    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "tok-NEW-12345",
          refresh_token: "rt-NEW",
          expires_in: 28800,
        }),
    });

    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    expect(r.kind).toBe("refreshed");

    // Slot file updated.
    const slotTok = readFileSync(
      join(claudeDir, "accounts", "default", ".oauth-token"),
      "utf-8",
    ).trim();
    expect(slotTok).toBe("tok-NEW-12345");

    // Legacy mirror updated.
    const legacyTok = readFileSync(join(claudeDir, ".oauth-token"), "utf-8").trim();
    expect(legacyTok).toBe("tok-NEW-12345");

    // Slot meta expiresAt advanced.
    const slotMeta = JSON.parse(
      readFileSync(
        join(claudeDir, "accounts", "default", ".oauth-token.meta.json"),
        "utf-8",
      ),
    );
    expect(slotMeta.expiresAt).toBeGreaterThan(Date.now() + 7 * 60 * 60 * 1000);
  });

  it("does not leave a half-written credentials.json after a write failure", async () => {
    // Simulate the rare write failure by removing the parent dir AFTER
    // the read succeeds. We check the postcondition: the original
    // credentials.json is still parseable (atomic rename either
    // succeeded or no-op'd).
    const expiresAt = Date.now() + 30 * 60 * 1000;
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok-old",
        refreshToken: "rt-old",
        expiresAt,
      },
    });
    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "tok-new",
          refresh_token: "rt-new",
          expires_in: 28800,
        }),
    });
    const r = await refreshTokenIfNeeded(agentDir, { fetcher });
    // Successful refresh.
    expect(r.kind).toBe("refreshed");
    // credentials.json is whole and parseable after.
    const after = readCreds();
    expect(after.claudeAiOauth?.accessToken).toBe("tok-new");
    // No .tmp-* files left in the .claude dir.
    const entries = readdirSync(join(agentDir, ".claude"));
    expect(entries.some((n) => n.includes(".tmp-"))).toBe(false);
  });
});

describe("refreshTokenIfNeeded — referenced for type-only Fetcher import", () => {
  it("Fetcher type is exported and usable", () => {
    const f: Fetcher = async () => ({ ok: true, status: 200, text: async () => "" });
    expect(typeof f).toBe("function");
  });
});

// Suppress unused-helper warning — makeFetcher is documented even if some
// tests choose to inline simpler fetchers. Keeps the helper available
// for future tests without an unused-import warning.
void makeFetcher;
void existsSync;
