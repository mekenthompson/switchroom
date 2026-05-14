# RFC E: Complete the doc-connection surface

Status: Draft v1
Author: Ken (with Claude pair-design)
Date: 2026-05-14

Prerequisites — both shipped:
- **RFC B — Approval kernel** (`approval-kernel.md`) — landed v0.6.0 (#762).
- **RFC D — Google Drive MCP integration** (`gdrive-mcp.md`) — landed v0.6.0 (#763, #766, #767, #768).

This spec finishes the work RFC D explicitly deferred and proves the
approval-kernel + onboarding pattern is reusable across doc surfaces by
landing a second one (Notion). It is the "Phase 4+" for doc-connection
that RFC D pointed at without scoping.

## 0. Goal

The user can connect any agent to any document surface they live in
(Drive, Notion, eventually Slack/Gmail) with the **same** one-tap
onboarding card, the **same** approval shape, the **same** vault-stored
OAuth they got with Drive in v0.6.0 — and the same ergonomics for the
two pieces RFC D punted: browsing folders to grant access, and granting
write access without conflating it with read.

## 1. Outcome

A user who tells klanker "go through my /Work/2026 folder and pull out
anything that mentions hiring" can do the whole flow from Telegram on a
phone in three taps:

1. Agent requests folder access → coalesced approval card with
   `[ Browse this folder ]` + `[ Allow always ]`.
2. (Optional) Tap browse → see the folder tree in a card, confirm.
3. Tap Allow → done. Agent proceeds.

Today, step 1 forces the user to either pre-grant by typing
`doc:gdrive:folder/<id>/**` (worse than per-doc), or accept the
prompt-flood of per-doc on a fresh folder. The same user, asked to
connect Notion next month, hits **the same card shape, the same vault
slot pattern, the same CLI verb** — no new mental model.

## 2. Vision alignment

Maps to three of the four outcomes in `reference/vision.md`:

- **Multi-agent fleet (#2)** — Specialists need access to the docs they
  specialize in. A health coach without your habit-tracker notes is a
  generalist; a research agent without your reading list is amnesia. Doc
  connections are how a specialist becomes specific.
- **Subscription-honest (#3)** — Every doc surface uses per-user OAuth,
  refresh tokens in vault, no service accounts, no shadow API billing.
  Same posture as RFC D §4.
- **Always-on (#4)** — Refresh tokens survive reboots; missing-doc events
  surface in chat without breaking the agent loop; reconciler recovery
  (§4.3) lets scheduled tasks pick up after transient gaps.

**Visibility (#1)** is served by the approval card UX already shipped
in RFC D — no new work here for that outcome.

## 3. JTBD alignment

- **`extend-without-forking.md`** — *"The user adds a new agent, skill,
  or tool by configuring it, not by editing the product."* Adding
  Notion access for klanker should be a config edit + an OAuth tap,
  not a fork. The "second surface" goal in §4.4 is the JTBD test: if
  Notion takes 200 lines of new code copy-pasted from `src/drive/*`,
  that fails the JTBD and is a refactor signal.
- **`share-auth-across-the-fleet.md`** — *"One auth per account, not
  per agent."* Drive OAuth = once per Google account; Notion OAuth =
  once per workspace. Refresh tokens live in vault slots scoped to the
  agent_unit (per RFC D §4.1), but the OAuth flow itself is run once
  and the resulting credentials cascade through the fleet via shared
  vault references. Adding a second consumer to klanker doesn't trigger
  a second OAuth dance.
- **`talk-to-agents-from-anywhere.md`** — *"The user can drive their
  fleet from a phone on the train as naturally as from a laptop."*
  Folder picker, write approvals, reconnect-on-revocation — every flow
  in this spec is reachable from Telegram, never requires SSH or a
  desktop browser (the headless OAuth tier from RFC D §3.2 covers the
  one place where a browser is needed).

## 4. Scope — four pieces

### 4.1 Drive folder picker (deferred from RFC D §6) — P1

**Today:** per-doc grant works fine; folder grants require typing
`doc:gdrive:folder/<id>/**` by hand. RFC D §6 acknowledges this is
worse than either default and explicitly punted.

**Design:**

- New CLI verb: `switchroom drive folders <agent>` — does *not* render
  in the terminal. Posts a card in the agent's Telegram topic.
- Card surface: paginated folder list, top-level first, breadcrumb on
  long names. One tap on a folder = expand into its children + back
  arrow. One tap on `[ ✅ Allow this folder ]` = write `allow_always`
  at `doc:gdrive:folder/<id>/**` and surface the standard granted-card
  confirmation (with `· /approvals revoke <id>` inline per RFC B §9).
- The same picker is reachable from inside an in-flight per-doc
  approval card via a new `[ 📁 Allow folder instead ]` button — the
  primary mitigation for the prompt-flood path RFC D §5 warns about.
- Listing source: `files.list` with
  `q="mimeType='application/vnd.google-apps.folder' and 'me' in owners
  and trashed=false"`, paginated 50 per card. Cached for 5 min per
  agent (folder structures don't change minute-by-minute).
- Staleness digest from RFC B §9.1 also gets a `[ 📁 Browse ]` button
  next to each folder grant so the user can audit before keeping.

**Pagination is not optional.** Drive accounts with deep folder trees
(>100 top-level folders) are common. Ship the paginated path on day 1.

### 4.2 Drive write operations (deferred from RFC D §12) — P2

**Today:** read-only by design. RFC D §12 stipulates writes need their
own scope namespace so a read grant never silently authorizes a write.

**Design:**

- New scope namespace: `doc:gdrive:write:<id>` and
  `doc:gdrive:write:folder/<id>/**`. Read scopes are unchanged.
- MCP wrapper exposes write tools as separately approval-gated:
  `gdrive_create_doc`, `gdrive_append_to_doc`,
  `gdrive_replace_doc_content`. Read tools (`gdrive_read_doc`,
  `gdrive_search`) keep using the existing read scopes.
- `humanize()` for write scopes prefixes the title with **✏️** and
  renders a one-line diff summary inline if available
  (`+12 / −3 lines · "added Hiring section"`).
- Approval defaults are stricter than reads:
  - Primary `Allow` button = `allow_once` (matches RFC B §7).
  - The "Always" affordance for writes is **opt-in via expand**, not
    a top-level button. Surfacing it on the primary card row would
    make a tap-through user accidentally grant standing write access.
  - Audit row records `action: write` so `/approvals stats` separates
    write traffic from read.
- Onboarding card from RFC D §5 stays read-only by default. A new
  expand option `[ ✏️ Also enable writes (per-action approval) ]`
  flips the agent into write-aware mode without granting any standing
  write access.

### 4.3 Reconciler recovery event (deferred from RFC D §12) — P3

**Today:** when a doc the agent expected is in Missing state (deleted
or trashed) and the user later un-trashes it, the agent re-discovers on
next access. Fine for ad-hoc reads; means scheduled tasks ("scan my
reading list weekly") that hit a transient missing window can stay
broken for a week.

**Design:** trivial extension of `src/drive/reconciler.ts` —

- When a missing-state grant transitions back to Present on its next
  scheduled check, write a `recover` row to `approval_audit` and
  surface a `[ ↻ Re-enabled ]` line in the next staleness digest.
- No retro-active state-management. No automatic re-trigger of the
  scheduled task. Just don't *hide* the recovery from the user.

### 4.4 Second surface: Notion as the next consumer — P1, parallel with 4.1

The approval kernel (RFC B) and the onboarding pattern (RFC D §5) were
both designed for N doc surfaces, not just Drive. **Building Notion
second is the test that the framework actually generalizes.**

**Design:**

- Server choice candidate: `makenotion/notion-mcp-server` (official,
  MIT-licensed, OAuth supported). Pin a commit SHA per RFC D §2 (don't
  track a floating tag).
- Vault slot pattern mirrors Drive: `notion:<agent_unit>:refresh_token`
  and `notion:<agent_unit>:refresh_token:status` for invalid-grant
  signaling. Same revocation flow as RFC D §4.3.
- Scope grammar:
  - `doc:notion:page:<id>` — single page.
  - `doc:notion:database:<id>/**` — database (analog to a folder).
  - `doc:notion:workspace/<id>/**` — entire workspace.
- Onboarding card: same shape as RFC D §5, swapped copy:
  `[ ✅ Allow my Notion (read-only) — recommended ]` etc.
- CLI: `switchroom notion connect|disconnect <agent>`, with the same
  three-tier OAuth auto-select as Drive (device-code → OOB-paste →
  desktop-loopback). RFC D §3 is the template; copy nothing, factor
  the shared code.
- The picker from §4.1 is generalized: `switchroom <surface> folders
  <agent>` works for Drive folders and Notion databases identically.

**Refactor signal:** if landing Notion requires copy-pasting more than
~50 lines from `src/drive/*` into `src/notion/*`, stop and extract
`src/doc-connection/` first (shared OAuth tier-selection, vault-slot
pattern, onboarding card builder, picker primitive). The whole point
of building a second surface is to find the seams.

## 5. Out of scope

- **Slack messages-as-docs** — same shape, separate spec when there's
  user demand. Not blocking anything.
- **Gmail surface** — `taylorwilsdon/google_workspace_mcp` (RFC D §2)
  already supports it, but Gmail's approval shape is per-thread, not
  per-doc; warrants its own spec.
- **Local-filesystem doc indexing** (Obsidian, plain markdown trees) —
  this spec is about *external* doc surfaces. Local trees are an
  agent-workspace concern.
- **Service-account auth** — same reason as RFC D §12: collapses
  approval semantics.
- **Two-way doc sync** (treating Drive/Notion as a backing store for
  agent-state) — out. The contract is read with optional write.
- **A unified `switchroom docs ...` super-CLI** — premature
  abstraction. `drive` and `notion` as siblings is fine until there
  are 3+ surfaces.

## 6. Principle checks

Per `reference/principles.md`, applied to this spec:

### 6.1 Docs test — *"Can someone use this without opening `docs/`?"*

- ✅ `switchroom drive folders klanker` posts a card with inline
  guidance. No prerequisite reading.
- ✅ `switchroom notion connect klanker` mirrors `switchroom drive
  connect` exactly — the user who did Drive once doesn't need to
  learn anything new.
- ✅ Onboarding card text explains the trade-off ("most users pick
  Allow my workspace — one tap now") rather than naming the underlying
  scope grammar.
- ✅ Folder picker breadcrumbs make the active scope visible without a
  glossary.

### 6.2 Defaults test — *"Does it work on a fresh `switchroom setup`?"*

- ✅ Drive remains opt-in (must run `connect`); once enabled, the
  folder picker is reachable with no further config.
- ✅ Writes default to per-action approval. Standing write grants are
  available but opt-in via expand. No one accidentally grants
  klanker the ability to overwrite their `/Work` folder.
- ✅ Notion's onboarding card defaults to "Allow my workspace
  (read-only)" — the same pragmatic default as Drive.

### 6.3 Consistency test — *"Does this feel like one product?"*

- ✅ Same `apv:` callback shape across surfaces (RFC B §6.1).
- ✅ Same `<surface>:<agent_unit>:refresh_token` vault slot pattern.
- ✅ Same `switchroom <surface> connect|disconnect` CLI verb.
- ✅ Same approval card states (pristine / expanded / granted / denied
  / expired) — RFC B §8.1.
- ✅ Same `/approvals list|revoke|add|stats` surface — adding Notion
  scopes doesn't add new commands, just new rows.
- ⚠️  Risk: if §4.4's refactor signal fires, doing it *before* shipping
  Notion is a one-mind-built-this requirement, not a follow-up.

## 7. Migration / rollout

Phased so each phase is shippable on its own and the framework signal
in 4.4 can shape the rest.

1. **Phase 1 (parallel)** — Drive folder picker (§4.1) + Notion
   connect/disconnect skeleton with shared OAuth tier code (§4.4
   minimum). Validates the picker primitive on Drive while Notion
   surfaces the framework seams.
2. **Phase 2** — Notion onboarding card + scope grammar wired through
   the approval kernel. The "second consumer" milestone — if the
   kernel needs changes to fit Notion, find them now.
3. **Phase 3** — Drive writes (§4.2). Lower priority than Notion-reads
   because writes carry more risk and existing read flows are
   delivering value already.
4. **Phase 4** — Reconciler recovery event (§4.3). Cleanup once write
   flows have a few weeks of mileage.

## 8. Effort estimate

Per CLAUDE.md, in **agent minutes** (wall-clock for a current-gen
agent, end-to-end including tests):

| Phase | Item | Estimate |
|---|---|---|
| 1 | Folder picker (§4.1) — picker card + pagination + 5min cache + tests | ~45 min |
| 1 | Notion skeleton (§4.4) — CLI verb + OAuth wiring + vault slots + tests | ~60 min |
| 2 | Notion onboarding + scope grammar through kernel | ~45 min |
| 2 | Framework extraction if §4.4 refactor signal fires | ~60 min (conditional) |
| 3 | Drive writes (§4.2) — scope namespace + tools + approval defaults + tests | ~60 min |
| 4 | Reconciler recovery event (§4.3) | ~15 min |
| — | Doc updates across `docs/drive.md`, new `docs/notion.md`, RFC cross-refs | ~15 min |

**Without framework extraction: ~4 hours agent time.** With extraction:
~5 hours. Either way, this is one focused day, not an epic.

## 9. Risks and open questions

- **Notion's OAuth scopes are coarser than Drive's.** Notion grants
  per-workspace, not per-page. The "Allow my workspace" default is
  honest about this; per-page scoping is an illusion the kernel can
  enforce locally but Notion's API can't. Document this in the
  onboarding copy so users aren't surprised.
- **Write-approval fatigue.** Drive writes from a coding agent
  ("update my README") could be high-volume. Per-folder write grants
  are the safety valve; instrument via `/approvals stats` and observe
  before opening up further.
- **MCP server churn.** Notion's MCP ecosystem is younger than Drive's.
  Pin the SHA per RFC D §2; revisit at each release.
- **Picker discoverability.** A user who's been pre-granting per-doc
  needs to discover the picker exists. The new
  `[ 📁 Allow folder instead ]` button on per-doc approval cards is
  the in-flow nudge; the staleness digest's `[ 📁 Browse ]` button is
  the post-hoc one. If neither lands, surface a one-time tip after
  the third per-doc grant.
- **Surface-name confusion in copy.** Drive has "folders," Notion has
  "databases" + "pages," Slack has "channels." The picker primitive
  is generic; the copy must use surface-native nouns. No
  `switchroom docs grant <generic-thing>` super-vocab.

## 10. Tracking

Open one tracking issue per phase, all blocked on this spec landing:

- [ ] Phase 1a — Drive folder picker
- [ ] Phase 1b — Notion connect/disconnect skeleton
- [ ] Phase 2 — Notion onboarding + kernel-scope grammar
- [ ] Phase 3 — Drive writes + scope namespace
- [ ] Phase 4 — Reconciler recovery event
