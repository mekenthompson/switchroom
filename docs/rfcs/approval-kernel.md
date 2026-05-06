# RFC: Unified human-approval kernel

Status: Draft v2
Author: klanker (sub-agent draft)
Date: 2026-05-06

## 1. Summary

Today switchroom asks the user to approve sensitive actions through at least four independent code paths, each with its own callback grammar, storage, and UX. This RFC proposes a single approval kernel — folded into the existing **vault broker** — that all current and future surfaces (secrets, vault grants, tool/skill permission requests, Google Docs and other MCPs) plug into. One process, one socket, one ACL surface, one SQLite file, one audit log, one Telegram card primitive.

The kernel is shaped on the existing `vault-broker` trust model and reuses its proven SO_PEERCRED + cgroup-derived unit identity (with the systemd cross-check that already exists at `src/vault/broker/peercred.ts:254`).

## 2. Motivation

Four approval-shaped surfaces exist today:

- **Deferred-secret cards** with `vd:unlock|cancel` callbacks — `telegram-plugin/gateway/gateway.ts:5497`.
- **Vault grants** via the `/vault grant` wizard, persisted to SQLite at `~/.switchroom/vault-grants.db` — table `vault_grants` defined at `src/vault/grants.ts:61`.
- **Tool/Skill permission requests** via MCP `notifications/claude/channel/permission_request`, rendered as `perm:allow|deny|always` cards — `telegram-plugin/gateway/gateway.ts:1938` (card text) and `:1946-1957` (keyboard).
- **Operator and dashboard prompts** under the `op:` and `auth:` callback prefixes — `telegram-plugin/gateway/gateway.ts:8179`.

Adding a Google Docs MCP — and the inevitable Notion, Slack, and Gmail wrappers after it — means a fifth, sixth, and seventh surface unless the approval shape is unified. Each new surface duplicates: callback parser, storage decision (memory vs disk), TTL semantics, revocation command, audit trail. The cost compounds; the user sees inconsistent UX; there is no single `/revoke-all` killswitch.

## 3. Threat model and trust root

Switchroom is a **1:1 bot ↔ user** product. A single allowlisted Telegram `user_id` is identity, approver, and audit subject. This is a load-bearing assumption — the kernel relies on it. If group or multi-user bots ever ship, an `approvers` subset of `allowFrom` plus DM-only delivery of approval cards must be added; flagged here so future readers know what to revisit.

Telegram (with 2FA) is the auth factor. Inbound `callback_query.from.id` is authenticated by Telegram's bot session and cannot be spoofed remotely.

**Local threat surface.** All switchroom processes — gateway, agents, brokers — run as the same uid (`kenthompson`) under `systemd --user`. Filesystem permissions are *not* a security boundary between gateway and an agent. Three concrete attacks the kernel must defend against:

1. **Bot token theft.** An agent that can read the bot token from disk can post fake approval cards as the bot and intercept the user's tap. The kernel's whole trust chain collapses. Phase 0 below moves the token into the vault.
2. **Cgroup spoofing.** Under cgroup v2 user delegation, a same-uid attacker can `mkdir` a fake cgroup path that looks like `switchroom-klanker.service` and move its own pid into it. `/proc/<pid>/cgroup` then reports the spoofed name. Documented at `src/vault/broker/peercred.ts:240-245`. Mitigation: `verifySystemdUnit` (`peercred.ts:254`) cross-checks every peercred result against `systemctl --user show`. **The kernel must call this on every request, not just at startup.** Without it, peercred is attacker-controlled input.
3. **Direct DB writes.** Any agent can `sqlite3` open `vault-grants.db` and `INSERT` a forged grant row, bypassing the broker entirely. Mitigation in §5.

Authorization happens at the IPC seam, never at the filesystem layer.

## 4. Design — fold into the vault broker

The kernel does **not** stand up a parallel broker. Approvals live as new tables in the existing `vault-grants.db` (renamed to `vault.db` to reflect broader scope; the file path rename ships with a one-time migration). The existing vault broker at `src/vault/broker/server.ts` grows new RPC methods:

- `requestApproval({ scope, why, ttl_hint })` → returns `{ status: 'pending', request_id }` immediately, then long-polls (see §10).
- `lookupDecision({ scope })` → checks for a live grant (allow_always / allow_ttl with revoked_at IS NULL).
- `recordDecision({ request_id, mode, ttl })` → invoked by the gateway when the user taps.
- `revoke({ id, reason })` and `listForUser({ user_id })`.

