# Google Workspace

Switchroom agents can read your Google Docs, Sheets, Slides, and folders
on your behalf, suggest edits inline in Drive, and collaborate on docs
with you over Telegram. Auth is per-user OAuth — the agent uses your
Google account, not a service account. Nothing leaves your subscription.

> **Status (2026-05-15).** The Phase 1 primitives are merged; the
> end-to-end Telegram flow lands as a series of follow-up wiring PRs
> (see `docs/rfcs/doc-connection-completion.md` §10 for the
> still-outstanding pieces). This guide describes the model — sections
> tagged **(pending wire-up)** are not yet operator-visible.

## TL;DR

```bash
# 0. One-time per install — create + register your Google OAuth client.
#    The wizard walks you through the GCP Console, stores the client
#    id/secret in the vault, and writes the google_workspace: config
#    block for you. (Manual equivalent: see "Prerequisite" below.)
switchroom auth google connect

# 1. Connect a Google account to the auth-broker (one-time per account).
switchroom auth google account add ken-personal

# 2. Allow an agent to use that account.
switchroom auth google enable ken-personal klanker

# 3. (Optional) Pick the Workspace tier — defaults to "core".
#    See docs/configuration.md § google_workspace for the cascade.
```

Step 0 is **required and one-time per switchroom install** — switchroom
deliberately ships no OAuth client (see "Prerequisite" below for why).
Steps 1–2 are the per-account / per-agent surface. Everything else is
one of:
- The agent already having access and doing the right thing.
- Telegram approval cards the operator taps when the agent asks.

## The model in 30 seconds

```
            ┌─ auth-broker ──────────────────────┐
            │                                    │
operator ───▶ google account add <label>         │
            │   → device-flow OAuth              │
            │   → refresh_token stored in        │
            │     ~/.switchroom/auth-broker/     │
            │                                    │
operator ───▶ google enable <agent> <label>      │
            │   → adds <agent> to the per-       │
            │     account ACL                    │
            │                                    │
agent ──────▶ get_credentials(provider=google,   │
            │   account=<label>)                 │
            │   → access_token (refreshed on     │
            │     demand by the broker)          │
            └────────────────────────────────────┘
```

**Per-account, not per-agent.** One Google account → many agents that
can use it (controlled by the ACL). One agent → can have multiple
accounts (the agent picks `account=<label>` per call). RFC G §4.4
spells out why this shape is load-bearing.

## Prerequisite — your OAuth client (one-time per install)

Before any agent can touch Drive you need **one Google OAuth client,
registered with switchroom**. Switchroom intentionally ships no shared
client: per-user OAuth against *your* client is what keeps the
integration subscription-honest (no service account, nothing routed
through a switchroom-owned credential), and Google's terms expect one
OAuth client per install. So this step is unavoidable by design — but
it's one-time, and the wizard does the mechanical parts.

> **This is not the host-side example.**
> `examples/personal-google-workspace-mcp/` sets up a *different* OAuth
> client for your own host Claude Code's pair-design loop. It is
> deliberately separate and its client must **not** be reused for the
> agent fleet — different trust posture (approval-kernel-mediated vs.
> single-identity). If you followed that README, you still need this
> step for agents.

### The native way

```bash
switchroom auth google connect
```

The wizard:

1. Walks you through the GCP Console screens (create project → enable
   Drive/Docs/Sheets/Calendar APIs → OAuth consent screen, add yourself
   as a test user → create an OAuth client of type **"TVs and Limited
   Input devices"**).
2. Prompts for the client id + secret and stores them in the vault
   **via the vault-broker** (`google-oauth-client-id` /
   `google-oauth-client-secret`) — the broker owns `vault.enc`, so the
   write works regardless of file ownership. The vault passphrase you
   enter is forwarded to the broker as operator attestation; it must
   match the passphrase the broker is unlocked with.
3. Offers to write the `google_workspace:` block into your
   `switchroom.yaml` (atomic write, comment-preserving; it
   re-validates the file afterward and never overwrites an existing
   block).
4. Points you at `switchroom auth google account add` to continue.

### The manual equivalent

If you'd rather do it by hand (the wizard automates exactly this):

1. **GCP Console** (≈5 min) — at <https://console.cloud.google.com>:
   create a project; under *APIs & Services → Library* enable the
   **Google Drive, Docs, Sheets, and Calendar** APIs; under *OAuth
   consent screen* pick **External**, add yourself as a **Test user**;
   under *Credentials → Create credentials → OAuth client ID* choose
   **"TVs and Limited Input devices"**. Copy the client id and secret.

   > **Client type matters.** It must be **TVs and Limited Input
   > devices**, not Desktop. `switchroom auth google account add`
   > authorizes via Google's device-code flow (you approve from your
   > phone — ideal for a headless 24/7 server), and Google only
   > supports device-code for that client type. A Desktop client gets
   > `invalid_client` / "Invalid client type." This is **different
   > from** `examples/personal-google-workspace-mcp/`, which uses a
   > Desktop client with browser loopback for the operator's own
   > host-side Claude Code — a different surface with a different flow.
