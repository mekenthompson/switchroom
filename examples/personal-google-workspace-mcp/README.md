# Personal Google Workspace MCP

This example sets up [taylorwilsdon/google_workspace_mcp][upstream] as a
docker-compose service exposing Google Drive + Docs + Sheets + Calendar
tools to **your own Claude Code session on the host** (not to switchroom
agents).

It is intentionally **separate from the agent-side feature.** Agents get
Workspace access via `switchroom auth google connect` →
`switchroom auth google account add` (RFC G §4.5, shipped) — see
[`docs/google-workspace.md`](../../docs/google-workspace.md) for the
fleet setup. **Do not reuse this example's OAuth client for the
fleet:** different trust posture (approval-kernel-mediated vs.
single-identity), and switchroom expects its own client. This example
is only for the operator's pair-design loop with their own host-side
`claude`.

> **Why two paths?** Agents run inside switchroom containers with
> approval-kernel-mediated tool access; the per-agent OAuth posture is
> load-bearing for the approval semantics (RFC D §2 + RFC G §4.4).
> Your own host-side Claude Code is a single-identity surface — none of
> that machinery applies. A shared HTTP MCP server is the right shape
> for the operator case and the wrong shape for the fleet.

[upstream]: https://github.com/taylorwilsdon/google_workspace_mcp

## What you get

- A long-running docker container (`google-workspace-mcp`) listening on
  loopback port 8217.
- 16 Workspace tools available to any Claude Code session that points
  its `.mcp.json` at `http://127.0.0.1:8217/mcp`.
- OAuth 2.1 PKCE flow — no client_secret to manage.
- Refresh tokens persist in `./credentials/` so you re-auth only on
  Google password change or 7-day Testing-mode expiry (see §5).

## What you don't get

- Tools in unrelated Claude Code sessions. The `.mcp.json` is
  project-scoped — Drive surface only appears when you `cd` to a
  directory that has it.
- Any effect on switchroom agents.
- HTTPS or LAN reachability. Loopback only by design.

## 1. GCP Console setup (~5 minutes, you do this)

1. Go to <https://console.cloud.google.com> and create (or pick) a
   project — name it `claude-workspace-mcp`.
