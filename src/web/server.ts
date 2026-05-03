import {
  readFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { resolve, extname, join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
  handleGetTurns,
  handleGetSubagents,
  handleGetAccounts,
  handleGetAgentAccounts,
  handleGetAgentConfig,
} from "./api.js";
import { handleWebhookIngest } from "./webhook-handler.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Constant-time string comparison to prevent timing attacks on token checks.
 * When lengths differ, compares against self to consume constant time.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the bearer token the dashboard will require for every request.
 *
 * Precedence: `SWITCHROOM_WEB_TOKEN` env var wins. Otherwise we generate
 * a 256-bit random token and persist it at `~/.switchroom/web-token`
 * (mode 0o600) — subsequent runs reuse it. Auth is NEVER optional:
 * without a token, any website the user visits could CSRF the localhost
 * dashboard into starting/stopping agents or streaming journal logs.
 */
function resolveWebToken(): string {
  const fromEnv = process.env.SWITCHROOM_WEB_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const home = process.env.HOME ?? homedir();
  const tokenPath = join(home, ".switchroom", "web-token");
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  // O_CREAT|O_EXCL: refuse to follow a pre-existing symlink or overwrite a
  // token someone else created in the same race. If the file already exists
  // we fall through and use the existing token (above); we only land here
  // when it truly didn't. If a concurrent dashboard start created the file
  // between our existsSync and openSync, EEXIST: re-read and use that.
  try {
    const fd = openSync(
      tokenPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, token + "\n");
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    throw err;
  }
}

/**
 * Returns true when the request carries a Tailscale identity header AND the
 * connection originates from the loopback interface (127.0.0.1 or ::1).
 *
 * Safety rule — trust only from loopback:
 *   Tailscale's `tailscale serve` daemon injects `Tailscale-User-Login` (and
 *   related headers) into requests it proxies to the local backend. These
 *   headers are authoritative ONLY when the request comes from the Tailscale
 *   daemon itself, which always connects via loopback. If we trusted the header
 *   from arbitrary remote IPs, any external caller could spoof it and bypass
 *   the bearer-token check entirely. By requiring source IP to be loopback we
 *   guarantee the header was injected by the daemon, not a remote attacker.
 *
 * Exported for unit-testing; not part of the public API.
 */
export function isTailscaleIdentified(req: Request, server: { requestIP(req: Request): { address: string } | null }): boolean {
  const login = req.headers.get("Tailscale-User-Login");
  if (!login || login.trim() === "") return false;
  const ipInfo = server.requestIP(req);
  if (!ipInfo) return false;
  const addr = ipInfo.address;
  return addr === "127.0.0.1" || addr === "::1";
}

/**
 * True when the request's source IP falls inside the Tailscale CGNAT
 * ranges:
 *   - IPv4 `100.64.0.0/10` (Tailscale's tailnet allocation).
 *   - IPv6 `fd7a:115c:a1e0::/48` (Tailscale's tailnet ULA).
 *   - IPv4-mapped IPv6 of the same v4 range.
 *
 * Tailscale's WireGuard layer guarantees that only peers
 * authenticated against this tailnet can route packets from these
 * source addresses to a node on the tailnet. So a request arriving
 * with one of those source IPs has *already been authenticated* by
 * Tailscale itself — no further bearer-token gate is needed for the
 * dashboard's "manage my fleet" use case.
 *
 * This is the path that lets a phone bookmark
 * `http://<host>.tailXXXX.ts.net:8080/` and have the dashboard work
 * with zero token-juggling, matching the user expectation that "I'm
 * on my tailnet, I'm me."
 *
 * Caveat: anyone on your tailnet gets in. If you share a tailnet with
 * untrusted nodes (or run a multi-tenant tailnet), you want the
 * bearer token path instead — set `SWITCHROOM_WEB_REQUIRE_TOKEN=1`
 * to disable this implicit-trust path entirely.
 *
 * Exported for unit-testing.
 */
export function isTailscalePeer(addr: string | null | undefined): boolean {
  if (!addr) return false;
  // IPv4 100.64.0.0/10 → 100.64.0.0 through 100.127.255.255.
  // The second octet is the tightest test (64–127 inclusive). Anchor
  // to end-of-string so an attacker-supplied hostname like
  // `100.64.0.1.evil.com` (which won't legitimately come from
  // `requestIP`, but cheap to harden against) doesn't slip through.
  const v4Match = /^100\.(\d+)\.\d+\.\d+$/.exec(addr);
  if (v4Match) {
    const second = Number(v4Match[1]);
    if (second >= 64 && second <= 127) return true;
  }
  // IPv4-mapped IPv6 — same range, prefixed with `::ffff:`.
  const v4MappedMatch = /^::ffff:100\.(\d+)\.\d+\.\d+$/i.exec(addr);
  if (v4MappedMatch) {
    const second = Number(v4MappedMatch[1]);
    if (second >= 64 && second <= 127) return true;
  }
  // Tailscale ULA: fd7a:115c:a1e0::/48.
  if (/^fd7a:115c:a1e0:/i.test(addr)) return true;
  return false;
}

/**
 * Operator override: setting `SWITCHROOM_WEB_REQUIRE_TOKEN=1`
 * disables the Tailscale-peer implicit-trust path. Useful when:
 *   - You share a tailnet with untrusted machines.
 *   - You're embedding switchroom in a multi-tenant Tailnet ACL setup.
 *   - You want bearer-token-only auth for compliance reasons.
 *
 * Defaults to OFF (Tailscale peers are trusted). Exported for tests.
 */
export function tailscaleImplicitTrustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_WEB_REQUIRE_TOKEN !== "1";
}