2. **Vault the secrets** so they never land in YAML:

   ```bash
   switchroom vault set google-oauth-client-id
   switchroom vault set google-oauth-client-secret
   ```

3. **Add the block** to `~/.switchroom/switchroom.yaml` (top-level —
   the client id/secret are install-wide, not per-agent):

   ```yaml
   google_workspace:
     google_client_id: "vault:google-oauth-client-id"
     google_client_secret: "vault:google-oauth-client-secret"
     approvers: [123456789]   # your Telegram numeric user id
     tier: core               # core | extended | complete (default: core)
   ```

   See `docs/configuration.md` § `google_workspace` for the cascade
   and every field. `SWITCHROOM_GOOGLE_CLIENT_ID` /
   `SWITCHROOM_GOOGLE_CLIENT_SECRET` env vars override the block for
   one-off operator debugging, but the vault + YAML block is the
   persistent baseline switchroom expects.

## Connecting an account

```bash
switchroom auth google account add ken-personal
```

This runs Google's device-code flow:

1. Prints a URL + 6-digit user code. Open the URL on any device, paste
   the code, sign into Google.
2. Polls Google every 5s until you complete the flow.
3. Stores the refresh token in `~/.switchroom/auth-broker/` (encrypted
   at rest — same machine-bound vault posture as the rest of switchroom).
4. Account is now visible in `switchroom auth google account list`.

If you have multiple Google accounts to attach, repeat with different
labels (`ken-personal`, `ken-work`, etc.). The label is just for your
own reference — agents reference accounts by label, not by Google email.

### Scopes

Default scopes (Workspace tier `core`):

- `drive.readonly` — list folders, list files, read doc bodies
- `docs.readonly` — read Google Docs content + structure
- `sheets.readonly` — read Sheet cell values
- `userinfo.email` — identity sanity check on the refresh

Wider tiers (`extended`, `complete`) add write scopes, Calendar, Gmail.
The tier knob lives in the `google_workspace:` config block (see
"Configuration cascade" below) and the cascade rules are the same as
every other config field — `docs/configuration.md` covers the
general cascade model.

### Removing an account

```bash
switchroom auth google account remove ken-personal
```

Deletes the refresh token from the broker AND best-effort-revokes it
at Google. Idempotent — re-run if the first call fails to reach
Google.

## Granting an agent access

By default a new Google account is reachable by **no agents**. Enable
explicitly:

```bash
# Enable one or more agents on an account ("all" expands to every agent):
switchroom auth google enable ken-personal klanker
switchroom auth google enable ken-personal klanker clerk
switchroom auth google enable ken-personal all

# Inspect / revoke:
switchroom auth google list                       # show the full agent × account matrix
switchroom auth google disable ken-personal klanker
```

ACL changes take effect on the next `get_credentials` call — no agent
restart needed. The auth-broker is the source of truth (RFC G §4.4
+ RFC H Phase 3b).

## Working with the agent over Telegram

Once an agent has Drive access, the day-to-day shape:

### Reading docs

The agent can list folders / files / docs / sheets without further
prompts — `core` tier grants standing read access. The kernel's
approval flow doesn't gate read calls; you grant read access once at
account-enable time.

### Suggesting writes **(pending wire-up)**

When the agent wants to *edit* a doc — add a paragraph, replace a
TBD line, append meeting notes — it posts an approval card:

```
✏️ klanker wants to add to "Q3 Strategy Notes"
📍 after heading 'Goals' (level 2)
+47 lines / -0 lines
💬 "Added Hiring section after 'Goals'"
[ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
[ ⚠ Apply directly ]   [ 🚫 Cancel ]
```

Three things on this card are **wrapper-attested** — meaning the agent
cannot fake them:

- `📍` — where in the doc the edit lands (computed from the resolved
  anchor, not from anything the agent said).
