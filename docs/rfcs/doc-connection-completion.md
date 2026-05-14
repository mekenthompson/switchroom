# RFC E: Make Google Drive a real collaboration surface

Status: Draft v2
Author: Ken (with Claude pair-design)
Date: 2026-05-14

Prerequisites — both shipped:
- **RFC B — Approval kernel** (`approval-kernel.md`) — landed v0.6.0 (#762).
- **RFC D — Google Drive MCP integration** (`gdrive-mcp.md`) — landed v0.6.0 (#763, #766, #767, #768).

This spec finishes the Google Drive integration so it stops being a
read-only data fetcher and becomes a proper place to **collaborate
with the agent on docs**. Drive is the focused surface; Notion and
the other doc sources are explicitly deferred to a follow-up spec
once the Drive collab loop is real.

## 0. Goal

A user can give an agent a Google Doc, ask it to draft into the doc,
review the agent's changes inline in Drive, and resume the
conversation in Telegram — all without leaving the
phone-or-laptop-they-already-have-open. The agent is a collaborator
on the user's docs, not a one-shot reader-and-summarizer.

## 1. Outcome

The user can do this end-to-end from a Telegram thread on a phone:

```
User:   "Klanker, take the meeting notes from /Work/2026/Q3 and
         draft a hiring section into the Q3 Strategy doc."

Agent:  [posts approval card]
        🔐 klanker wants to read 4 docs in /Work/2026/Q3
        "Q3 Strategy Notes", "Hiring plan", "+2 more"
        [ ✅ Allow this folder ]  [ See all ]  [ 🚫 Deny ]

User:   [taps Allow this folder]

Agent:  "Read 4 docs. Drafting a Hiring section into Q3 Strategy
         Notes — will post a preview in a sec."

Agent:  [posts write-approval card]
        ✏️  klanker wants to add to "Q3 Strategy Notes"
        +47 lines · "Added Hiring section after 'Goals'"
        [ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
        [ ⚠ Apply directly ]  [ 🚫 Cancel ]

User:   [taps Apply as suggestion]

Agent:  "Done — open https://docs.google.com/document/d/.../edit
         to review. I'll wait."

User:   [opens link in Drive app, reviews, accepts the suggestion,
         comes back to Telegram]
        "Looks good, can you tighten the second paragraph?"

Agent:  [posts write-approval card with new diff]
        ...
```

Today this loop is impossible. The agent can read the doc but can't
write back, can't propose changes the user can review in Drive's UI,
can't link the user back to the doc from chat, and the folder-grant
step requires the user to type a scope string. Every one of those
gaps blocks the collaboration JTBD.

## 2. Vision alignment

Maps to three of the four outcomes in `reference/vision.md`:

- **Multi-agent fleet (#2)** — Specialists become specific *because*
  they have a real working relationship with the user's docs. A
  research agent that can draft into your reading-notes is a
  research agent; one that can only read is a search box.
- **Subscription-honest (#3)** — Per-user OAuth, refresh tokens in
  vault, no service accounts. Same posture as RFC D §4.
- **Always-on (#4)** — Refresh tokens survive reboots; the
  reconciler's missing→present recovery (§4.4) means a doc the user
  un-trashes mid-week doesn't leave the agent stuck.

Visibility (#1) is served by the existing approval card UX from RFC
D plus the new diff-preview surface in §4.2 — the user always sees
what the agent is about to do *before* it touches their doc.

## 3. JTBD alignment

- **`extend-without-forking.md`** — Granting an agent access to a
  new folder is a tap, not a code change. Per-folder write grants
  are a config-surface affordance, not an MCP-server fork.
- **`share-auth-across-the-fleet.md`** — Drive OAuth = once per
  Google account. Adding a second agent that needs the same Drive
  doesn't re-prompt; the cascade resolves the shared vault slot.
- **`talk-to-agents-from-anywhere.md`** — Folder browsing, write
  approvals with diff preview, deep-link to Drive, reconnect-on-
  token-revocation — every step is reachable from a phone. The
  headless OAuth tier from RFC D §3.2 covers initial connect;
  nothing else needs a desktop browser.
- **`know-what-my-agent-is-doing.md`** — The diff-preview-before-
  write pattern is the JTBD's "see every step" applied to mutations.
  The user never finds out the agent edited a doc by re-opening it
  later.

## 4. Scope — five pieces, all Drive

### 4.1 Folder picker (deferred from RFC D §6) — Phase 1

**Today:** per-doc grant works fine; folder grants require typing
`doc:gdrive:folder/<id>/**` by hand. RFC D §6 acknowledged this is
worse than either default and explicitly punted.

**Design:**

- New CLI verb: `switchroom drive folders <agent>` — does *not*
  render in the terminal. Posts a card in the agent's Telegram
  topic.
- Card surface: paginated folder list, top-level first, breadcrumb
  on long names. One tap on a folder = expand into its children +
  back arrow. One tap on `[ ✅ Allow this folder ]` = write
  `allow_always` at `doc:gdrive:folder/<id>/**` and surface the
  standard granted-card confirmation (with `· /approvals revoke
  <id>` inline per RFC B §9).
- The same picker is reachable from inside an in-flight per-doc
  approval card via a new `[ 📁 Allow folder instead ]` button —
  the primary mitigation for the prompt-flood path RFC D §5 warns
  about.
- Listing source: `files.list` with
  `q="mimeType='application/vnd.google-apps.folder' and 'me' in
  owners and trashed=false"`, paginated 50 per card. Cached for 5
  min per agent.
- Staleness digest from RFC B §9.1 also gets a `[ 📁 Browse ]`
  button next to each folder grant so the user can audit before
  keeping.

**Pagination is not optional.** Drive accounts with deep folder
trees (>100 top-level folders) are common. Ship paginated on day 1.

### 4.2 Write operations with Suggesting as the default (deferred from RFC D §12) — Phase 1

**Today:** read-only by design. RFC D §12 stipulates writes need
their own scope namespace so a read grant never silently authorizes
a write.

**Why "Suggesting" is the default, not direct write:** Drive has a
first-class Suggesting mode (the same one human collaborators use).
Suggestions are non-destructive — the user reviews and accepts them
in Drive's UI just like a peer's edit. **Defaulting to Suggesting
mode is the difference between "agent writes to my doc" (scary) and
"agent proposes edits I review" (collaboration).** Direct writes
remain available behind a one-extra-tap affordance for cases where
suggesting doesn't fit (creating a brand-new doc, scripted bulk
edits, etc.).

**Design:**

- New scope namespaces (read scopes unchanged):
  - `doc:gdrive:suggest:<id>` and `doc:gdrive:suggest:folder/<id>/**`
    — non-destructive proposals.
  - `doc:gdrive:write:<id>` and `doc:gdrive:write:folder/<id>/**`
    — direct writes.
- A `suggest` grant does NOT imply `write`. `write` implies
  `suggest`.
- MCP wrapper exposes:
  - `gdrive_suggest_edit(doc_id, anchor, text)` — primary edit
    tool.
  - `gdrive_create_doc(title, content, parent_folder)` — new docs
    only; uses `write` scope on the parent folder.
  - `gdrive_apply_edit(doc_id, anchor, text)` — direct write; uses
    `write` scope.
  - `gdrive_append_to_doc(doc_id, text)` — append; uses `write` (no
    Suggesting equivalent in the API for pure append).
- Approval card for a suggestion edit:
  ```
  ✏️ klanker wants to add to "Q3 Strategy Notes"
  +47 lines · "Added Hiring section after 'Goals'"
  [ 📖 Open in Drive ]  [ ✅ Apply as suggestion ]
  [ ⚠ Apply directly ]  [ 🚫 Cancel ]
  ```
  - Primary action is **Apply as suggestion** — single tap, lands
    as a Drive Suggestion the user reviews in Drive's UI.
  - **Apply directly** is a secondary, badged with `⚠`. Standing
    direct-write grants are opt-in via expand only — never on the
    primary card row.
  - **Open in Drive** is always present. See §4.3.
- Diff summary (`+47 lines · "..."`) is best-effort: render
  line-counts always, render the agent-supplied "what changed"
  string if present (the agent passes a `summary` param to the
  suggest tool).
- Audit row records `action: suggest` or `action: write` so
  `/approvals stats` separates collaboration traffic from outright
  writes.
- The §5 onboarding card from RFC D gains a new expand option:
  `[ ✏️ Also enable suggesting (per-action approval) ]`. This flips
  the agent into write-aware mode without granting any standing
  edit access. Direct writes remain a deeper, expand-only choice.

### 4.3 Open-in-Drive deep links — Phase 1

**Today:** every reference to a doc in chat is a title; the user
has to find the doc themselves to look at it. Breaks the collab
loop — the user can't tap from "agent edited X" to "let me see X."

**Design:**

- Every approval card that names a doc renders the title as a
  `[ 📖 Open in Drive ]` inline-keyboard button that opens
  `https://docs.google.com/document/d/<id>/edit` (or the
  spreadsheet/presentation equivalent based on `mimeType`).
- Granted-card confirmations (RFC B §8.1) gain the same button so
  the user can jump straight from "agent has access" to the doc
  itself.
- Suggestion-write approvals (§4.2) also include
  `?disco=<thread_id>` on the URL when Drive's API exposes a
  discussion thread for the proposed edit, so the link lands the
  user directly on the suggestion they're reviewing.
- No new permission needed — these are the same shareable URLs the
  user would copy from Drive's "Share" dialog.

### 4.4 Reconciler missing→present recovery (deferred from RFC D §12) — Phase 1

**Today:** when a doc is in Missing state (deleted/trashed) and the
user later un-trashes it, the agent re-discovers on next access.
Fine for ad-hoc reads; means scheduled tasks ("scan my reading list
weekly") that hit a transient missing window stay broken for a
week even after the user fixes it.

**Why it's promoted from "Phase 4 cleanup" to Phase 1:** in a
collab loop the missing→present transition is *common*. The user
trashes their draft, asks the agent to start over, un-trashes the
original to compare — they expect both versions to be live for the
agent.

**Design:** trivial extension of `src/drive/reconciler.ts` —

- When a missing-state grant transitions back to Present on its
  next scheduled check, write a `recover` row to `approval_audit`
  and surface a `[ ↻ Re-enabled ]` line in the next staleness
  digest + a one-line nudge in the agent's chat:
  *"↻ 'Q3 Strategy Notes' is back — let me know if you want me to
  pick up where I left off."*
- No retro-active state-management. No automatic re-trigger of the
  scheduled task. Just don't *hide* the recovery from the user.

### 4.5 Section-anchor editing primitive — Phase 1

The `gdrive_suggest_edit(doc_id, anchor, text)` tool from §4.2
needs an anchor model that's robust enough for an agent to use.
Naive "insert after byte offset N" breaks the moment the doc
shifts.

**Design:**

- Anchors are **heading-based**, not byte-offset-based. The agent
  passes `anchor: { after_heading: "Goals", level: 2 }` or
  `anchor: { append_to_section: "Hiring", level: 2 }`.
- The wrapper resolves anchors against the current doc state at
  edit-time (via `documents.get` → walk the structural tree).
- If the anchor doesn't resolve (heading was renamed, deleted),
  the edit is rejected at the wrapper layer with a clear error
  the agent surfaces back: *"⚠ Couldn't find heading 'Goals' in
  current doc. Want me to suggest a heading-by-heading rewrite,
  or pick a different anchor?"*
- For docs with no headings, the wrapper falls back to two anchor
  modes: `at_start`, `at_end`. No silent guess at byte offsets.

## 5. Out of scope (this spec)

- **Notion / Slack / Gmail** — deferred to RFC F. The Drive collab
  loop has to land first as proof that the picker + write +
  deep-link + reconciler-recovery model is real before we
  generalize.
- **Drive Sheets / Slides as first-class collaboration surfaces** —
  reads work today via the same MCP; suggesting/writing into Sheets
  cells and Slides components is its own UX problem (cell anchors,
  slide layouts) and warrants its own spec.
- **Track-changes / blame** — the user reviews suggestions in
  Drive's own UI, which already has these; switchroom doesn't
  reinvent them.
- **Agent-initiated comments / @-mentions on Drive comments** —
  separate from the edit loop; would need its own approval shape.
- **Local-filesystem doc indexing** — agent-workspace concern, not
  external-surface concern.
- **Service-account auth** — same reason as RFC D §12: collapses
  approval semantics.
- **Two-way doc sync** (treating Drive as a backing store for
  agent-state) — out. The contract is the user owns the doc; the
  agent collaborates on it.

## 6. Principle checks

Per `reference/principles.md`, applied to this spec:

### 6.1 Docs test — *"Can someone use this without opening `docs/`?"*

- ✅ `switchroom drive folders klanker` posts a card with inline
  guidance. No prerequisite reading.
- ✅ Approval card copy explains the suggestion vs direct-write
  trade-off in one line — no glossary needed.
- ✅ `[ 📖 Open in Drive ]` is self-explanatory. Tap → doc opens.
- ✅ Anchor-resolution errors give the user a next step
  (*"Want me to suggest a heading-by-heading rewrite?"*).

### 6.2 Defaults test — *"Does it work on a fresh `switchroom setup`?"*

- ✅ Drive remains opt-in (must run `connect`); once connected,
  the picker and Open-in-Drive surfaces are reachable with zero
  further config.
- ✅ Writes default to Suggesting mode. The single most dangerous
  affordance (standing direct-write grants) is opt-in via expand,
  not surfaced as a primary button.
- ✅ Anchor model defaults to heading-based (the only model that
  survives doc evolution). No setting to choose.

### 6.3 Consistency test — *"Does this feel like one product?"*

- ✅ Same `apv:` callback shape across reads, suggests, writes
  (RFC B §6.1).
- ✅ Same `vault:gdrive:*` slot pattern (no new vault concepts).
- ✅ Same approval card states (pristine / expanded / granted /
  denied / expired) — RFC B §8.1.
- ✅ Same `/approvals list|revoke|add|stats` surface — adding
  `suggest` and `write` action types adds rows, not commands.
- ✅ Same headed-doc model the user already lives in for any Drive
  doc; agent anchors mean what they look like they mean.

## 7. Migration / rollout

All five pieces are scoped as **Phase 1 — Drive collab experience**.
Substructure for sequencing within the phase:

1. **1a — Folder picker (§4.1) + Open-in-Drive (§4.3).** The
   lowest-risk pair; folder picker is contained UX, Open-in-Drive
   is additive. Ships independently of writes.
2. **1b — Anchor primitive (§4.5).** Foundation for §4.2; ship +
   test in isolation against a fixture doc before wiring it to the
   approval card.
3. **1c — Suggesting writes + diff preview (§4.2).** The headline
   feature. Lands on top of the anchor primitive and the
   Open-in-Drive button.
4. **1d — Reconciler recovery (§4.4).** Lowest-effort, ships last
   — useful but not blocking the headline collab loop.

Phase 2+ (Notion as second surface, framework extraction, broader
doc surfaces) lives in a follow-up RFC and is explicitly out of
scope here. Doing Drive collab first means RFC F (whenever it
lands) has a real working model to copy from instead of a designed
abstraction.

## 8. Effort estimate

Per CLAUDE.md, in **agent minutes** (wall-clock for a current-gen
agent, end-to-end including tests):

| Sub-phase | Item | Estimate |
|---|---|---|
| 1a | Folder picker (§4.1) — picker card + pagination + 5min cache + tests | ~45 min |
| 1a | Open-in-Drive deep links (§4.3) — wired into approval cards + grant confirmations + tests | ~20 min |
| 1b | Anchor primitive (§4.5) — heading resolver + fallback modes + tests | ~45 min |
| 1c | Suggesting writes + diff preview (§4.2) — scope namespaces + MCP tools + approval defaults + tests | ~75 min |
| 1d | Reconciler recovery (§4.4) — recover event + digest line + chat nudge | ~25 min |
| — | Doc updates (`docs/drive.md`, RFC cross-refs) | ~20 min |

**~3.75 hours agent time** for the full Phase 1. One focused day,
shippable as four PRs (1a, 1b, 1c, 1d) for incremental review.

## 9. Risks and open questions

- **Drive's Suggestions API has gaps.** Some operations (creating
  a doc, pure append) have no Suggesting equivalent — those stay
  on the direct `write` scope. Document this clearly in the agent-
  facing tool descriptions so the agent picks the right tool.
- **Anchor robustness vs agent ergonomics.** Heading-based anchors
  are robust against doc evolution but require docs to actually
  have headings. For unheaded docs the fallback is `at_start` /
  `at_end` only — agents working on unstructured notes will need
  to add structure first or accept end-append as the only option.
  Document this expectation in the prompt-pack for any agent that
  uses Drive writes.
- **Diff preview accuracy.** The "+47 lines · summary" preview is
  agent-supplied. A misbehaving agent could under-state the diff
  to pass approval. Mitigation: line-count comes from the wrapper
  (not the agent), only the summary string is agent-supplied.
  Audit row stores both for post-hoc review.
- **Folder picker cache invalidation.** 5-min cache is right for
  most users but wrong for someone reorganizing their Drive in the
  same window. Add a `[ ↻ Refresh ]` affordance on the picker card
  that bypasses cache. Cheap.
- **Open-in-Drive auth assumption.** The deep-link assumes the
  user is logged into Google in their browser/app on the device
  they tap from. If they're not, Drive's own login flow handles it
  — not our problem, but the link doesn't pre-validate.
- **Discoverability of Suggesting vs Write.** A user who taps
  `Apply directly` once might not realise Suggesting was the safer
  default. After 3 direct-applies in a 24h window, surface a
  one-time tip: *"You're approving direct writes a lot — want to
  set 'always suggest' as the default for this doc?"*

## 10. Tracking

Open one tracking issue per sub-phase, all blocked on this spec
landing:

- [ ] Phase 1a — Folder picker + Open-in-Drive deep links
- [ ] Phase 1b — Section-anchor editing primitive
- [ ] Phase 1c — Suggesting writes + diff preview
- [ ] Phase 1d — Reconciler missing→present recovery
- [ ] **RFC F (separate)** — Second doc surface (Notion candidate)
  + framework extraction once Drive collab is real.