/**
 * Reject requests whose Origin doesn't belong to our own localhost-bound
 * server. Prevents a malicious page the user happens to load in a browser
 * from issuing same-site-ish requests to 127.0.0.1:<port> and piggy-backing
 * on any ambient credentials a browser might attach. We accept requests
 * with NO Origin header (CLI / curl / same-origin) but block any Origin
 * that isn't http[s]://localhost[:port] or http[s]://127.0.0.1[:port].
 *
 * When the server is bound to a non-loopback address (e.g. 0.0.0.0 or a
 * Tailscale IP) the user has explicitly opted in to network exposure. In that
 * case the original CSRF concern — a malicious website reaching localhost —
 * doesn't apply: the attacker would need to know the target IP and defeat
 * same-origin browser protections for a remote host. The randomly-generated
 * bearer token is the security boundary; origin filtering is skipped.
 *
 * Exported for unit-testing; not part of the public API.
 */
export function isOriginAllowed(req: Request, port: number, localhostOnly: boolean): boolean {
  if (!localhostOnly) {
    // Non-loopback bind: token is the sole auth boundary; skip origin check.
    return true;
  }
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
  return allowed.includes(origin);
}

/**
 * Cookie name used for the dashboard's persisted bearer token. Set by
 * the `?token=<X>` URL exchange (see {@link maybeRedirectQueryToken})
 * so a phone/tablet visiting the dashboard URL once with the token
 * picks up an httpOnly cookie and never needs the token in a URL
 * again. The token query param is stripped immediately on the
 * redirect; only the cookie persists.
 */
const TOKEN_COOKIE_NAME = "switchroom_web_token";

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Browsers can't set Authorization on WebSocket upgrades, but they CAN set
  // Sec-WebSocket-Protocol — client does `new WebSocket(url, ["bearer", token])`.
  const wsProto = req.headers.get("Sec-WebSocket-Protocol");
  if (wsProto) {
    const parts = wsProto.split(",").map((s) => s.trim());
    const idx = parts.indexOf("bearer");
    if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  }
  // Cookie fallback for browser GETs (the headline use case: phone /
  // tablet bookmarking the dashboard over Tailscale). Set by the
  // first-visit `?token=` redirect — see maybeRedirectQueryToken.
  const cookieHeader = req.headers.get("Cookie");
  if (cookieHeader) {
    const fromCookie = readCookie(cookieHeader, TOKEN_COOKIE_NAME);
    if (fromCookie) return fromCookie;
  }
  // Query-string fallback for the very first visit (and CLI / curl
  // smoke-tests). The redirect handler upgrades this to a cookie on
  // arrival so the token doesn't linger in browser history.
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  return null;
}

/**
 * Parse a Cookie header for a single named value. Defensive: handles
 * the standard `name=value; name=value` shape and ignores attributes
 * (Path, Secure, etc.) that should never appear on inbound requests
 * but might if a misbehaving client echoes Set-Cookie back.
 */
