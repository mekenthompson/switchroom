---
name: token-helpers
description: Refresh OAuth access tokens for Google Calendar and Microsoft Graph from refresh tokens stored in the switchroom vault. Library skill — invoked by other skills that need a short-lived access token to call calendar or Graph APIs, not directly by the user.
allowed-tools: Bash(switchroom vault *), Bash(./scripts/*)
---

# token-helpers

Shared shell scripts that exchange a long-lived OAuth refresh token for a short-lived access token and persist the new access token back to the Switchroom vault.

This is a library skill — other skills call into it rather than the user invoking it directly. A single refresh pipeline covers both Google and Microsoft providers.

## When to use

Invoke a helper when:
- You hold a refresh token in the vault and need a fresh access token to call an API
- The consuming skill does **not** cache tokens across agents (if it did, we'd promote this to an MCP server)

Each helper is a plain shell script: read the refresh token from the vault, POST to the provider's OAuth endpoint, persist the returned `access_token` back to the vault, and print it to stdout so callers can pipe it into the next step.

## Scripts

### `scripts/google-cal-token.sh`

Refreshes a Google Calendar OAuth access token.

Vault keys it reads (override via env):
- `google-cal-refresh-token` — the refresh token (env: `GOOGLE_CAL_REFRESH_TOKEN_KEY`)
- `google-cal-client-id` — OAuth client id (env: `GOOGLE_CAL_CLIENT_ID_KEY`)
- `google-cal-client-secret` — OAuth client secret (env: `GOOGLE_CAL_CLIENT_SECRET_KEY`)

Vault key it writes:
- `google-cal-access-token` — the new access token (env: `GOOGLE_CAL_ACCESS_TOKEN_KEY`)

Other env:
- `GOOGLE_OAUTH_TOKEN_URL` — override the token endpoint (default: `https://oauth2.googleapis.com/token`)
- `SWITCHROOM_CLI` — override the CLI binary invocation (default: `switchroom`)

Usage:

```bash
access_token=$(./scripts/google-cal-token.sh)
curl -H "Authorization: Bearer $access_token" https://www.googleapis.com/calendar/v3/users/me/calendarList
```

### `scripts/ms-graph-token.sh`

Refreshes a Microsoft Graph OAuth access token against the common tenant.

Vault keys it reads:
- `ms-graph-refresh-token` (env: `MS_GRAPH_REFRESH_TOKEN_KEY`)
- `ms-graph-client-id` (env: `MS_GRAPH_CLIENT_ID_KEY`)
- `ms-graph-client-secret` (env: `MS_GRAPH_CLIENT_SECRET_KEY`, optional — omit for public clients)

Vault key it writes:
- `ms-graph-access-token` (env: `MS_GRAPH_ACCESS_TOKEN_KEY`)

Other env:
- `MS_GRAPH_SCOPE` — space-delimited scope string (default: `https://graph.microsoft.com/.default offline_access`)
- `MS_OAUTH_TOKEN_URL` — override endpoint (default: `https://login.microsoftonline.com/common/oauth2/v2.0/token`)
- `SWITCHROOM_CLI` — override the CLI binary invocation

## Host prerequisites

- `curl`
- `jq`
- `switchroom` on `PATH` (or pass `SWITCHROOM_CLI`)
- `SWITCHROOM_VAULT_PASSPHRASE` exported so the CLI can unlock the vault non-interactively

## Exit codes

- `0` — new access token fetched and persisted
- `1` — missing vault entries, OAuth endpoint error, or malformed response
