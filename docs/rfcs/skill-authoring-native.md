# RFC: Native-by-default skill authoring

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-05-18
Relates: #1490 (PR A), #1491 (PR B), #1492/#1494 (the `--version`
collision that motivated this), #1163 (skill install/remove —
orthogonal, see §3.4)

## 1. Summary

Make **agent-scope** skill authoring 100% Claude-native: an agent
creates and edits its own skills with the bundled `skill-creator`
skill and ordinary `Write`/`Edit` into
`$CLAUDE_CONFIG_DIR/skills/<slug>/` — a directory that is already
persistent, reconcile-safe, and auto-discovered. Delete the
agent-scope `skill_create/edit/read/delete` MCP tools, their
`switchroom skill create|edit|read|delete` CLI verbs, the
JSON-over-stdout shim (`spawnSyncWithStdin`), and the
optimistic-concurrency version-token machinery.

Keep the privileged broker **only** where it is irreducible —
**global / cross-agent** writes the agent UID physically cannot make —
and collapse that surface from four verbs to **one**: `skill_publish`
(plus `skill_unpublish`). An admin agent authors and tests a skill
natively in agent scope, then promotes a known-good copy with one
explicit, audited, admin-gated action.

Fleet pick-up is unchanged: the `skills:` config cascade +
reconcile-managed symlinks. `skill_publish --adopt <layer>` folds the
"declare it, then reconcile" two-step into the publish call so the
operator/admin does one thing, not three.

## 2. Motivation

### 2.1 The shim is a structural fragility, not a one-off bug

#1492: `switchroom skill edit --version <token>` collided with the
root program's commander `.version()` flag. Commander's version
printer intercepted `--version`, printed `0.11.1` to stdout, exited
0 — the edit never ran, nothing landed on disk, and the MCP server's
`JSON.parse("0.11.1")` threw "Unable to parse JSON string". `skill_read`
/`skill_create` (no `--version` flag) worked, and #1491's only E2E
covered `create`, so CI stayed green over the gap.

That bug class **only exists because there is a CLI + JSON-over-stdout
shim in front of what is, for agent scope, a plain file write into the
agent's own writable directory.** Argv parsing, stdout discipline,
JSON round-tripping, version tokens, `--scope` plumbing — every one of
those is surface area that does not exist in the native model.

### 2.2 Agent scope needs none of it

Verified wiring (file:line):

- **Persistent.** `~/.switchroom/agents/<name>` is a host bind mount
  (`src/agents/compose.ts:1658`, and the same path mirrored at
  `:1661`). Writes survive `switchroom agent restart` / compose
  recreate.
- **Reconcile-safe.** `syncGlobalSkills` only ever removes symlinks it
  owns (targets inside the skills pool); a real, agent-authored
  directory is explicitly left untouched
  (`src/agents/scaffold.ts:793-795`, `:831-834`).
- **Auto-discovered.** Claude scans `$CLAUDE_CONFIG_DIR/skills/`;
  `CLAUDE_CONFIG_DIR=<agentDir>/.claude`
  (`profiles/_base/start.sh.hbs:173`) — exactly where agent-scope
  skills resolve (`src/cli/skill-common.ts:179,185,192`).
- **Writable.** It is the agent's own scaffold dir, owned by the
  per-agent container UID.

So for agent scope the four-tool shim adds **no capability** — only
audit/caps/concurrency/identity-pin *policy*, none of which require a
CLI for the agent's own persistent, reconcile-safe directory. Audit
and caps are better expressed as a non-blocking validator hook on the
native write path (§3.3).

### 2.3 The bundled authoring path has no blessed destination

`skills/skill-creator/SKILL.md` is already a bundled default
(`src/agents/reconcile-default-skills.ts`), but it is destination-
agnostic: it talks about producing a skill *directory* / `.skill`
package and even warns "direct writes may fail due to permissions —
stage in `/tmp/` first" (SKILL.md:461). Nothing tells the agent that
`$CLAUDE_CONFIG_DIR/skills/<slug>/` is the canonical, writable,
live-next-turn home. Closing *that* gap — a few lines of skill-creator
guidance plus a documented path — is the actual work for agent scope.
Not four MCP tools.

### 2.4 It fails the product principles (see §6)