function readCookie(header: string, name: string): string | null {
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * If the URL contains `?token=<X>`, set the token as an httpOnly
 * cookie and 302-redirect to the same URL with the param stripped.
 * Returns null when no `?token` is present (handler chain continues).
 *
 * Why: phones / tablets can't reliably attach `Authorization: Bearer`
 * headers to plain GETs. Bookmarking the URL with `?token=` works
 * once but leaks the token into browser history + Referer headers.
 * Trading the token for an httpOnly cookie on first visit gives the
 * user a one-time bookmark that becomes a clean URL afterwards.
 *
 * Cookie shape:
 *   - HttpOnly (no JS access — defends against XSS exfil).
 *   - SameSite=Lax (allows top-level navigation but blocks
 *     cross-site requests; appropriate for a tailnet-only
 *     dashboard).
 *   - Path=/ (whole site).
 *   - No Max-Age — session cookie. The token persists at
 *     `~/.switchroom/web-token` so re-visiting via `?token=` restores
 *     the cookie at any time.
 *   - No Secure — on a plain-HTTP tailnet the dashboard isn't HTTPS.
 *     Adding Secure would silently break the cookie set; tailnet
 *     traffic is already encrypted at the WireGuard layer.
 */
function maybeRedirectQueryToken(req: Request): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return null;
  // Strip the param from the redirect target.
  url.searchParams.delete("token");
  const cleanPath = url.pathname + (url.search || "") + (url.hash || "");
  const cookie = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: cleanPath,
      "Set-Cookie": cookie,
    },
  });
}

function checkAuth(
  req: Request,
  token: string,
  server: { requestIP(req: Request): { address: string } | null },
): Response | null {
  // Tailscale identity header from loopback takes priority over bearer token.
  // This allows tailnet-authenticated browser sessions (proxied via
  // `tailscale serve`) to use the dashboard without needing the bearer token.
  if (isTailscaleIdentified(req, server)) return null;

  // Tailscale-peer source IP — implicit trust. The user is already
  // authenticated by Tailscale's WireGuard layer; we don't double-gate
  // with a bearer token unless the operator opted into strict mode
  // via SWITCHROOM_WEB_REQUIRE_TOKEN=1. This is the headline path for
  // phone/tablet bookmarks of `http://<host>.taildXXXX.ts.net:8080/`.
  if (tailscaleImplicitTrustEnabled()) {
    const ipInfo = server.requestIP(req);
    if (ipInfo && isTailscalePeer(ipInfo.address)) return null;
  }

  const presented = extractBearerToken(req);
  if (!presented || !constantTimeEqual(presented, token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

function checkWsAuth(
  req: Request,
  token: string,
  server: { requestIP(req: Request): { address: string } | null },
): boolean {
  // Tailscale identity header from loopback is sufficient for WebSocket auth too.
  if (isTailscaleIdentified(req, server)) return true;
  // Tailscale-peer source IP — implicit trust (parity with checkAuth).
  if (tailscaleImplicitTrustEnabled()) {
    const ipInfo = server.requestIP(req);
    if (ipInfo && isTailscalePeer(ipInfo.address)) return true;
  }
  const presented = extractBearerToken(req);
  return presented !== null && constantTimeEqual(presented, token);
}

/**
 * Webhook secrets file lives at ~/.switchroom/webhook-secrets.json.
 * Shape:
 *   {
 *     "klanker": { "github": "<secret>", "generic": "<token>" },
 *     "finn":    { "github": "<secret>" }
 *   }
 *
 * One operator-managed file — no vault integration in this PR. Mode
 * 0600 (read by switchroom user only). Future PR can swap for a
 * vault-backed resolver if the operator burden becomes real.
 */
function loadWebhookSecrets(): Record<string, Record<string, string>> {
  const path = join(homedir(), ".switchroom", "webhook-secrets.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, string>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    process.stderr.write(
      `webhook-ingest: failed to parse ${path}: ${(err as Error).message} — webhooks will return 401 until fixed\n`,
    );
    return {};
  }
}

async function handleWebhookRoute(
  req: Request,
  agent: string,
  source: string,
  config: SwitchroomConfig,
): Promise<Response> {
  const agentConfigRaw = config.agents[agent];
  const agentConfig = agentConfigRaw
    ? resolveAgentConfig(config.defaults, config.profiles, agentConfigRaw)
    : undefined;
  // Canonical location is channels.telegram.webhook_sources (#596).
  // The cascade resolver folds the deprecated root-level field into
  // it, so reading from the new spot covers both old and new
  // switchroom.yaml shapes.
  const allowedSources = agentConfig?.channels?.telegram?.webhook_sources ?? [];
  const allSecrets = loadWebhookSecrets();
  const agentSecrets = allSecrets[agent] ?? {};

  let bodyBuf: Uint8Array;
  try {
    bodyBuf = new Uint8Array(await req.arrayBuffer());
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "could not read body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await handleWebhookIngest(
    {
      agent,
      source,
      body: bodyBuf,
      headers: req.headers,
      allowedSources,
      config: { secrets: agentSecrets as Partial<Record<"github" | "generic", string>> },
      agentExists: agentConfig !== undefined,
    },
    {},
  );
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
}

function parseRoute(
  pathname: string,
  method: string
): { handler: string; params: Record<string, string> } | null {
  // GET /api/agents
  if (method === "GET" && pathname === "/api/agents") {
    return { handler: "getAgents", params: {} };
  }

  // GET /api/agents/:name/logs
  const logsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    return { handler: "getLogs", params: { name: logsMatch[1] } };
  }

  // POST /api/agents/:name/start
  const startMatch = pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return { handler: "startAgent", params: { name: startMatch[1] } };
  }

  // POST /api/agents/:name/stop
  const stopMatch = pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return { handler: "stopAgent", params: { name: stopMatch[1] } };
  }

  // POST /api/agents/:name/restart
  const restartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (method === "POST" && restartMatch) {
    return { handler: "restartAgent", params: { name: restartMatch[1] } };
  }

  // GET /api/agents/:name/turns
  const turnsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/turns$/);
  if (method === "GET" && turnsMatch) {
    return { handler: "getTurns", params: { name: turnsMatch[1] } };
  }

  // GET /api/agents/:name/subagents
  const subagentsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
  if (method === "GET" && subagentsMatch) {
    return { handler: "getSubagents", params: { name: subagentsMatch[1] } };
  }

  // GET /api/accounts
  if (method === "GET" && pathname === "/api/accounts") {
    return { handler: "getAccounts", params: {} };
  }

  // GET /api/agents/:name/accounts
  const agentAccountsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts$/);
  if (method === "GET" && agentAccountsMatch) {
    return { handler: "getAgentAccounts", params: { name: agentAccountsMatch[1] } };
  }

  // GET /api/agents/:name/config
  const agentConfigMatch = pathname.match(/^\/api\/agents\/([^/]+)\/config$/);
  if (method === "GET" && agentConfigMatch) {
    return { handler: "getAgentConfig", params: { name: agentConfigMatch[1] } };
  }

  return null;
}