**Why fold rather than fork.** The vault broker already owns: SO_PEERCRED authentication (`peercred.ts`), the systemd cross-check (`peercred.ts:254`), per-unit ACL enforcement (`src/vault/broker/acl.ts`), an audited DB handle, and a battle-tested IPC protocol. Standing up a sibling broker means duplicating all of it and maintaining two ACL surfaces that can drift. One process, one socket, one trust seam.

**Effort impact.** Estimate drops from the v1 draft's "~2 days for kernel + storage" to **~1 day**, since the IPC, auth, and DB plumbing are all in place.

### 4.1 Peercred regex must be broadened

`peercred.ts:223` currently matches **only** cron units:

```
/^switchroom-[a-zA-Z0-9_-]+-cron-\d+\.service$/
```

Long-running agent units (`switchroom-klanker.service`) are not matched and would fail the kernel's auth check. Replace with:

```
/^switchroom-[a-zA-Z0-9_-]+(-cron-\d+)?\.service$/
```

and (critical) **route every approval RPC through `verifySystemdUnit`**. Without verifySystemdUnit a same-uid attacker bypasses the broker via cgroup mkdir; the regex change alone is unsafe.

## 5. Decision storage

New tables in `vault.db`:

```sql
CREATE TABLE approval_decisions (
  id              TEXT PRIMARY KEY,    -- UUID v4 (durable identifier)
  agent_unit      TEXT NOT NULL,       -- systemd unit name, verified via peercred + systemd
  scope           TEXT NOT NULL,       -- see §6
  decision        TEXT NOT NULL,       -- allow_once | allow_always | allow_ttl | deny | deny_perm
  ttl_expires_at  INTEGER,             -- unix-ms, NULL for non-ttl
  last_used_at    INTEGER,             -- for sliding-window TTL + staleness digest
  granted_by_user_id INTEGER NOT NULL, -- Telegram user_id
  granted_at_allowfrom TEXT NOT NULL,  -- JSON array, sorted; for config-drift check
  granted_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  revoke_reason   TEXT,
  hmac            BLOB NOT NULL        -- see below
);

CREATE TABLE approval_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  agent_unit      TEXT NOT NULL,
  scope           TEXT NOT NULL,
  action          TEXT NOT NULL,       -- request | grant | deny | revoke | timeout | match | drift_revoke
  decision_id     TEXT,
  request_context TEXT,                -- JSON: why-string, caller frame, request_id
  hmac            BLOB NOT NULL
);
```

UUID is the durable primary key. The 8-hex callback token (matching existing `generateAskId` at `telegram-plugin/ask-user.ts:133`) is mapped to the UUID only for the prompt's lifetime, then discarded. This avoids historical-collision risk while keeping callback_data inside Telegram's 64-byte budget.

### 5.1 SQLite same-uid write protection (HMAC every row)

A same-uid agent can open the DB directly and `INSERT` a forged grant. Defense:

- The broker generates a random 32-byte **row-integrity key** at vault unlock and holds it in memory only.
- Every `approval_decisions` and `approval_audit` row carries an HMAC-SHA256 over its concatenated columns.
- Read path verifies HMAC before honoring a row. Mismatch → row is treated as not-present, an `audit` row is written for the tampering attempt, and an operator alert fires.

Future hardening: `BindPaths=` / per-agent user-namespace isolation so the DB file isn't visible to agent units at all. Not required for v1; HMAC closes the immediate hole.

### 5.2 Config-drift auto-revocation

A grant recorded when `allowFrom = ["U1"]` must not silently extend if `allowFrom` later becomes `["U1", "U2"]`. At every `lookupDecision`:

- Re-read current `allowFrom` from access config.
- If `granted_at_allowfrom != current sorted allowFrom`, treat as auto-revoked: write `drift_revoke` to audit, return no-grant, force re-prompt under the new approver set.
- If the current set has more than one approver, all standing grants are dormant until the operator re-confirms each one (one-tap re-approve).

Drift is logged loudly. This goes in §7 (decision modes) and §11 (risks).

### 5.3 Revocation propagation

