/**
 * Switchroom-managed OAuth token refresh loop. Phase 1.1 of issue #429.
 *
 * Background
 * ----------
 * Pre-fix, the only way an agent's OAuth access token got refreshed was
 * the parent `claude` process noticing expiry mid-turn and rotating
 * `.credentials.json` itself. That mechanism breaks in two common
 * shapes:
 *
 *   1. Stop-hook subprocesses spawn `claude -p` with
 *      `CLAUDE_CODE_OAUTH_TOKEN` STRIPPED from env (verified empirically
 *      — see #429). They fall through to `.credentials.json`, which is
 *      often expired or missing across the fleet.
 *   2. An agent that hasn't received a turn for 24h+ never wakes up to
 *      rotate its own token. The token sits stale and the next inbound
 *      message hits a 401.
 *
 * Phase 1.2 (handoff token injection) and Phase 1.3 (heal CLI) ship
 * resilience at READ-time. This module ships resilience at WRITE-time:
 * a tick the operator runs from cron / a systemd timer that proactively
 * rotates `.credentials.json` BEFORE expiry.
 *
 * Design contract
 * ---------------
 * Pure side-effect function: read disk → conditionally hit Anthropic →
 * atomically rewrite. Safe to call repeatedly — when nothing needs
 * refreshing the function is a no-op (no network, no disk writes).
 *
 * Atomicity
 * ---------
 * `.credentials.json` and the slot-aware `.oauth-token` are rewritten
 * via tempfile + rename (single-fs atomic). A crash mid-write leaves
 * the OLD file intact, never a half-written one. The legacy
 * `.oauth-token` mirror is touched via the existing
 * `syncLegacyFromActive` helper in `accounts.ts`, which itself uses
 * the atomic-copy helper (#418).
 *
 * Concurrency
 * -----------
 * No locking between concurrent ticks. A racing tick that also picks
 * a refresh-needed slot will issue a duplicate POST to Anthropic; the
 * loser's atomic rename clobbers the winner's. The result is at-worst
 * one wasted refresh API call per race; the resulting on-disk state
 * is still a valid (live) token. Adding a lockfile here would buy
 * defence against a cost we're not paying.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  readActiveSlot,
  slotMetaPath,
  slotTokenPath,
  syncLegacyFromActive,
  migrateLegacyIfNeeded,
  writeSlotMeta,
  type SlotMeta,
} from "./accounts.js";

/**
 * Refresh a slot's token when its remaining lifetime drops below this
 * threshold. 1 hour is large enough that a daily tick still catches
 * tokens with a few hours' headroom (Anthropic typically issues 8-hour
 * access tokens), and small enough that we don't churn refreshes on
 * tokens that have plenty of life left.
 */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Anthropic Claude Code OAuth refresh endpoint. The same endpoint
 * Claude Code's CLI uses internally. Overridable via env for tests.
 */
const DEFAULT_TOKEN_URL =
  process.env.SWITCHROOM_OAUTH_TOKEN_URL ??
  "https://console.anthropic.com/v1/oauth/token";

/**
 * Public OAuth client_id Anthropic ships with Claude Code. This is not
 * a secret — it's the published client identifier for the Claude Code
 * CLI's PKCE flow. Overridable via env for tests / future rotation.
 */
const DEFAULT_CLIENT_ID =
  process.env.SWITCHROOM_OAUTH_CLIENT_ID ??
  "9d1cd16e-bcb9-40c9-a915-196412f27aa6";

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface AnthropicRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  /** seconds */
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * Outcome of a single agent's refresh attempt. Stable enum so callers
 * (CLI tick, future telemetry) can switch on it.
 */
export type RefreshOutcome =
  | { kind: "skipped-no-credentials"; agent?: string }
  | { kind: "skipped-malformed"; agent?: string; reason: string }
  | { kind: "skipped-fresh"; agent?: string; expiresAt: number; remainingMs: number }
  | { kind: "skipped-no-refresh-token"; agent?: string; expiresAt?: number }
  | { kind: "refreshed"; agent?: string; oldExpiresAt?: number; newExpiresAt: number }
  | { kind: "failed"; agent?: string; httpStatus?: number; error: string };

