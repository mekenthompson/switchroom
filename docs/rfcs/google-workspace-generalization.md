# RFC G: Google Workspace as a first-class agent capability

Status: Draft v2
Author: Ken (with Claude pair-design)
Date: 2026-05-14

**v2 changes** (addressing PR #1240 review):
- CLI moved from invented `switchroom workspace ...` (which collides with the existing top-level `workspace` verb) to `switchroom auth google ...`, mirroring the auth-slot-pool pattern (account creation as separate verb, plural-agents on `enable`/`disable`, `--from-agent` flag instead of arrow syntax). See §4.5.
- Phase 2 migration changed from interactive per-token merge to **clean cutover** (apply-time legacy-slot detection + refusal pointing at the new flow). Mirrors `share-auth-across-the-fleet.md` decision #10. See §7 + §8.
- §5 acknowledges multi-Google-account-per-agent as the expected #1 follow-up rather than an indefinite out-of-scope.
- §9 adds scope-drift-on-re-consent risk + drops the migration risk that no longer applies.
- §4.7 drops the unverified `examples/operator-rebar/` precedent claim — `examples/` ships only top-level YAMLs today.

Prerequisites:
- **RFC B — Approval kernel** — landed v0.6.0 (#762).
- **RFC D — Google Drive MCP integration** — landed v0.6.0 (#763, #766, #767, #768). This RFC generalizes RFC D from "Drive only" to "the whole upstream Workspace surface."
- **RFC E — Drive collab loop** — drafted (PR #1227). Orthogonal: RFC E covers the *interaction* shape (folder picker, suggesting writes, anchors); this RFC covers *which surfaces* are available and *how operators enable them*. They can ship in either order.

This spec generalizes RFC D's Drive-only integration into the full
Google Workspace surface, exposes the upstream MCP's tier knob, and —
load-bearing — moves OAuth tokens from per-agent vault slots to
**per-Google-account vault slots with per-agent ACL**, mirroring the
auth slot pool pattern from `share-auth-across-the-fleet.md`.

## 0. Goal

A switchroom operator opts an agent into Google Workspace **once per
Google account**, picks the tool surface (tier + optional
include/exclude), and any other agent in the fleet can be enabled on
the same account without re-consenting. Each agent's access remains
gated by the approval kernel under its own identity.

## 1. Outcome

End-to-end flow from the operator's terminal:

```
$ switchroom auth google account add you@example.com
🔐 Adding Google account you@example.com
   On any device with a browser, visit:
       https://www.google.com/device
   And enter this code: WDJB-MJHT
   ...
   ✅ Account you@example.com added to vault.
   Enable on agents: switchroom auth google enable you@example.com <agents...>

$ switchroom auth google enable you@example.com klanker gymbro
   ✅ klanker, gymbro now have access via you@example.com.
   No re-consent needed — both agents share the account's refresh token.

$ switchroom auth google list
ACCOUNT                AGENTS                TIER    LAST USED
you@example.com      klanker, gymbro       core    2 min ago
work@bigcorp.com       coderev               extended  yesterday

$ switchroom auth google share you@example.com --from-agent klanker --to-agent executive
   ✅ executive now has access via you@example.com (copied from klanker).
```

(The shape mirrors `switchroom auth account add | enable | share | list | account remove` for Anthropic accounts. Google is the second vendor under `auth`; future vendors — Notion, Slack — follow the same `auth <vendor> ...` pattern.)

End-to-end flow from a Telegram thread (uses RFC E §4.3 deep links + RFC D headless OAuth):

```
User → klanker:  "Pull the Q3 doc from /Work and add a hiring section."
klanker:         🔐 needs Drive access via you@example.com
                 [ ✅ Allow this folder ]  [ 🚫 Deny ]
User:            [taps Allow]
klanker:         ...proceeds via approval kernel + RFC E suggesting writes
```

What's different from today (RFC D shipped state):

- Two agents on one Google account = **one OAuth dance**, not two.
- Calendar, Sheets, Slides become available as agent-callable tools
  alongside Drive + Docs.
- Operator picks the tier (`core` / `extended` / `complete`) per agent
  rather than getting a hardcoded Drive surface.
- Agent identity stays separate at the approval layer — `klanker`
  reading `/Q3 Strategy` is a different approval row than `gymbro`
  reading the same doc, even though they share the OAuth token.

## 2. Vision alignment

Maps to three of the four outcomes in `reference/vision.md`:

- **Multi-agent fleet (#2)** — Each specialist gets the surface its
  role calls for: `coderev` gets Drive + Sheets, `coach` gets Drive +
  Calendar, `executive` gets the lot. The fleet feels like specialists,
  not one cookie-cutter agent with all-or-nothing Workspace.
- **Subscription-honest (#3)** — Per-user OAuth, refresh tokens in
  vault, no service accounts. Same posture as RFC D §4. The user pays
  Google once, switchroom routes it to consumers.
- **Always-on (#4)** — Refresh tokens survive reboots. Per-account
  storage means a single broker keeps one token fresh, not N.

Visibility (#1) is served by the existing approval kernel (RFC B) +
RFC E's diff-preview surface — no new work for that outcome here.

## 3. JTBD alignment

- **`share-auth-across-the-fleet.md`** — *literally* the same JTBD,
  applied to Google instead of Anthropic. *"Log into Google once per
  account, not once per agent."* The "Signs it's working" checklist in
  that JTBD doc translates one-for-one: enabling a second agent
  requires no OAuth flow; `workspace list` answers "which agents use
  which account" on one screen; sub-agents inherit; tokens survive
  idle gaps; removal is one explicit action; no orphans.
- **`extend-without-forking.md`** — Adding Workspace to an agent is a
  config edit + a CLI verb. New tools added by upstream (`extended` /
  `complete` tiers) are a config-knob change, not a code patch.
- **`talk-to-agents-from-anywhere.md`** — Headless OAuth tier from RFC
  D §3.2 already covers SSH installs. `switchroom auth google account
  add` composes that with the new flow; `auth google connect <agent>`
  does the wizard combo for first-run.
- **`know-what-my-agent-is-doing.md`** — Each agent's tool calls
  remain separately approval-gated and audited (`approval_audit.action`
  records `read | suggest | write`); shared OAuth doesn't blur the
  visibility of *which agent did what*.

## 4. Scope — seven pieces

### 4.1 `google_workspace:` config block (with `drive:` alias)

The shipped `drive:` block (RFC D #768) gets generalized:

```yaml
# switchroom.yaml
google_workspace:
  # default for every agent unless overridden
  tier: core              # core | extended | complete
  default_account: you@example.com

agents:
  klanker:
    google_workspace:
      account: you@example.com
      tier: core           # 16 tools: Drive + Docs + Sheets + Calendar
  gymbro:
    google_workspace:
      account: you@example.com
      tier: core
      exclude: [calendar]   # 13 tools — gymbro doesn't need Calendar
  executive:
    google_workspace:
      account: work@bigcorp.com
      tier: extended         # 40 tools — adds Slides, Forms, Tasks, Chat
```

Back-compat: existing `drive:` blocks parse identically to
`google_workspace: { tier: core, exclude: [calendar, sheets] }`. The
loader emits a one-line deprecation note in `switchroom apply`.

Cascade: standard per-key merge. `default_account` cascades; `tier`,
`include`, `exclude` cascade. Documented in `docs/configuration.md`.

### 4.2 Tier knob — `core` / `extended` / `complete`

Maps directly to the upstream MCP's `--tool-tier` flag.

- `core` (default, ~16 tools): Drive + Docs + Sheets + Calendar.
  Validated in our own pair-design setup; this is the default for any
  agent newly connected.
- `extended` (~40 tools): adds Slides, Forms, Tasks, Chat.
- `complete` (~60+ tools): adds Gmail (which has its own approval-
  shape considerations — see §5 out of scope).

Tier is per-agent, not per-account. Two agents on the same account
can have different tiers — each runs its own MCP wrapper subprocess
inside its own container, configured with its tier. The OAuth token
is shared; the **MCP server process is not** (preserving RFC D's
per-agent subprocess model and its security properties).

### 4.3 `tools:` include/exclude override

For when the tier is mostly right but one tool is unwanted (e.g.
*"I want core minus Calendar"*) or wanted (*"I want core plus
Slides without going up to extended"*).

```yaml
agents:
  klanker:
    google_workspace:
      tier: core
      exclude: [calendar]      # remove from tier
      include: [slides_create] # add specific tool from a higher tier
```

Exclude wins over include on conflict. Switchroom validates at
`apply` time that included tools exist in the upstream MCP's
manifest; unknown tool names fail fast with the suggestion list.

### 4.4 Per-account vault slot + per-agent ACL (the load-bearing piece)

**Vault slot key changes from per-agent to per-account:**

```
# Before (RFC D §4.1):
gdrive:<agent_unit>:refresh_token

# After:
google:<account_email>:refresh_token
google:<account_email>:refresh_token:status        # invalid-grant signaling
google:<account_email>:scopes                      # cached scope set
```

**Per-agent ACL enforced at the broker:**

A new vault ACL primitive — `google_account_grant` — gates which
agents can read which account's token:

```yaml
# Stored in the broker's ACL config, written by `workspace enable/disable`:
google_accounts:
  you@example.com:
    enabled_for: [klanker, gymbro]
  work@bigcorp.com:
    enabled_for: [executive]
```

Broker enforcement: `getCredential("google:<acct>:refresh_token")` is
allowed only when the requesting `agent_unit` is in
`google_accounts.<acct>.enabled_for`. Matches the auth slot pool's
existing pattern (per-account secret, per-agent ACL).

**Drift handling:** when an agent is removed from `enabled_for`,
existing approval-kernel grants under that agent's identity for
`doc:gdrive:*` etc. are *not* auto-revoked (the user might re-enable
the agent shortly). They become **dormant** — the next access by
that agent gets a `not_authorized` from the broker, which the
approval kernel surfaces as: *"klanker no longer has access to
you@example.com — re-enable with `switchroom auth google enable
you@example.com klanker` or revoke remaining grants with
`/approvals revoke <id>`."*

**MCP wrapper change:** the per-agent subprocess (still running
inside the agent container, per RFC D) now reads its OAuth token
via the broker using the **account** named in its config, not its
own agent_unit. The wrapper's startup sequence:

1. Read `google_workspace.account` from agent config.
2. Call broker: `getCredential("google:<acct>:refresh_token")`.
3. Broker validates `agent_unit ∈ google_accounts.<acct>.enabled_for`.
4. Wrapper exchanges refresh → access token, runs the upstream MCP.

If broker denies (agent removed from ACL): wrapper exits cleanly,
agent's MCP tools just don't appear, gateway surfaces a one-line
notice in chat per the dormant-grant text above.

### 4.5 CLI surface — `switchroom auth google ...`

**Naming:** the new verbs live under `auth` to mirror the existing
`auth account ...` pattern for Anthropic accounts (which is the
shape the JTBD `share-auth-across-the-fleet.md` settled on, and
which we explicitly want to inherit one-for-one). Google is the
second auth vendor; future vendors (Notion, Slack) follow the
same `auth <vendor> ...` pattern. `switchroom workspace` already
exists as a top-level verb (manages AGENTS.md/MEMORY.md scaffold
files) — using it for Google would silently break operators.

`switchroom drive ...` (RFC D shipped surface) becomes a thin
alias delegating to `auth google ...` for Drive-only operations,
with a one-line deprecation note in `switchroom apply`.

**Verb shape — mirrors `switchroom auth account ...` exactly:**

```
# Account lifecycle (creation is its own verb — never a side effect of enable)
switchroom auth google account add <account>           # OAuth flow, lands token in vault
switchroom auth google account remove <account>        # OAuth revoke + delete vault slot (refused while any agent is enabled)
switchroom auth google account list                    # bare accounts (no agent matrix)

# Agent-to-account ACL
switchroom auth google enable <account> <agents...>    # plural agents, multi-enable in one call
switchroom auth google disable <account> <agents...>   # plural disable

# Convenience
switchroom auth google list                            # accounts × agents matrix
switchroom auth google share <account> --from-agent <name> --to-agent <name>
                                                        # copy enable-state from one agent to another
                                                        # mirrors `auth share <label> --from-agent` exactly

# Wizard convenience (NOT a primary verb — only used by `switchroom setup`)
switchroom auth google connect <agent>                 # alias for: account add + enable in one shot,
                                                        # for the first-run experience only
                                                        # (mirrors `auth login <agent>` per JTBD decision #12)
```

**`account add` flow** uses RFC D's three-tier OAuth auto-select
(device-code → OOB-paste → desktop-loopback). On a host with no
`$DISPLAY`, the device-code flow is used by default; explicit
`--headless` forces it. Token lands at
`vault:google:<account>:refresh_token` regardless of which agent
will use it.

**`account remove` refuses** while any agent is still enabled on
that account, per the JTBD's "no orphaned tokens left behind"
check (mirrors `auth account remove` exactly).

**`enable` / `disable` are plural** — `enable you@example.com
klanker gymbro coderev` is one call writing one ACL update + one
audit row, not three. The JTBD calls this out as the right shape
for "add a sixth agent to my Anthropic account" — same shape
applies to Google.

**`share` uses `--from-agent` / `--to-agent` flags**, not arrow
syntax. The CLI has no precedent for `→` and inventing one would
be a consistency violation. (We considered `share <agent_a> →
<agent_b>` in v1; the reviewer flagged it; we agreed.)

### 4.6 Setup wizard inline prompt

`switchroom setup`, after the first agent is created and bot is
working, adds:

```
─────────────────────────────────
Optional: Connect Google Workspace
─────────────────────────────────
Your agent (klanker) can read and (with approval) write to your
Google Drive, Docs, Sheets, and Calendar. Tools appear as
approval-gated requests in Telegram.

Connect now? [Y/n] _
```

Default Y. Inline runs `switchroom auth google connect klanker`
(the wizard convenience verb that combines `account add` +
`enable` per §4.5) → device-code flow if headless else loopback.
If user declines, the wizard surfaces *"Connect later with:
switchroom auth google connect klanker"* and continues. No
mention of `docs/`.

Survives the docs test (no docs reading needed) and the defaults
test (no config-by-default for users who aren't using Workspace —
opt-in but advertised).

### 4.7 `examples/personal-google-workspace-mcp/` for operator-host use

The docker-compose pattern we built for our own Claude Code session
becomes a documented example shipped in the repo:

```
examples/
  personal-google-workspace-mcp/
    README.md          # the GCP Console + .mcp.json setup walkthrough
    compose.yaml       # the working compose with volumes + healthcheck
    .env.example       # OAuth client ID + signing-key placeholder
```

**Distinct from the agent-side feature** above — the README opens
with: *"This is for **operators** who want their **own** Claude Code
on the host to have Workspace tools (alongside or instead of giving
agents access). It does not affect switchroom agents — they get
Workspace via `switchroom auth google connect <agent>` (RFC G §4.5)."*

Today `examples/` contains only top-level YAMLs (`minimal.yaml`,
`switchroom.yaml`); RFC G establishes the `examples/<artifact>/`
subdirectory pattern. Future operator-host integrations (Notion,
Slack, etc.) follow the same shape under `examples/personal-*-mcp/`.

## 5. Out of scope

- **Multi-Google-account-per-agent** — each agent connects to one
  account at a time. If an agent needs both `you@example.com` and
  `work@bigcorp.com`, that's a future spec. Ad-hoc workaround:
  spin up a second agent on the second account. **This is
  acknowledged as the most likely follow-up RFC** — operators who
  run a personal+work life from one assistant agent will hit it
  fast. The fix probably looks like a list-valued `accounts:` config
  block + a runtime account-picker on tool invocation. Out of scope
  here only because the per-account ACL primitive in §4.4 is
  prerequisite plumbing for it.
- **Service-account auth** — same reason as RFC D §12: collapses
  approval semantics.
- **Gmail as a first-class collaboration surface** — Gmail's
  approval shape is per-thread, not per-doc; even at `complete`
  tier the Gmail tools are exposed but with a coarse "read all
  email" or "send all email" approval, which is wrong. A proper
  Gmail RFC handles per-thread / per-label / per-sender approvals
  separately.
- **Cross-tenant / Workspace admin features** — switchroom is
  single-operator (vision.md). Workspace admin tooling for
  managing multiple users in one Google Workspace tenant is out
  of scope and likely always will be.
- **Notion / Slack** — RFC F covers second-surface. This spec
  generalizes *within* Google Workspace, not *across* doc surfaces.
- **Selective scope downgrade after consent** — once OAuth scopes
  are granted, switchroom doesn't try to re-prompt the user to
  reduce them. Operator runs `account remove` + `account add` to
  re-do.
- **Per-tier billing / quota tracking** — Google Workspace is
  flat-rate per account, not per-tool; nothing to track.

## 6. Principle checks

Per `reference/principles.md`:

### 6.1 Docs test — *"Can someone use this without opening `docs/`?"*

- ✅ `switchroom auth google account add you@example.com` prints
  the OAuth URL inline + says "tap to consent." No prerequisite
  reading. Wizard alias `auth google connect klanker` works the
  same way for the first-run path.
- ✅ Setup wizard prompt explains *what* and *why* in two
  sentences ("read and (with approval) write to your Drive, Docs,
  Sheets, Calendar — tools appear as approval-gated requests").
- ✅ `workspace list` is self-documenting — accounts × agents
  matrix tells the user the state.
- ✅ Drift error (agent removed from ACL) tells the user the next
  command.

### 6.2 Defaults test — *"Does it work on a fresh `switchroom setup`?"*

- ✅ Tier defaults to `core` — the validated 16-tool surface.
- ✅ Setup wizard offers Workspace by default (Y), so a fresh
  install gets it without config-file editing.
- ✅ Per-account storage is the default once enabled — no operator
  has to opt into "share auth across the fleet"; that's just how it
  works.
- ✅ Per-agent approval default is per-action (RFC B / RFC E
  posture preserved).

### 6.3 Consistency test — *"Does this feel like one product?"*

- ✅ `switchroom auth google account add|remove|list` + `auth
  google enable|disable|list|share` mirrors the existing
  `switchroom auth account add|remove|list` + `auth enable|disable
  |share` shape exactly. Account-creation is its own verb (per
  JTBD decision #6), `enable`/`disable` are plural-agents, `share`
  uses `--from-agent` flag (no invented arrow syntax).
- ✅ `vault:google:<acct>:*` matches the `vault:<surface>:*` slot
  pattern.
- ✅ `apv:` callback shape unchanged; new tools added to existing
  approval kernel.
- ✅ `/approvals list|revoke|add|stats` surface unchanged — adding
  Calendar/Sheets/Slides scopes adds rows, not commands.
- ✅ Cascade rules for `google_workspace:` block follow standard
  per-key merge (`src/config/merge.ts`), documented same way as
  every other config field.
- ✅ Setup wizard prompt is in the same style as the bot-token and
  first-agent prompts — opinionated default, easy decline.

## 7. Migration / rollout

Five phases, each independently shippable. Phase 2 is load-bearing;
the others can land in any order around it.

1. **Phase 1 — Config block + tier knob (no breaking changes).**
   Generalize `drive:` → `google_workspace:` with the alias.
   Plumb `tier` through to the MCP subprocess command-line. No
   change to vault layout. Operators of existing Drive integrations
   notice nothing. **~45 min.**
2. **Phase 2 — Per-account vault slot + per-agent ACL (load-
   bearing).** Add `google_account_grant` ACL primitive to the
   broker. Wrapper updates to read by account. **Clean cutover, no
   migration shipped** — `switchroom apply` detects legacy
   `gdrive:<agent>:refresh_token` slots and **refuses to start the
   new wrapper**, printing a one-screen explanation pointing the
   operator at `switchroom auth google account add <account>` +
   `enable`. Mirrors decision #10 of `share-auth-across-the-fleet.md`
   ("no migration shipped... no compatibility shims") — RFC D shipped
   only days ago in v0.6.0; the installed base is small enough that
   asking those operators to re-add their accounts is the right
   trade for keeping the design surface clean for everyone after.
   **~60 min.**
3. **Phase 3 — CLI verbs (`auth google account add|remove|list`,
   `auth google enable|disable|list|share`, `auth google connect`
   wizard alias).** `drive` verbs become thin aliases delegating to
   `auth google` for Drive-only ops, with a one-line deprecation
   note in `apply`. **~75 min.**
4. **Phase 4 — Setup wizard prompt.** Inline Workspace connect
   after first-agent creation. **~30 min.**
5. **Phase 5 — `examples/personal-google-workspace-mcp/`.**
   Compose.yaml + README + .env.example, lifted from the working
   pair-design setup. **~30 min.**

Total: **~3.7 hours agent time** for the full RFC (down from ~5h
in v1 — Phase 2 dropped 90 min by removing the interactive
migration tool per the clean-cutover decision).

## 8. Effort estimate

Per CLAUDE.md, in **agent minutes**:

| Phase | Item | Estimate |
|---|---|---|
| 1 | Config block + tier knob + cascade tests | ~45 min |
| 2 | ACL primitive + broker tests + apply-time legacy-slot detector | ~60 min |
| 2 | MCP wrapper account-based credential read | ~30 min (subset of 60) |
| 3 | `auth google` CLI verbs + `drive` deprecation alias | ~75 min |
| 4 | Setup wizard prompt + decline path | ~30 min |
| 5 | Examples dir + README | ~30 min |
| — | Doc updates (`docs/google-workspace.md` new file, RFC cross-refs) | ~30 min |

**~3.7 hours agent time** total (Phase 2 dropped 90 min by
removing the interactive migration tool per the clean-cutover
decision in §7). Two-day spread if interspersed with other work;
one focused day if pushed end-to-end.

## 9. Risks and open questions

- **Re-consent silently expands scope across all enabled agents.**
  If `klanker` is enabled at `tier: core` (Drive+Docs+Sheets+Cal)
  and the operator later runs `account remove` + `account add` to
  re-consent for `gymbro` at `tier: extended` (adds Slides), the
  shared refresh token now grants Slides scope to **klanker too**
  — even though klanker's operator never approved that. The kernel
  still gates writes per-agent (Slides write requires a fresh
  approval card), but reads of newly-scoped surfaces are not
  gated. Mitigation: re-consent triggered by tier-bump posts a
  "scope expanded" notice via Telegram to **every enabled agent's
  approver**, naming the new scope and the agent that triggered
  it. Operator can `disable` proactively if the expansion is
  unwanted.

- **Approval kernel drift on agent removal.** `disable <account>
  <agents...>` orphans the agents' standing approvals. Per §4.4
  they become dormant, not auto-revoked. Risk: if the operator
  forgets about them, they sit indefinitely. Mitigation: weekly
  staleness digest (RFC B §9.1) already surfaces dormant grants —
  `auth google disable` adds a one-line notice listing the
  about-to-go-dormant grants for the operator to confirm or
  pre-revoke.

- **Legacy-slot refusal (Phase 2 cutover) blocks operators
  mid-flight.** A v0.6.0 operator running `switchroom apply` after
  Phase 2 lands gets a hard refusal until they re-add their
  account. If this lands during business hours and the operator
  is mid-task, they're blocked. Mitigation: ship Phase 2 as a
  CHANGELOG-headlined breaking change in a minor version bump
  (v0.7.0 → v0.8.0), not a patch. The v0.7.x branch keeps
  per-agent slots working for operators not ready to cut over.
  Pattern is the same as the cron-fold-in cutover (PRs #890–#893)
  documented in CLAUDE.md.

- **Tier change after connect.** Going from `core` to `extended`
  doesn't expand granted OAuth scopes — Google's consent already
  completed. The new tier's tools that need broader scopes will
  fail at runtime. Mitigation: `apply` checks each agent's tier
  against the cached `google:<acct>:scopes` slot; warns operator
  inline if the upgrade requires re-consent: *"klanker's tier
  bumped to extended — needs Slides scope. Run `auth google
  account remove you@example.com` + `account add` to re-consent,
  or exclude Slides tools."*

- **Setup wizard prompt fatigue.** If we add too many "optional
  but recommended" prompts during setup, the user starts skipping
  by reflex. Workspace prompt sits after bot-token + first-agent
  + (potentially) Hindsight memory; that's already three Y/n
  prompts. Mitigation: order matters — Workspace prompt comes
  *last* in the optional-features sequence, after the user has
  seen the agent respond once. Fewer dropouts at the end.

- **Per-account ACL config drift across operators.** If an
  operator manually edits `~/.switchroom/google_accounts.yaml`
  (or wherever ACL lives) outside the CLI, the broker's view and
  the CLI's view of "who's enabled" can diverge. Mitigation: ACL
  state is a derived view, not source-of-truth — `auth google
  list` reads the broker, `enable/disable` writes through the
  broker.
  No manual edit path documented; the file (if any) is internal.

## 10. Tracking

Open one tracking issue per phase, all blocked on this spec
landing:

- [ ] Phase 1 — Config block + tier knob + `drive:` alias
- [ ] Phase 2 — Per-account vault slot + per-agent ACL + apply-time
  legacy-slot detector (clean cutover, no migration tool)
- [ ] Phase 3 — `switchroom auth google ...` CLI verbs + `drive`
  alias deprecation
- [ ] Phase 4 — Setup wizard inline prompt
- [ ] Phase 5 — `examples/personal-google-workspace-mcp/`
- [ ] Cross-cutting — `docs/google-workspace.md` user guide

Pairs with:
- **PR #1227 (RFC E)** — Drive collab loop — orthogonal, both can
  ship.
- **RFC F** (deferred, not yet open) — second doc surface (Notion).
  RFC G's per-account ACL pattern becomes the template when RFC F
  lands a Notion `notion:<workspace>:*` slot.