2. **APIs & Services → Library** — enable each of these (one at a time;
   wait for "API enabled" before moving on):
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Calendar API
3. **APIs & Services → OAuth consent screen** → User Type **External**.
   - Fill App name (`claude-workspace-mcp`), your email, dev contact email.
   - Save and continue past the Scopes page (the server requests scopes
     at runtime — don't add any here).
   - **Add yourself as a Test User** under "Audience" (your gmail
     address).
   - Decide whether to **Publish app** — see §5 for the trade-off.
4. **APIs & Services → Credentials → Create Credentials → OAuth client
   ID** → Application type **Desktop app** → name it `claude-code-local`.
5. Copy the Client ID from the modal (looks like
   `12345-abc...xyz.apps.googleusercontent.com`). You can ignore the
   client secret — PKCE doesn't use it.

## 2. Set up this directory

```sh
cd examples/personal-google-workspace-mcp/
cp .env.example .env

# Edit .env:
#   GOOGLE_OAUTH_CLIENT_ID   ← paste from step 5 above
#   FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY ← generate via:

# (GNU sed — Linux)
sed -i "s|REPLACE_WITH_HEX_FROM_OPENSSL_RAND|$(openssl rand -hex 32)|" .env

# (BSD sed — macOS — use this instead)
# sed -i '' "s|REPLACE_WITH_HEX_FROM_OPENSSL_RAND|$(openssl rand -hex 32)|" .env

chmod 600 .env
```

## 3. Bring it up

```sh
docker compose up -d
docker compose ps          # should show "healthy" within ~30s
docker compose logs -f     # ctrl-c when you see "Uvicorn running on http://0.0.0.0:8217"
```

## 4. Wire it into Claude Code

Choose where the MCP server should be reachable:

**Project-scoped (recommended)** — the Workspace tools only appear when
you start Claude Code in this specific project directory:

```sh
cat > /path/to/your/project/.mcp.json <<'JSON'
{
  "mcpServers": {
    "google-workspace": {
      "type": "http",
      "url": "http://127.0.0.1:8217/mcp"
    }
  }
}
JSON
```

Restart Claude Code in that directory. On first start it'll prompt to
approve the new MCP server — say yes.

**User-scoped** (every Claude Code session sees Workspace tools): use
`claude mcp add` instead per upstream README — but think hard before you
do this, because you're then carrying Workspace authorization into every
unrelated codebase.

## 5. OAuth consent — Testing vs Production trade-off

When you set up the consent screen in §1.3, you chose between leaving
the app in **Testing** or clicking **Publish app**.

- **Testing** (default): refresh tokens expire **every 7 days** for
  Google's "unverified app + sensitive scopes" policy. You re-auth
  weekly via the inline OAuth prompt.
- **Production**: no 7-day expiry. The "Publish app" button prompts
  scary copy ("your app will be available to any user with a Google
  Account") but for a personal Desktop OAuth client with you as the
  only user, this is effectively a no-op — there's nothing to find or
  use without your specific Client ID.

Pick whichever your nerve allows.

## 6. Tier choice

`compose.yaml` defaults to `--tool-tier core` (~16 tools). Change to:

- `extended` (~40 tools) — adds Slides, Forms, Tasks, Chat. Re-consent
  needed (broader OAuth scopes). Procedure:
  1. Edit `compose.yaml` to bump `--tool-tier core` → `--tool-tier extended`.
  2. **Delete the existing token** so the upgraded scopes get requested
     on the next OAuth flow: `rm -rf ./credentials/`.
  3. `docker compose up -d --force-recreate`.
  4. Trigger a tool call from Claude Code — the OAuth URL will appear
     inline; tap to consent at the new scopes.
- `complete` (~60+ tools) — adds Gmail. **Not recommended yet** — Gmail's
  per-thread approval shape is unsuitable for the broad OAuth scopes
  this tier requests. Wait for a dedicated Gmail spec.

## 7. Maintenance

- **Logs**: `docker compose logs -f workspace-mcp`
- **Restart**: `docker compose restart workspace-mcp`
- **Re-auth** (Google password change or weekly Testing expiry): the
  next failed tool call surfaces a fresh OAuth URL inline; tap to
  consent, done.
- **Upgrade**: bump the `workspace-mcp==X.Y.Z` pin in `compose.yaml`,
  then `docker compose up -d --force-recreate`.
- **Tear down**: `docker compose down` (keeps credentials);
  `docker compose down -v` (deletes credentials, forces fresh OAuth).
- **Inspect tokens**: `ls -la ./credentials/` — one JSON file per
  authenticated Google account.

## 8. Troubleshooting

- **Container "unhealthy" forever**: check `docker compose logs` for
  Python tracebacks. Most common cause: `GOOGLE_OAUTH_CLIENT_ID` or
  `FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY` still has the
  `REPLACE_WITH_*` placeholder.
- **Port 8217 collision**: bump the port in `.env`
  (`WORKSPACE_MCP_PORT` + `GOOGLE_OAUTH_REDIRECT_URI`), in
  `compose.yaml` (the `ports:` mapping AND the healthcheck script),
  and in your `.mcp.json` URL.
- **OAuth flow fails with `redirect_uri_mismatch`**: make sure
  `GOOGLE_OAUTH_REDIRECT_URI` in `.env` exactly matches
  `WORKSPACE_MCP_PORT`. Loopback URIs don't need GCP-side registration
  for Desktop clients, but they do need to match what the server
  presents.
- **Claude Code doesn't show the new MCP server after `cd` to project**:
  exit and re-launch Claude Code (`/exit`, then `claude -c` to keep
  the conversation). `.mcp.json` is loaded at startup, not hot-reloaded.

## 9. Security notes

- `.env` is mode 600 — don't commit, don't share, don't snapshot.
- `./credentials/` directory holds refresh tokens — same restrictions.
  Add to disk-encryption scope if your host has any.
- The Workspace MCP sends data to Google APIs only, on your behalf,
  using your OAuth client. No telemetry, no third-party endpoints
  (verified per upstream's `pyproject.toml` dependency tree).
- The OAuth client_secret in your `gcp-oauth.keys.json` (if Google
  Cloud Console gave you one) is **not used** in PKCE flow. Treat it
  as cosmetic; you can ignore it. If it's worried you, regenerate it
  in GCP Console — won't break anything.