export interface RefreshSummary {
  /** ms timestamp when the tick started */
  startedAt: number;
  /** ms timestamp when the tick finished */
  finishedAt: number;
  outcomes: RefreshOutcome[];
  /** Counts by outcome kind for ergonomic logging. */
  counts: Record<RefreshOutcome["kind"], number>;
}

/** Hook for unit tests to swap the HTTP layer. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetcher: Fetcher = async (url, init) => {
  // Use globalThis.fetch (Node 20.11+ ships undici). Body type matches.
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};

/* ── Path helpers (mirror manager.ts so this module stands alone) ────── */

function claudeDir(agentDir: string): string {
  return join(agentDir, ".claude");
}

function credentialsPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".credentials.json");
}

function readCredentialsFile(agentDir: string): CredentialsFile | null {
  const p = credentialsPath(agentDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CredentialsFile;
  } catch {
    return null;
  }
}

/**
 * Atomically rewrite a JSON file: write tempfile, rename onto dest.
 * Same-directory rename keeps it on a single filesystem (rename(2) is
 * only atomic intra-fs). Cleans the tempfile on partial-write failure
 * so a crash mid-rotation doesn't leave a sibling turd.
 */
function atomicWriteJson(destPath: string, value: unknown, mode = 0o600): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* already gone */
    }
    throw err;
  }
}

function atomicWriteText(destPath: string, value: string, mode = 0o600): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, value, { mode });
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/* ── Core refresh ────────────────────────────────────────────────────── */

export interface RefreshOptions {
  /** Threshold below which we refresh. Default REFRESH_THRESHOLD_MS. */
  thresholdMs?: number;
  /** Override Date.now() — for tests. */
  now?: () => number;
  /** Override the Anthropic refresh URL — for tests. */
  tokenUrl?: string;
  /** Override the OAuth client_id — for tests. */
  clientId?: string;
  /** Override the HTTP layer — for tests. */
  fetcher?: Fetcher;
}

/**
 * Inspect an agent's `.credentials.json`; if its access token is about
 * to expire AND a refreshToken is present, exchange it for a new one
 * via Anthropic OAuth and atomically persist the result.
 *
 * Returns a structured outcome — never throws on the network failure
 * path (so a tick across many agents survives a transient outage and
 * the bad agent shows up as `failed`).
 */