Every grant lookup re-reads `revoked_at` from disk at use time. **No caching across calls.** Spec'd here so it cannot be optimized away later.

## 6. Scope grammar

Pluggable per surface. Each consumer registers a namespace and a matcher. The interface:

```ts
interface ScopeMatcher {
  namespace: string                     // 'secret' | 'tool' | 'doc' | 'mcp'
  matches(grant: string, request: string): boolean
  humanize(scope: string): Promise<string>  // for card display, async (may resolve doc titles)
}
```

Existing precedent: `checkEntryScope` in `src/vault/broker/acl.ts` already implements scope matching for vault entries. Reuse the pattern.

Namespaces:

- `secret:OPENAI_*` — env-name glob.
- `tool:bash:rm *` — tool name + arg pattern. **Bash-arg matching is non-trivial**: the existing implementation in `telegram-plugin/permission-rule.ts` is 133 lines wrestling with quoting, globs, and option flags. Phase 4 inherits all that complexity.
- `tool:Skill:deploy` — Skill invocations.
- `doc:gdrive:1abc...xyz` — specific Drive doc id.
- `doc:gdrive:folder/789/**` — folder glob.
- `mcp:notion:page:...`

### 6.1 Callback wire format

Telegram callback_data is hard-capped at 64 bytes including the existing `agent:` prefix injected by the bridge. Scopes will not fit. Wire format:

```
apv:<8-hex request id>:<action>[:<param>]:<5-char base32 nonce>
```

- 8-hex request id matches `generateAskId` convention.
- 5-char base32 nonce is **server-generated, single-use, deleted on first tap** — replay defense. A re-tap of an old card payload is rejected with "this prompt expired."
- Examples: `apv:a3f1b9c2:allow:k7m2x`, `apv:a3f1b9c2:ttl:1h:k7m2x`, `apv:a3f1b9c2:deny:k7m2x`.

Full scope and `humanize()` output are stored server-side keyed by request id.

## 7. Decision modes

Universal across surfaces:

- `allow_once` — single use, consumed on first match.
- `allow_always` — standing grant, no expiry. Subject to drift-revocation (§5.2).
- `allow_ttl` — bounded grant, **sliding window**: the TTL extends on each successful use (sudo / 1Password pattern). Default TTL is 1h; user can override via expand.
- `deny` — single-shot reject.
- `deny_perm` — standing reject; future requests auto-fail without re-prompting.

The card surfaces only the common subset (see §8). The full mode set is editable post-grant via `/approvals`.

## 8. Telegram approval card UX

One shape, every surface. Built on the existing `aq:` (ask_user) primitive at `telegram-plugin/gateway/gateway.ts:8209` — that path already handles topic routing, quote-reply targeting, reaction-lifecycle, and `allowFrom` enforcement. The kernel registers a new `apv:` callback handler and reuses everything else.

### 8.1 Card states

**Pristine** (initial render):

```
🔐 klanker wants to read a doc
"Q3 Strategy Notes"     ← humanized via doc-title resolver
[ See more ]   [ ✅ Allow ]   [ 🚫 Deny ]
[ 🔁 Always ]  [ ⏱ For 1h ]
```

The primary row is `Allow` / `Deny`. Secondary row offers `Always` (only when scope is rule-synthesizable — same gating as the existing `resolveAlwaysAllowRule` check at `gateway.ts:1955`) and `For 1h` (single TTL default, NOT a picker — picker hidden behind expand).

**Expanded** (after `See more`):

- Call-site context: `tool:bash:rm` shows the file/line; `mcp:gdrive` shows the path/query.
- Raw scope string for verification: `doc:gdrive:1abcDEFxyz789`.
- Agent-supplied "Why this access?" line.
- TTL picker (`1h` / `24h` / `7d`), `Deny permanent`, custom mode.

**Granted (in place):**

```
✅ Granted once · /approvals revoke a3f1b9c2
```

**Granted always:**

```
✅ Granted always to klanker for doc:gdrive:1abcDEFxyz789
   /approvals revoke a3f1b9c2
```

**Denied:** `🚫 Denied`

**Expired:** `⌛ Expired — agent must re-request` (after the 5-minute prompt timeout — see §11).

**Revoked-after-grant:** on the next use attempt the agent gets a denial; the kernel posts a fresh notification card identifying which standing grant fired the denial and offering one-tap reinstate.