- `+N / -M lines` — the actual line delta.
- `📖 Open in Drive` — the deep link to the actual doc.

The agent's `💬` summary is shown alongside but is the agent's framing,
not wrapper truth. If those two diverge, you can see it at a glance.

### Anchors

The agent doesn't say "insert at character offset 14732" — that's
brittle. It uses a stable anchor:

```typescript
// Headed doc (preferred)
{ after_heading: "Goals", level: 2 }
{ append_to_section: "Hiring", level: 2 }

// Unheaded doc (meeting notes, draft prose)
{ after_line_containing: "we agreed to ship by Q3" }
{ before_line_containing: "Action items:" }
{ replace_line_matching: /TBD: hiring section/ }

// Empty / very short docs
{ at_start: true }
{ at_end: true }
```

If an anchor doesn't resolve (heading renamed, snippet text changed),
the agent gets `HEADING_NOT_FOUND` / `SNIPPET_AMBIGUOUS` and asks you
in chat which one it should land on. No silent guess.

### Folder picker **(pending wire-up)**

`switchroom drive folders <agent>` posts a Telegram card with your
top-level folders. Tap one and you've authorised the agent for that
folder *and every doc inside it*. No need to grant per-doc when the
agent is going to work in `/Work/2026/Q3` for the next hour.

### Document recovery **(pending wire-up)**

If you trash a doc and later un-trash it, the reconciler notices and
the agent posts:

```
↻ 'Q3 Strategy Notes' is back — let me know if you want me to pick
up where I left off.
```

You don't have to re-grant access; the existing grant just becomes
reachable again. RFC E §4.4 spells out why this is asymmetric (we
treat un-trash as a recovery signal, but missing→missing isn't).

## Configuration cascade

The `google_workspace:` block (alias: `drive:`) lives in `switchroom.yaml`.
Defaults → profile → per-agent override, same as everything else
(see `docs/configuration.md` for the general cascade rules). The
minimum:

```yaml
google_workspace:
  tier: core            # core | extended | complete
  # tools: { include: [...], exclude: [...] }  # optional per-tool override
```

Per-agent ACL is set via `auth google enable/disable`, not the YAML —
ACL changes need to be auditable without an agent restart (RFC G §4.4).

## Troubleshooting

### "Drive disconnected — reconnect klanker?"

The refresh token has been revoked or rotated. Re-run:

```bash
switchroom auth google account add ken-personal  # OAuth flow
# OR if the broker still has the slot but the token is dead:
switchroom auth google account remove ken-personal
switchroom auth google account add ken-personal
```

Causes: the user changed their Google password, revoked switchroom in
the Google Account dashboard, or the OAuth client's verification
expired (7-day Testing-mode token lifetimes).

### Agent says "Not logged in" right after `switchroom update`

The boot-fanout fix in #1280 + the mirror-time enrichment in #1285
address the known cases. If you hit it on a current build:

```bash
switchroom auth google list                      # confirm the account is registered
switchroom auth google enable <account> <agent>  # re-attach if the agent fell out of the ACL
switchroom agent restart <agent>
```


### Two agents stomping on each other's Drive

Each agent has its own kernel grants — they don't share. If two agents
both wrote to the same doc within the approval-card window, the
agent-side audit log (`switchroom debug audit <agent>`) shows what
happened, and Drive's own revision history shows the merged result.
Switchroom doesn't currently broker between agents writing to the
same doc — they race like any other Drive collaborators.

### "MULTIPLE_MATCHES" error from a suggested edit

The agent's text-snippet anchor matched 2+ lines in the doc. The
error response carries the first 3 surrounding-context excerpts; the
agent picks one by `nth_match` index. If the agent burns 3+ tool calls
on the same doc with bad anchors, the wrapper returns the doc's full
structural tree so the agent can re-plan from ground truth.

## See also

- `docs/rfcs/google-workspace-generalization.md` — RFC G (per-account
  ACL, auth-broker provider, examples/personal-google-workspace-mcp/).
- `docs/rfcs/doc-connection-completion.md` — RFC E (Drive collab loop,
  Phase 1 anchors / diff-preview / folder picker / recovery).
- `docs/rfcs/gdrive-mcp.md` — RFC D (original Drive MCP integration,
  shipped v0.6.0; supersedes the env-vars-only auth model).
- `docs/configuration.md` — the cascade, all knobs.
- `examples/personal-google-workspace-mcp/` — host-side single-user
  HTTP MCP for the operator's own pair-design loop (different shape
  from the agent-side wrapper above).