export async function refreshTokenIfNeeded(
  agentDir: string,
  opts: RefreshOptions = {},
): Promise<RefreshOutcome> {
  const thresholdMs = opts.thresholdMs ?? REFRESH_THRESHOLD_MS;
  const now = opts.now ?? Date.now;
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const fetcher = opts.fetcher ?? defaultFetcher;

  const creds = readCredentialsFile(agentDir);
  if (!creds) {
    return { kind: "skipped-no-credentials" };
  }
  const oauth = creds.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
    return {
      kind: "skipped-malformed",
      reason: "credentials file present but missing claudeAiOauth.accessToken",
    };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return {
      kind: "skipped-malformed",
      reason: "credentials file has invalid expiresAt",
    };
  }

  const remainingMs = expiresAt - now();
  if (remainingMs > thresholdMs) {
    return { kind: "skipped-fresh", expiresAt, remainingMs };
  }

  if (!oauth.refreshToken || oauth.refreshToken.length === 0) {
    // Nothing we can do programmatically. The boot self-test issue card
    // already prompts the user to /auth in the chat; this is just the
    // structured record for the tick.
    return { kind: "skipped-no-refresh-token", expiresAt };
  }

  // Anthropic's OAuth refresh grant. Body shape matches RFC 6749 §6
  // refresh_token grant + client_id (PKCE-issued tokens require it).
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: clientId,
  });

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await fetcher(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
  } catch (err) {
    return { kind: "failed", error: `network error: ${(err as Error).message}` };
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      kind: "failed",
      httpStatus: res.status,
      error: `HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
    };
  }

  let parsed: AnthropicRefreshResponse;
  try {
    parsed = JSON.parse(await res.text()) as AnthropicRefreshResponse;
  } catch (err) {
    return {
      kind: "failed",
      httpStatus: res.status,
      error: `unparseable response: ${(err as Error).message}`,
    };
  }

  const newAccessToken = parsed.access_token;
  if (typeof newAccessToken !== "string" || newAccessToken.length === 0) {
    return {
      kind: "failed",
      httpStatus: res.status,
      error: "refresh response missing access_token",
    };
  }

  const newExpiresAt =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? now() + parsed.expires_in * 1000
      : now() + 8 * 60 * 60 * 1000; // sensible default if Anthropic ever omits it
  const newRefreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : oauth.refreshToken; // refresh tokens are sometimes long-lived; keep old if not rotated

  // ── Persist atomically ───────────────────────────────────────────
  // 1. Rewrite .credentials.json (the canonical source).
  const updatedCreds: CredentialsFile = {
    ...creds,
    claudeAiOauth: {
      ...oauth,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
    },
  };
  try {
    atomicWriteJson(credentialsPath(agentDir), updatedCreds);
  } catch (err) {
    return {
      kind: "failed",
      error: `failed to write credentials.json: ${(err as Error).message}`,
    };
  }

  // 2. Mirror into the active slot's .oauth-token + meta if a slot
  //    layout exists. Switchroom's runtime path reads `.oauth-token`
  //    via env injection (start.sh / handoff-summarizer), so without
  //    this mirror the freshly rotated token wouldn't reach the agent
  //    process until the legacy file was synced from another path.
  try {
    migrateLegacyIfNeeded(agentDir);
    const active = readActiveSlot(agentDir);
    if (active) {
      atomicWriteText(slotTokenPath(agentDir, active), newAccessToken + "\n");
      // Update slot meta expiresAt to match. Preserve other fields.
      const existingMeta: SlotMeta = (() => {
        try {
          return JSON.parse(
            readFileSync(slotMetaPath(agentDir, active), "utf-8"),
          ) as SlotMeta;
        } catch {
          return {
            createdAt: now(),
            expiresAt: newExpiresAt,
            source: "switchroom-token-refresh",
          };
        }
      })();
      writeSlotMeta(agentDir, active, {
        ...existingMeta,
        expiresAt: newExpiresAt,
      });
      // Re-mirror into legacy top-level .oauth-token.
      syncLegacyFromActive(agentDir);
    }
  } catch (err) {
    // .credentials.json is already updated — that's the source of
    // truth. Slot-layout mirror failures are visible in the next
    // tick and don't lose the new token. Surface as a soft failure
    // so the operator notices.
    return {
      kind: "failed",
      error: `credentials updated but slot mirror failed: ${(err as Error).message}`,
    };
  }

  return {
    kind: "refreshed",
    oldExpiresAt: expiresAt,
    newExpiresAt,
  };
}

/**
 * Iterate every agent in the resolved config and refresh those whose
 * tokens are expiring soon. Returns a structured summary suitable for
 * JSON logging.
 *
 * Errors from individual agents are captured into outcomes, never
 * thrown — one broken agent must not cancel refreshes for the others.
 */
export async function refreshAllAgents(
  config: SwitchroomConfig,
  opts: RefreshOptions = {},
): Promise<RefreshSummary> {
  const startedAt = Date.now();
  const agentsDir = resolveAgentsDir(config);
  const outcomes: RefreshOutcome[] = [];

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshTokenIfNeeded(agentDir, opts);
    } catch (err) {
      outcome = {
        kind: "failed",
        error: `unexpected exception: ${(err as Error).message}`,
      };
    }
    outcome.agent = name;
    outcomes.push(outcome);
  }

  const counts: Record<RefreshOutcome["kind"], number> = {
    "skipped-no-credentials": 0,
    "skipped-malformed": 0,
    "skipped-fresh": 0,
    "skipped-no-refresh-token": 0,
    refreshed: 0,
    failed: 0,
  };
  for (const o of outcomes) counts[o.kind] += 1;

  return {
    startedAt,
    finishedAt: Date.now(),
    outcomes,
    counts,
  };
}