### 8.2 humanize() and fallback

The kernel calls the namespace's `humanize()` before rendering. For `doc:gdrive:1abc...`, the gdrive matcher fetches the doc title via the cached MCP handle. On failure, the card falls back to the raw scope with a `(could not resolve title)` annotation rather than blocking.

### 8.3 Preserved patterns (must not regress through migration)

- **`perm:more` expand button** at `gateway.ts:1946` — the See-more pattern is the basis of the new card's expand. Keep the same UX shape.
- **`summarizeToolForTitle` lift-to-title** at `gateway.ts:1938` (import at `:269`) — preserve the most-identifying-field-into-title pattern. The new card uses the same helper for `tool:` scopes.
- **`vd:unlock` deferred-secret card flow** at `gateway.ts:5497` — Phase 2 migrates this surface; the inline-passphrase capture step must survive the move.
- **`aq:` topic-routing + reaction lifecycle** at `gateway.ts:8209` — inherit, do not rebuild.
- **`allowFrom` enforcement on every callback** — pattern at `gateway.ts:8218-8222`.

## 8a. First-run onboarding for new MCPs

When a new MCP wrapper is enabled, the kernel posts a one-time setup card before the first per-resource prompt fires. Avoids the "grant once, then widen via /approvals" anti-pattern where users grant a narrow scope under prompt fatigue and never broaden it.

```
🆕 Google Drive enabled. How should klanker access your Drive?

[ Allow all of Drive (less secure, fewer prompts) ]
[ Choose folders now ]                       ← v1: links to /approvals add
[ Per-doc approval (default, more secure)    ]
```

`Choose folders now` in v1 routes to `/approvals add` with a pre-filled folder-glob template. The folder picker UI is future work.

## 9. Audit, revocation, staleness

- `/approvals list` — standing decisions **grouped by agent first**, then surface (`klanker → secret:* → ...`, `klanker → doc:gdrive:* → ...`). User mental model is "what can klanker do?", not "what tool grants exist?". GitHub-style permissions UI is the reference.
- `/approvals revoke <id>` — single revoke; logs to `approval_audit`. **Every grant card's confirmation message includes `· /approvals revoke <id>` inline** so revocation is one tap from the grant itself.
- `/revoke-all` — killswitch. Sets `revoked_at` on every active row **and rotates the bot token** via the vault. A compromised agent that exfiltrated the token retains its parallel channel otherwise; the kill must be complete.

### 9.1 Staleness model (replaces weekly digest)

Drop fixed-cadence digests. Replace with two triggers:

- **Threshold-triggered:** when `count(allow_always WHERE never_seen_in_digest) >= 3`, send a digest of the new standing grants. Rate-limited to at most one digest per 24h.
- **Staleness-triggered:** for each `allow_always` row where `last_used_at` is more than 30 days ago, surface a one-shot "this grant hasn't fired in 30d, revoke?" prompt with inline `Revoke` / `Keep` buttons. One prompt per row; on `Keep`, suppress for another 30d.

Steal sudo's pattern: surface staleness, not totals.

## 10. Long-poll protocol

The vault broker is request/response. Approvals can wait up to 5 minutes for a user tap. Spec:

1. `requestApproval` returns `{ status: 'pending', request_id }` immediately and synchronously.
2. The agent calls `awaitDecision({ request_id })` on a separate socket connection. The broker holds the connection open with periodic 10-second keepalive frames (`{ type: 'keepalive' }`) until either:
   - the user taps → broker sends `{ status: 'granted'|'denied', mode, ttl }` and closes.
   - the 5-minute timeout fires → broker sends `{ status: 'timeout' }` and closes.
3. Agent disconnect mid-poll: broker keeps the decision row; on reconnect+`awaitDecision` with the same request_id, replays the latest state.

Long-poll over 2s polling: lower latency, fewer round-trips, trivial to implement on top of the existing broker IPC.

## 11. Risks and open questions

- **Phase 4 `perm:` migration: kernel-only, not dual-write.** The existing `perm:always` path writes a Claude Code allow-rule via `permission-rule.ts` (133 lines). Two options:
  - *Dual-write*: kernel writes its decision row AND emits the Claude rule, with reconciliation on revoke. Reconciliation is a chronic source of bugs (settings.json edited externally, partial writes, etc.).
  - *Kernel-only* (recommended): the kernel becomes the source of truth. Claude Code's `settings.json permissions.allow` becomes managed by the kernel — the user no longer hand-edits it.
  Audit is the entire point of this RFC; pick kernel-only and accept that we lose Claude's native always-allow path.