The shim is a *different interaction model* from how Claude-native
skills work and from how every other switchroom extension works
(`skills:` config + reconcile). That is precisely the
"inconsistent extension shapes" anti-pattern in
`reference/extend-without-forking.md` and a Principle 3 ("one mind
built this") failure. Per the design contract, that is a redesign,
not a follow-up.

## 3. Design

### 3.1 Current (as-is)

Both scopes funnel through the same machinery:

```
agent ─> agent-config MCP ─> switchroom skill CLI ─> (broker) ─> disk
         skill_create        JSON over stdout
         skill_edit          --version optimistic-concurrency tokens
         skill_read          --scope agent|global
         skill_delete        spawnSyncWithStdin, identity-pin, caps, audit
```

| | Agent scope | Global scope |
|---|---|---|
| Store | `~/.switchroom/agents/<a>/.claude/skills/<s>/` | `~/.switchroom/skills/<s>/` (`:ro` to agents, `/skills-rw` to admins) |
| Author | 4 MCP tools + version tokens + JSON shim | same 4 tools, `scope:"global"` |
| Privilege | **none needed** (own writable dir) | **broker required** (UID can't write the `:ro` mount) |
| Pick-up | native (`$CLAUDE_CONFIG_DIR/skills/`) | `skills:` cascade → reconcile symlink → next turn |

### 3.2 Target (to-be)

**Agent scope — pure native, zero switchroom surface:**

```
agent ─> skill-creator (native) ─> Write/Edit ─> <agentDir>/.claude/skills/<s>/
                                                  persistent · reconcile-safe · discovered next turn
```

**Global scope — native authoring + ONE privileged verb:**

```
admin agent ─> skill-creator (native, AGENT scope) ─> iterate/test ─┐
                                                                     │ one explicit action
                                                                     ▼
                                       skill_publish <slug> [--adopt <layer>]
                                       (admin-gated · authorship-marker · audited · atomic)
                                                                     │
                                                                     ▼
                                       broker copies the known-good dir into
                                       ~/.switchroom/skills/<slug>/ ; refreshes
                                       .authored-by-<agent> ; (if --adopt) edits
                                       the skills: layer + triggers reconcile
```

`skill_publish` is the **only** broker-backed write. It is a
deliberate, atomic *replace-by-publish* of a complete skill directory
— no per-file edits, no version tokens, no `--from-stdin`. The agent
already iterated in its own scope; publish promotes the result.

### 3.3 Delete / keep / new

| | Item | Disposition |
|---|---|---|
| **Delete** | `skill_create/edit/read/delete` MCP tools (agent scope) | removed |
| | `switchroom skill create\|edit\|read\|delete` CLI verbs | removed |
| | `spawnSyncWithStdin`, `--from-stdin`, JSON-over-stdout author shim | removed |
| | `--version`/`--expect-version` tokens, `E_SKILL_VERSION_STALE`, version-token code | removed (the entire #1492 bug class) |
| | `--scope agent` plumbing | removed (agent scope is native) |
| | `agent-config-skill-author.test.ts`, `…author.global.test.ts`, author paths in `server.author.test.ts` | removed/rewritten for publish |
| **Keep** | The broker, reached by **one** verb (`skill_publish`/`unpublish`) | kept, narrowed |
| | Authorship marker (`authorshipMarkerName`/`hasAuthorshipMarker`, `.authored-by-<agent>`, `E_SKILL_OPERATOR_OWNED`) | kept — still the operator-curated immutability guard |
| | Validators (`validateSkillName/RelPath/SkillMd`, `safeWriteFile`, size/file caps) | kept, refactored into a shared lib used by the validator hook + `skill_publish` (no longer a CLI entrypoint) |
| | Identity-pin + cron-deny | kept, but enforced **only on `skill_publish`** (the sole privileged path) |
| | `skills:` union cascade (`src/config/merge.ts:551`), `syncGlobalSkills`, `reconcileDefaultSkills`, `_bundled` pool | kept, unchanged — the consistent extension shape |
| **New** | `skill_publish` / `skill_unpublish` MCP tools + `switchroom skill publish\|unpublish` CLI (broker path only) | new |
| | `skill_publish --adopt <defaults\|profile:X\|agent:Y>` — also edits the `skills:` layer + triggers reconcile | new (collapses the 3-step fleet-adoption into 1) |
| | Non-blocking **validator hook** (`PreToolUse` on Write/Edit under `$CLAUDE_CONFIG_DIR/skills/`) — lints frontmatter/size/path, **warns, does not block** | new |
| | `skill-creator/SKILL.md` addendum: canonical destination is `$CLAUDE_CONFIG_DIR/skills/<slug>/`, live next turn | new (few lines) |

### 3.4 Explicitly out of scope

`skill_install` / `skill_remove` (#1163 Phase 2) are **orthogonal**:
they adopt/drop a *pool* skill into an agent's declared `skills:`
list — a config edit materialised by reconcile, not authoring. They
stay as-is. (They are a candidate for a later "this is just a
`skills:` cascade edit" simplification, but not in this RFC.)

## 4. Migration / phasing

Three PRs, each through the standard reviewer → auto-merge flow.

- **Phase 1 — native agent scope (low risk, immediate UX win).**
  Document the canonical writable destination in
  `skill-creator/SKILL.md`; add the non-blocking validator hook; mark
  the four agent-scope tools **deprecated** in their MCP descriptions
  (still functional). No deletions yet. Ships the entire agent-scope
  benefit with zero capability loss.
- **Phase 2 — collapse global.** Ship `skill_publish`/`skill_unpublish`
  + `--adopt`. Migrate global authoring off `create/edit/delete`.
  Remove `--scope` from the deprecated tools (agent-only now).
- **Phase 3 — delete.** Remove the four author tools, their CLI verbs,
  `spawnSyncWithStdin`, the version-token code, the now-dead tests;
  refactor validators into the shared lib; update `docs/skills.md` and
  the CLI reference.

Rollback: Phase 1 is additive (revert = drop the hook + doc lines).
Phases 2–3 revert by restoring the deleted files from git; no on-disk
data migration (skills are plain dirs, unchanged in place).

## 5. Alternatives considered

1. **Keep four tools, just fix bugs as they appear.** Rejected: the
   fragility is structural (argv/stdout/JSON/version surface), and it
   permanently fails Principle 3. #1492 is the second flag-class bug
   in this surface in a week.
2. **Thin local validator CLI for agent-scope writes (no broker, no
   JSON).** Rejected: still a non-native interaction model the agent
   must learn and drive. The `PreToolUse` hook delivers the same
   validation with zero new surface (native Claude users already
   live with hooks).
3. **Auto-propagate a published global skill to the whole fleet
   (skip the `skills:` declare step).** Rejected: breaks the
   opt-in safety gate (a confused/compromised admin agent could push
   a skill every agent loads at boot) and the cascade-consistency
   story. The declare+reconcile gate is deliberate;
   `--adopt` makes it ergonomic without removing it.
4. **Per-file `skill_publish` with version tokens (port the old
   model).** Rejected: reintroduces the exact concurrency/argv surface
   we are deleting. Replace-by-publish of a whole, already-iterated
   directory is simpler and matches "the agent tested it in its own
   scope first".

## 6. Design-contract checks

**JTBD — `reference/extend-without-forking.md`:** "New skills plug
into existing agents without editing those agents… Consistent
extension shapes." Target collapses skill authoring onto the same
shape as every other extension (native files + `skills:` cascade +
reconcile). Removes the inconsistent-extension-shape anti-pattern.

**Principle 1 — "if they need the docs, we've failed":** Today an
agent must know a four-tool MCP protocol with opaque version tokens to
author a skill. Target: it uses the bundled `skill-creator` skill the
way any Claude user does; the validator hook's message tells it what
to fix. ✅ after redesign.

**Principle 2 — "batteries included, assembly optional":**
`skill-creator` is already a bundled default; the only missing battery
is a blessed writable destination, which Phase 1 supplies. Global
publish is one verb with a sane default (`--adopt` optional). ✅

**Principle 3 — "one mind built this":** Removes a bespoke
interaction model; global pick-up rides the existing `skills:` cascade
+ reconcile (same mental model as profiles, tools, memory). One
privileged verb shaped like `switchroom <noun> <verb>`. ✅

Verdict per the contract's rule: advances the **multi-agent fleet**
and **subscription-honest / no custom runtime** outcomes, satisfies
the extend-without-forking JTBD, and passes all three principle checks
*after* the redesign — which is exactly why it is a redesign and not a
patch.

## 7. Open questions

1. **Validator hook: warn vs. block?** Lean **warn** — native Claude
   doesn't block skill writes, and Principle 3's "let the model
   communicate" sub-principle argues against a hard gate. Hard cap
   only the one thing with a real blast radius (total skill bytes), as
   a hook-level reject with a clear message.
2. **`skill_publish` dry-run/diff.** Probably yes — mirror
   `switchroom update --check`: `skill_publish --check` prints what
   would change in the pool (new/overwrite, marker state) without
   writing. Consistency with the existing `--check` idiom.
3. **`--adopt agent:Y` is a cross-agent config edit.** Should it go
   through the approval-kernel like other cross-agent/admin ops, or is
   admin-gating on `skill_publish` sufficient? Tentative: align with
   the hostd/kernel "admin privilege kept, gated by human approval for
   cross-agent blast radius" posture.
4. **Discovery latency.** A natively authored skill is live on the
   *next* turn (Claude scans at session boot), not mid-turn. Same is
   true today via the CLI. Acceptable, but the skill-creator addendum
   must say so explicitly so the agent doesn't report success then act
   confused when it can't invoke the skill in the same turn.
5. **`skill_unpublish` and the marker.** Unpublish must refuse when
   the `.authored-by-<agent>` marker is absent (operator-curated /
   peer-authored) — same guard as the old `skill_delete scope:global`.
   Confirm no path lets `--adopt`'s reconcile resurrect a just-
   unpublished skill from a stale `skills:` entry.

## 8. Verdict / next steps

Recommend proceeding with **Phase 1 now** (native agent scope: doc +
hook + deprecation flag) — it is low-risk, additive, reversible, and
delivers the whole agent-scope UX win immediately. Phases 2–3 follow
as separate PRs once the `skill_publish` contract in §3.2 and open
questions 2–3 are nailed down.