export function startWebServer(
  config: SwitchroomConfig,
  port: number,
  hostname = "127.0.0.1",
): { token: string } {
  const uiDirRaw = resolve(import.meta.dirname, "ui");
  // Resolve symlinks once at startup so the traversal check compares real paths.
  const uiDir = existsSync(uiDirRaw) ? realpathSync(uiDirRaw) : uiDirRaw;
  const token = resolveWebToken();

  // Loopback-only when binding to a localhost address; any other bind address
  // (including 0.0.0.0) is considered a deliberate network-exposure opt-in.
  const localhostOnly =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // First-visit `?token=` exchange: redirect to a clean URL with
      // an httpOnly cookie set. Runs before everything else so the
      // very first GET from a phone bookmark establishes the cookie
      // without ever reaching the auth check (which would 401).
      // Subsequent GETs use the cookie via extractBearerToken's
      // cookie path. See maybeRedirectQueryToken for the rationale.
      const tokenRedirect = maybeRedirectQueryToken(req);
      if (tokenRedirect) return tokenRedirect;

      // Webhook ingest (#577) sits BEFORE the origin gate + bearer-token
      // gate because:
      //   - The webhook brings its own auth (HMAC for github, Bearer for
      //     generic) verified inside the handler.
      //   - External services (GitHub, Sentry, custom) cannot send the
      //     `Origin` header that isOriginAllowed expects, so the origin
      //     gate would block them.
      //   - The dashboard's web token has no business gating an external
      //     webhook — wrong principle, wrong key.
      // Path: POST /webhook/:agent/:source
      const webhookMatch = pathname.match(/^\/webhook\/([^/]+)\/([^/]+)$/);
      if (req.method === "POST" && webhookMatch) {
        return handleWebhookRoute(req, webhookMatch[1], webhookMatch[2], config);
      }

      // Cross-origin requests from any page the user happens to load in a
      // browser must not reach the privileged API. When bound to loopback,
      // reject any Origin that isn't our own loopback address. When bound to
      // a non-loopback address the user has opted in to network exposure and
      // the bearer token is the sole security boundary (see isOriginAllowed).
      if (!isOriginAllowed(req, port, localhostOnly)) {
        return new Response("Forbidden", { status: 403 });
      }

      // Handle CORS preflight — not needed for localhost-only server
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      // WebSocket upgrade
      if (pathname === "/ws") {
        if (!checkWsAuth(req, token, server)) {
          return new Response("Unauthorized", { status: 401 });
        }
        // If the client sent a Sec-WebSocket-Protocol header for auth, echo
        // back "bearer" so the negotiated subprotocol is valid.
        const wsProto = req.headers.get("Sec-WebSocket-Protocol");
        const headers =
          wsProto && wsProto.split(",").map((s) => s.trim()).includes("bearer")
            ? { "Sec-WebSocket-Protocol": "bearer" }
            : undefined;
        const upgraded = server.upgrade(req, headers ? { headers } : undefined);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // API routes — require auth if SWITCHROOM_WEB_TOKEN is set
      const route = parseRoute(pathname, req.method);
      if (route) {
        const authError = checkAuth(req, token, server);
        if (authError) return authError;

        switch (route.handler) {
          case "getAgents":
            return jsonResponse(handleGetAgents(config));

          case "getLogs": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLines = Number(url.searchParams.get("lines") ?? "50");
            const lines =
              Number.isInteger(rawLines) && rawLines >= 1 && rawLines <= 10000
                ? rawLines
                : 50;
            return jsonResponse(handleGetLogs(agentName, lines));
          }

          case "startAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStartAgent(agentName));
          }

          case "stopAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleStopAgent(agentName));
          }

          case "restartAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleRestartAgent(agentName));
          }

          case "getTurns": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLimit = Number(url.searchParams.get("limit") ?? "20");
            const limit =
              Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200
                ? rawLimit
                : 20;
            const result = handleGetTurns(config, agentName, limit);
            if (!result.ok) {
              return jsonResponse({ ok: false, error: result.error }, 500);
            }
            return jsonResponse(result.turns);
          }

          case "getSubagents": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const status = url.searchParams.get("status") ?? undefined;
            const result = handleGetSubagents(config, agentName, status);
            if (!result.ok) {
              return jsonResponse({ ok: false, error: result.error }, 500);
            }
            return jsonResponse(result.subagents);
          }

          case "getAccounts":
            return jsonResponse(handleGetAccounts());

          case "getAgentAccounts": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleGetAgentAccounts(config, agentName));
          }

          case "getAgentConfig": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleGetAgentConfig(config, agentName));
          }
        }
      }

      // Static files — no auth required
      let filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = join(uiDir, filePath);

      // Resolve symlinks before comparing so traversal via symlinked uiDir
      // (or symlinks inside it) can't escape the static root.
      if (!existsSync(fullPath)) {
        return new Response("Not Found", { status: 404 });
      }
      let realFullPath: string;
      try {
        realFullPath = realpathSync(fullPath);
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      const rel = relative(uiDir, realFullPath);
      if (rel.startsWith("..") || resolve(uiDir, rel) !== realFullPath) {
        return new Response("Forbidden", { status: 403 });
      }

      const ext = extname(realFullPath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = readFileSync(realFullPath);
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    },

    websocket: {
      open(_ws) {
        // No-op; tracking handled per-subscription
      },
      close(ws) {
        const proc = (ws as any)._logProcess;
        if (proc) {
          proc.kill();
          (ws as any)._logProcess = null;
        }
      },
      message(ws, message) {
        // Handle subscription requests for agent logs
        try {
          const data = JSON.parse(String(message));
          if (data.type === "subscribe" && data.agent) {
            const agentName = String(data.agent).replace(/[^a-zA-Z0-9_-]/g, "");
            // Only allow subscribing to agents that actually exist in config.
            if (!agentName || !config.agents[agentName]) {
              try {
                ws.send(JSON.stringify({ type: "error", error: "Unknown agent" }));
              } catch {}
              return;
            }

            // Kill any existing log process before subscribing to a new one
            const existing = (ws as any)._logProcess;
            if (existing) {
              existing.kill();
              (ws as any)._logProcess = null;
            }

            const child = spawn(
              "journalctl",
              ["--user", "-u", `switchroom-${agentName}`, "-f", "--no-pager", "-n", "20"],
              { stdio: ["ignore", "pipe", "pipe"] }
            );

            child.stdout.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                // Client disconnected
                child.kill();
              }
            });

            child.stderr.on("data", (chunk: Buffer) => {
              try {
                ws.send(JSON.stringify({
                  type: "log_error",
                  agent: agentName,
                  data: chunk.toString("utf-8"),
                }));
              } catch {
                child.kill();
              }
            });

            // Store child reference for cleanup
            (ws as any)._logProcess = child;
          }
        } catch {
          // Ignore invalid messages
        }
      },
    },
  });

  const displayHost = hostname === "0.0.0.0" ? "<host-ip>" : hostname;
  console.log(`Switchroom dashboard running at http://${displayHost}:${server.port}`);
  if (localhostOnly) {
    console.log(
      `  Tailscale users: run \`tailscale serve --bg --https / http://localhost:${server.port}\`` +
      ` then browse to https://<tailnet-name>.ts.net/ — tailnet members are authenticated automatically.`,
    );
  } else {
    console.log("  Network-accessible — token required for all requests.");
  }
  return { token };
}