- **`--print` mode and Phase 2 secrets.** `--print` bypasses Claude's permission-request flow (documented at `docs/stream-json-daemon-mode.md:401`). Secrets enforcement lives broker-side, not gateway-side, so Phase 0 (bot token in vault) plus the broker-mediated secret fetch means `--print` agents *still* go through the kernel for secret access — the bypass only affects tool-permission prompts, not secret unlocks. Document explicitly.
- **Cross-agent grant scope is unit-scoped, not user-scoped.** `allow_always` for `secret:OPENAI_API_KEY` granted to klanker does **not** auto-grant to gymbro. Each `agent_unit` is a separate principal, matching existing vault grants. User-scoped grants are out of scope for v1.
- **Callback delivery is best-effort.** If the gateway is down when the user taps, the tap is lost. 5-minute timeout, `timeout` audit row, agent re-issues if still wanted. Long-poll auto-reconnect (§10) covers agent-side restarts.
- **OAuth tokens (Google refresh tokens) live in vault.** Kernel asks vault for the token by slot name; vault enforces its own grant on that slot; kernel never persists raw tokens.
- **Group / multi-user is out of scope but trip-wired.** The drift-revocation rule (§5.2) makes this safe-by-default: the moment `allowFrom` grows past one entry, every standing grant becomes dormant pending re-confirmation.
- **Tap-budget target.** Day 1 of Drive enablement: 10–30 taps expected (cold cache, no folder grants). Steady state after onboarding: <5 taps/day. If exceeded, **batch coalescing** kicks in: the kernel buffers prompts for 5 seconds; if 3+ pending share a scope-prefix (e.g. `doc:gdrive:folder/Work/*`), it collapses into a single "klanker is requesting access to 4 docs in /Work — allow folder?" card.

## 12. Migration plan

**Phase 0 — bot token to vault. Prerequisite for everything else.** Move the Telegram bot token from its current filesystem location into the vault under a slot only `switchroom-gateway.service` can unlock. Any agent with filesystem read of the current token location is **already game-over** — it can post fake approval cards as the bot and intercept the user's tap. The kernel's whole trust chain depends on this. ~0.5 day.

**Phase 1 — kernel folded into vault broker.** New tables in `vault.db`, new RPC methods on `src/vault/broker/server.ts`, broaden peercred regex (§4.1), add HMAC row protection (§5.1), add `apv:` callback router in gateway, `/approvals list|revoke|add` commands, long-poll protocol (§10). ~1 day (was ~2; vault-broker fold-in saves the day).

**Phase 2 — secrets as first consumer.** Migrate the deferred-secret card path (`gateway.ts:5497`) to call the kernel. Lower-traffic, validates the abstraction, and the move from in-memory to SQLite is itself a real upgrade. Preserve the inline-passphrase capture UX. ~1 day.

**Phase 3 — Google Docs MCP wrapper as kernel consumer.** Build the MCP wrapper (default: `taylorwilsdon/google_workspace_mcp`) that calls the kernel for every doc/folder access. OAuth tokens in vault, extending the existing `auth:` slot pattern (`gateway.ts:8179`, `src/auth/`). Includes the §8a onboarding card and the §11 batch coalescing. ~2 days.

**Phase 4 — `perm:` migration (separate PR, separate review).** Highest regression risk; runs on the hot path of every tool call. Kernel-only as decided in §11. Defer until kernel has weeks of production proof. ~2 days.

## 13. Estimated effort

**Phases 0–3: ~4.5 focused engineering days.** Phase 4 is a separate ~2-day effort under its own review. The vault-broker fold-in shaves roughly a day off the v1 estimate.

## 14. Out of scope

- Group / multi-user bot support.
- Per-action MFA prompts beyond approval — Telegram 2FA is sufficient at this trust level.
- Web dashboard approval UX (CLI + Telegram only for v1).
- User-scoped (cross-agent) grants — every grant is unit-scoped in v1.
- Per-agent BindPaths / user-namespace isolation of the DB file — HMAC row protection (§5.1) is the v1 defense; namespace isolation is future hardening.
