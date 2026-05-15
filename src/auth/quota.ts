/**
 * Anthropic Pro/Max OAuth quota probe — shared between the
 * auth-broker server (probe-quota op) and the telegram-plugin
 * gateway (in-process cache + dashboard format).
 *
 * Hits `POST /v1/messages` with the Claude CLI's exact OAuth +
 * header shape and reads `anthropic-ratelimit-unified-*` headers
 * off the response. Those headers only appear when the request is
 * authenticated with a subscription OAuth token AND carries the
 * CLI's user-agent + `anthropic-beta: oauth-2025-04-20` header.
 *
 * This module is intentionally dependency-free: just `fetch`, no
 * filesystem, no telegram, no broker. The two callers wrap it with
 * their own credential resolution.
 *
 * Pre-#1336 this lived in `telegram-plugin/quota-check.ts` and the
 * broker couldn't reach it (cross-package import + bundle boundary).
 * The broker's probe path duplicates would have drifted. Lifted to
 * `src/auth/quota.ts` so both bundles import from one place.
 */

/**
 * OAuth beta flag — proves the request is coming from a subscription
 * client. Plain bearer OAuth tokens without this header are rejected
 * with "OAuth authentication is currently not supported".
 */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * User-agent the CLI sends. Kept in sync with observed traffic; the
 * server is lenient on version suffix but strict on overall shape
 * ("claude-cli/X.Y.Z (external, cli)").
 */
export const DEFAULT_USER_AGENT = "claude-cli/1.0.0 (external, cli)";

/**
 * Default model — picked to minimize spend. One input token,
 * max_tokens=1, Haiku. Response body is discarded; only headers
 * matter.
 */
export const DEFAULT_PROBE_MODEL = "claude-haiku-4-5-20251001";

export type QuotaUtilization = {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
};

export type QuotaResult =
  | { ok: true; data: QuotaUtilization }
  | { ok: false; reason: string };

export type FetchQuotaOptions = {
  /** OAuth access token to probe with. Required. */
  accessToken: string;
  /** Override probe model. Defaults to haiku-4-5. */
  model?: string;
  /** Abort after this many ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
};

function parseFloatHeader(headers: Headers, name: string): number | null {
  const v = headers.get(name);
  if (v == null || v.trim().length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseEpochHeader(headers: Headers, name: string): Date | null {
  const v = headers.get(name);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

export function parseQuotaHeaders(headers: Headers): QuotaResult {
  const fiveHour = parseFloatHeader(headers, "anthropic-ratelimit-unified-5h-utilization");
  const sevenDay = parseFloatHeader(headers, "anthropic-ratelimit-unified-7d-utilization");
  if (fiveHour == null && sevenDay == null) {
    return {
      ok: false,
      reason: "no unified rate-limit headers in response (API token, not OAuth?)",
    };
  }
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: (fiveHour ?? 0) * 100,
      sevenDayUtilizationPct: (sevenDay ?? 0) * 100,
      fiveHourResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-5h-reset"),
      sevenDayResetAt: parseEpochHeader(headers, "anthropic-ratelimit-unified-7d-reset"),
      representativeClaim: headers.get("anthropic-ratelimit-unified-representative-claim"),
      overageStatus: headers.get("anthropic-ratelimit-unified-overage-status"),
      overageDisabledReason: headers.get("anthropic-ratelimit-unified-overage-disabled-reason"),
    },
  };
}

export async function fetchQuota(opts: FetchQuotaOptions): Promise<QuotaResult> {
  const token = opts.accessToken?.trim();
  if (!token || token.length === 0) {
    return { ok: false, reason: "fetchQuota requires a non-empty accessToken" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);

  const fetchFn = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": OAUTH_BETA,
        "authorization": `Bearer ${token}`,
        "x-app": "cli",
        "user-agent": DEFAULT_USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? String(err);
    clearTimeout(timeout);
    if (msg.includes("aborted")) {
      return { ok: false, reason: `quota probe timed out after ${opts.timeoutMs ?? 10_000}ms` };
    }
    return { ok: false, reason: `quota probe network error: ${msg}` };
  }
  clearTimeout(timeout);

  // Read headers regardless of HTTP status — the rate-limit headers
  // are populated on 200 AND on auth-failure 4xx responses.
  const parsed = parseQuotaHeaders(resp.headers);
  if (parsed.ok) return parsed;

  if (!resp.ok) {
    return { ok: false, reason: `HTTP ${resp.status} from Anthropic (${parsed.reason})` };
  }
  return parsed;
}
