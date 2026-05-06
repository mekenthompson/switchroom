# RFC: Unified human-approval kernel

Status: Draft v3
Author: klanker (sub-agent draft)
Date: 2026-05-06

## 1. Summary

Today switchroom asks the user to approve sensitive actions through at least four independent code paths, each with its own callback grammar, storage, and UX. This RFC proposes a single approval kernel — folded into the existing **vault broker** — that all current and future surfaces (secrets, vault grants, tool/skill permission requests, Google Docs and other MCPs) plug into. One process, one socket, one ACL surface, one SQLite file, one audit log, one Telegram card primitive.

The kernel reuses the broker's existing peercred + cgroup transport and ACL plumbing for **agent-identity gating only**. Almost everything else listed below — scope matching, HMAC row protection, HKDF-derived row-integrity key, append-only revocation chain, hash-chained audit, pidfd-pinned peercred, drift revocation, short-poll wait protocol, settings.json write-back — is **net-new code**. v2 leaned on "reuse" framing that obscured this; v3 names new subsystems plainly.

## 2. Motivation

Four approval-shaped surfaces exist today:

- **Deferred-secret cards** with `vd:unlock|cancel` callbacks — `telegram-plugin/gateway/gateway.ts:5497`.
- **Vault grants** via the `/vault grant` wizard, persisted to SQLite at `~/.switchroom/vault-grants.db` — schema migrated in `src/vault/grants.ts:59`.
- **Tool/Skill permission requests** via MCP `notifications/claude/channel/permission_request`, rendered as `perm:allow|deny|always` cards — `telegram-plugin/gateway/gateway.ts:1938` (card text) and `:1946-1947` (keyboard).
- **Operator and dashboard prompts** under the `op:` and `auth:` callback prefixes — `telegram-plugin/gateway/gateway.ts:8179` (auth) and `:8187` (op).

Adding a Google Docs MCP — and the inevitable Notion, Slack, and Gmail wrappers after it — means a fifth, sixth, and seventh surface unless the approval shape is unified. Each new surface duplicates: callback parser, storage decision (memory vs disk), TTL semantics, revocation command, audit trail. The cost compounds; the user sees inconsistent UX; there is no single `/revoke-all` killswitch.

## 3. Threat model and trust root

Switchroom is a **1:1 bot ↔ user** product. A single allowlisted Telegram `user_id` is identity, approver, and audit subject. This is a load-bearing assumption — the kernel relies on it. If group or multi-user bots ever ship, an `approvers` subset of `allowFrom` plus DM-only delivery of approval cards must be added; flagged here so future readers know what to revisit.

Telegram (with 2FA) is the auth factor. Inbound `callback_query.from.id` is authenticated by Telegram's bot session and cannot be spoofed remotely.

**Local threat surface.** All switchroom processes — gateway, agents, brokers — run as the same uid (`kenthompson`) under `systemd --user`. Filesystem permissions are *not* a security boundary between gateway and an agent. Concrete attacks the kernel must defend against:

1. **Bot token theft.** An agent that can read the bot token from disk can post fake approval cards as the bot and intercept the user's tap. The kernel's whole trust chain collapses. Phase 0 below moves the token into the vault.
2. **Cgroup spoofing.** Under cgroup v2 user delegation, a same-uid attacker can `mkdir` a fake cgroup path that looks like `switchroom-klanker.service` and move its own pid into it. `/proc/<pid>/cgroup` then reports the spoofed name. Documented at `src/vault/broker/peercred.ts:240-245`. Mitigation: `verifySystemdUnit` (`peercred.ts:254`) cross-checks every peercred result against `systemctl --user show`. **The kernel must call this on every request, not just at startup.** Without it, peercred is attacker-controlled input.
3. **PID-reuse / TOCTOU race on peercred.** Even with `verifySystemdUnit`, between `accept()` returning `SO_PEERCRED` and the broker reading `/proc/<pid>/cgroup` and `/proc/<pid>/status`, the original pid can exit and the kernel can recycle the pid for a *different* same-uid process whose cgroup IS a real switchroom unit. The attacker's exited process "becomes" the legitimate unit's pid for the duration of the read. Broadening the unit regex to long-running services (§4.1) makes this race far easier to exploit than the cron-only world, because long-running unit pids are observable and predictable. **Mitigation (NEW in v3):** immediately after `SO_PEERCRED`, call `pidfd_open(2)` to pin the process. All subsequent `/proc` reads route through `/proc/self/fdinfo/<pidfd>` (or equivalent); `pidfd_send_signal(pidfd, 0)` checks liveness before honoring the request. If the pidfd reports the process exited, reject with `peer_gone`. This is a new code path on top of the existing peercred logic, not a reuse.
4. **Direct DB writes.** Any agent can `sqlite3` open `vault-grants.db` and `INSERT` a forged grant row, bypassing the broker entirely. Mitigation in §5.
5. **HMAC threat-model honesty.** Per-row HMAC (§5.1) provides **tamper detection, not prevention.** A same-uid attacker with `ptrace_scope=0` or `CAP_SYS_PTRACE` can attach to the broker process and read the HKDF-derived row key out of memory, then mint forgeable rows. HMAC raises the bar from "trivial sqlite3 INSERT" to "ptrace + key extraction + chain replay" — meaningful but not a hard boundary. Real prevention requires per-agent user-namespace isolation so agent units cannot see the DB file or the broker's memory at all. That is **out of scope for v1** and tracked as Phase 5+ hardening.

Authorization happens at the IPC seam, never at the filesystem layer.

## 4. Design — fold into the vault broker

The kernel does **not** stand up a parallel broker. Approvals live as new tables in the existing `vault-grants.db`. **v3 keeps the filename** (`vault-grants.db`) rather than renaming to `vault.db` — the rename was cosmetic and would have made downgrade after Phase 1 impossible (HMAC'd rows in a renamed file are unverifiable to pre-rename binaries; the only "rollback" would be a clean re-init of approvals). Adding tables to the existing file ships the same capability with a real downgrade path.

The existing vault broker at `src/vault/broker/server.ts` grows new RPC methods:

- `requestApproval({ scope, why, ttl_hint })` → returns `{ status: 'pending', request_id }` immediately.
- `lookupDecision({ request_id | scope })` → checks for a live grant or pending decision. Used both for fast-path matching and for the short-poll wait loop (§10).
- `recordDecision({ request_id, mode, ttl })` → invoked by the gateway when the user taps.
- `revoke({ id, reason })` and `listForUser({ user_id })`.

**Why fold rather than fork.** The vault broker already owns: SO_PEERCRED authentication (`peercred.ts`), the systemd cross-check (`peercred.ts:254`), per-agent ACL enforcement (`src/vault/broker/acl.ts`), an audited DB handle, and a battle-tested IPC protocol. Reusing the IPC, peercred transport, and the agent-identity ACL machinery is real reuse; **scope matching, HMAC row integrity, the revocation chain, the audit chain, the short-poll layer, and the apv: callback router are all new**. v2's effort estimate undercounted these; §13 corrects it.

### 4.1 Peercred regex must be broadened, with pidfd pinning

`peercred.ts:223` currently matches **only** cron units:

```
/^switchroom-[a-zA-Z0-9_-]+-cron-\d+\.service$/
```

Long-running agent units (`switchroom-klanker.service`) are not matched and would fail the kernel's auth check. Replace with:

```
/^switchroom-[a-zA-Z0-9_-]+(-cron-\d+)?\.service$/
```

Two binding requirements:

1. **Route every approval RPC through `verifySystemdUnit` (`peercred.ts:254`).** Without it a same-uid attacker bypasses the broker via cgroup mkdir.
2. **Pidfd-pin the peer before any `/proc` read (NEW).** As called out in §3 attack 3, broadening to long-running units enlarges the TOCTOU window. `pidfd_open(pid)` immediately after accept; treat the pidfd as the authoritative process handle for the lifetime of the RPC; reject with `peer_gone` if liveness check fails. This is genuinely new code in `peercred.ts` — not a tweak to `verifySystemdUnit`.

## 5. Decision storage

New tables in `vault-grants.db`:

```sql
CREATE TABLE approval_decisions (
  id              TEXT PRIMARY KEY,    -- UUID v4 (durable identifier)
  agent_unit      TEXT NOT NULL,       -- systemd unit name, verified via peercred + systemd + pidfd
  scope           TEXT NOT NULL,       -- see §6
  state           TEXT NOT NULL,       -- 'active' | 'revoked'  (used in HMAC tuple)
  decision        TEXT NOT NULL,       -- allow_once | allow_always | allow_ttl | deny | deny_perm
  ttl_expires_at  INTEGER,             -- unix-ms, NULL for non-ttl
  ttl_original_ms INTEGER,             -- for sliding-window renewal hard cap (§7)
  granted_at      INTEGER NOT NULL,
  max_lifetime_at INTEGER,             -- granted_at + max_lifetime; sliding renewal cannot pass this
  last_used_at    INTEGER,             -- for sliding-window TTL + staleness digest
  granted_by_user_id INTEGER NOT NULL, -- Telegram user_id
  granted_at_allowfrom TEXT NOT NULL,  -- canonical-JSON; see §5.2
  revoked_at      INTEGER,
  revoke_reason   TEXT,
  key_version     INTEGER NOT NULL,    -- HKDF key version (§5.1)
  hmac            BLOB NOT NULL        -- see §5.1; covers tuple including `state`
);

CREATE TABLE approval_revocations (
  -- Append-only, HMAC-chained. See §5.1 for forgery defense.
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  decision_id     TEXT NOT NULL,
  reason          TEXT,
  prev_hmac       BLOB,                -- previous row's hmac (chain link)
  key_version     INTEGER NOT NULL,
  hmac            BLOB NOT NULL        -- HMAC over (seq, ts, decision_id, reason, prev_hmac)
);

CREATE TABLE approval_audit (
  -- Append-only, hash-chained.
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  agent_unit      TEXT NOT NULL,
  scope           TEXT NOT NULL,
  action          TEXT NOT NULL,       -- request | grant | deny | revoke | timeout | match | drift_revoke | tamper
  decision_id     TEXT,
  request_context TEXT,                -- JSON: why-string, caller frame, request_id
  prev_hmac       BLOB,                -- previous row's hmac
  key_version     INTEGER NOT NULL,
  hmac            BLOB NOT NULL        -- HMAC over row tuple including prev_hmac
);

CREATE TABLE approval_pending_nonces (
  -- Persisted before the card ships to Telegram (§6.1, §11).
  request_id      TEXT PRIMARY KEY,
  nonce           TEXT NOT NULL,
  scope           TEXT NOT NULL,
  agent_unit      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER
);
```

UUID is the durable primary key. The 8-hex callback token (matching existing `generateAskId` at `telegram-plugin/ask-user.ts:133`) is mapped to the UUID only for the prompt's lifetime.

### 5.1 SQLite same-uid write protection (HMAC every row, with HKDF + chains)

A same-uid agent can open the DB directly and `INSERT` a forged grant. Defense (NEW subsystem; not present in any existing code path):

- **Row-integrity key derivation.** The broker derives the row-integrity key via HKDF-SHA256 from the **vault master key**, with a fixed `info = "switchroom-approval-rowmac-v1"` and a salt stored in the `vault_meta` table. The master key is sealed at rest and only available post-vault-unlock — the same property the existing vault relies on. **The key is NOT a fresh random per unlock** — that v2 design broke `allow_always` semantics across restarts (verifying old rows would be impossible). Persistence across restarts is the whole point.
- **Vault relock semantics.** When the vault is locked (e.g. operator runs `switchroom vault lock`), the row-integrity key is unavailable, so all standing grants become temporarily unverifiable. This is **acceptable**: the user is already gated when the vault is locked (no agent can fetch a secret either), so denying every approval lookup with `vault_locked` is correct behavior. On next unlock the key re-derives and grants verify again.
- **Key rotation.** A `key_version` column on every HMAC'd row plus `vault_meta.current_key_version` lets the operator rotate by deriving a new version, re-MACing rows in a background job, then advancing the current version. Old-version rows remain verifiable until rewritten.
- **Per-row HMAC.** Every `approval_decisions`, `approval_revocations`, and `approval_audit` row carries an HMAC-SHA256 over its column tuple. **The decisions-table HMAC includes `state`**, so an attacker who flips `revoked_at` to `NULL` cannot resurrect a revoked grant — see §5.3.
- **Read path verifies HMAC** before honoring a row. Mismatch → row treated as not-present, `tamper` audit row written, operator alert fires.
- **Threat downgrade language.** Per §3 attack 5, this is detection, not prevention. Document plainly.

### 5.2 Config-drift auto-revocation

A grant recorded when `allowFrom = ["U1"]` must not silently extend if `allowFrom` later becomes `["U1", "U2"]`. At every `lookupDecision`:

- Re-read current `allowFrom` from access config.
- Compare against `granted_at_allowfrom`. **Both values are canonicalized identically before compare:** array elements are unicode-NFC-normalized, sorted lexicographically by NFC byte-order, no whitespace, JSON-canonical-encoded (RFC 8785 subset — sorted, no insignificant whitespace, no unnecessary escapes). Without this, identical sets serialized differently produce spurious drift-revocations.
- If canonical forms differ, treat as auto-revoked: write `drift_revoke` to audit, return no-grant, force re-prompt under the new approver set.
- If the current set has more than one approver, all standing grants are dormant until the operator re-confirms each one.

Drift is logged loudly. This goes in §7 (decision modes) and §11 (risks).

### 5.3 Revocation propagation and forgery defense

Soft-delete via `revoked_at` alone is forgeable: a same-uid attacker with the row-integrity key (per §3 attack 5 threat model) — or an attacker who lands a single byte-flip of `revoked_at` to NULL while bypassing HMAC verification — could resurrect a revoked grant if the original `(state="active", revoked_at=NULL)` HMAC remains valid. Defense:

- **State-bound HMAC.** The decisions HMAC tuple includes `state`. A revoke writes `state="revoked"` plus `revoked_at` plus a fresh HMAC over the new tuple. A row with `revoked_at IS NOT NULL` but a `state="active"` HMAC is detected as forged on read.
- **Append-only revocation chain (`approval_revocations`).** Every revoke also appends a chain entry HMAC'd over `(seq, ts, decision_id, reason, prev_hmac)`. Lookup of a decision verifies "no chain entry references this id" by reading the latest chain head and walking back if needed; the chain is short (one entry per revoke). The chain head HMAC is also written into `vault_meta.revocation_chain_head` so truncation is detectable.
- **Read path.** A `lookupDecision` accepts only rows that (a) HMAC-verify under their declared `state`, (b) have no entry in the revocation chain, AND (c) sit before the current chain head verified from `vault_meta`.

Every grant lookup re-reads `revoked_at` and the chain head from disk at use time. **No caching across calls.** Spec'd here so it cannot be optimized away later.

### 5.4 Audit hash chain

Each `approval_audit` row's HMAC includes the previous row's HMAC (`prev_hmac` column). The latest `hmac` is mirrored into `vault_meta.audit_chain_head` on every write. At broker startup the head is verified against the actual last row; mismatch → operator alert (`audit_chain_break`). Without the chain, a same-uid attacker with the key can simply `DELETE FROM approval_audit WHERE id > N` to truncate. The chain makes truncation detectable; full prevention again requires user-namespace isolation.

## 6. Scope grammar

Pluggable per surface. Each consumer registers a namespace and a matcher. The interface:

```ts
interface ScopeMatcher {
  namespace: string                     // 'secret' | 'tool' | 'doc' | 'mcp'
  matches(grant: string, request: string): boolean
  humanize(scope: string): Promise<string>  // for card display, async (may resolve doc titles)
}
```

**ScopeMatcher is a NEW subsystem.** v2 claimed reuse of `checkEntryScope` in `src/vault/broker/acl.ts:120` — that was misleading. `checkEntryScope` is a slug-list matcher (does this `agent_slug` appear in this entry's allow/deny list?). The new ScopeMatcher is a scope-string-vs-scope-string matcher with namespace dispatch. They solve different problems. The ACL module's agent-identity gating IS reused (the kernel asks "is this agent_unit allowed to even talk to me?" via existing ACL); scope matching is built fresh.

Namespaces:

- `secret:OPENAI_*` — env-name glob.
- `tool:bash:rm`, `tool:bash:rm -rf` — tool name + arg pattern.
- `tool:Skill:deploy` — Skill invocations.
- `doc:gdrive:1abc...xyz` — specific Drive doc id.
- `doc:gdrive:folder/789/**` — folder glob.
- `mcp:notion:page:...`

### 6.1 Bash-arg matching grammar (v1: prefix only)

Spec: **prefix matching only** for v1.

- `tool:bash:rm` matches any command beginning with `rm` after shell tokenization.
- `tool:bash:rm -rf` matches any command beginning with `rm -rf` after tokenization.
- No globbing, no regex, no quote-handling beyond standard POSIX shell tokenization (which the gateway already does upstream of the kernel).
- Tokenization is on whitespace within an argv array; the matcher compares argv-prefix equality.

This is intentionally simpler than `telegram-plugin/permission-rule.ts` (133 lines wrestling with quoting, globs, option flags). Phase 4 inherits Claude's `permission-rule.ts` complexity for finer-grained matching as **future work**; v1 ships with the limitation documented and the prefix matcher behind the same `ScopeMatcher` interface so a richer Phase 4+ matcher swaps in cleanly.

### 6.2 Callback wire format

Telegram callback_data is hard-capped at 64 bytes including the existing `agent:` prefix injected by the bridge. Scopes will not fit. Wire format:

```
apv:<8-hex request id>:<action>[:<param>]:<5-char base32 nonce>
```

- 8-hex request id matches `generateAskId` convention.
- 5-char base32 nonce is **server-generated, single-use, persisted to `approval_pending_nonces` synchronously BEFORE the card is sent to Telegram (§11), deleted on first tap.** A re-tap of an old card payload is rejected with "this prompt expired."
- Examples: `apv:a3f1b9c2:allow:k7m2x`, `apv:a3f1b9c2:ttl:1h:k7m2x`, `apv:a3f1b9c2:deny:k7m2x`.

Full scope and `humanize()` output are stored server-side keyed by request id.

**Crash-safety.** Because the nonce is durable before the card is sent, a tap arriving after gateway restart still resolves: the broker reads the nonce row, matches it, marks it consumed, processes the decision. A tap with no DB row (gateway crashed *before* persist completed and *also* failed to send the card — vanishingly rare given write-then-send ordering) is treated as a fresh request, which manifests as a short toast "this prompt expired, agent will re-ask" — never silently ignored.

## 7. Decision modes

Universal across surfaces:

- `allow_once` — single use, consumed on first match. **This is what the primary `Allow` button binds to** (clarification — see §8.1).
- `allow_always` — standing grant, no expiry. Subject to drift-revocation (§5.2).
- `allow_ttl` — bounded grant, **sliding window with hard cap.** Each successful `lookupDecision` match against an `allow_ttl` row sets `ttl_expires_at = now + ttl_original_ms`. The renewal is **silent — no tap, no notification.** The renewal does NOT extend the row past `granted_at + max_lifetime` (default 30 days, stored in `max_lifetime_at`) — hard cap. This is sudo's pattern (silent renewal up to a ceiling), not Bitwarden's (notification on every renewal). Default TTL is 1h; user can override via the expand picker.
- `deny` — single-shot reject.
- `deny_perm` — standing reject; future requests auto-fail without re-prompting.

The card surfaces only the common subset (see §8). The full mode set is editable post-grant via `/approvals`.

## 8. Telegram approval card UX

One shape, every surface. Built on the existing `aq:` (ask_user) primitive at `telegram-plugin/gateway/gateway.ts:8209` — that path already handles topic routing, quote-reply targeting, reaction-lifecycle, and `allowFrom` enforcement. The kernel registers a new `apv:` callback handler and reuses everything else.

### 8.1 Card states and primary-button semantics

**Pristine** (initial render):

```
🔐 klanker wants to read a doc
"Q3 Strategy Notes"     ← humanized via doc-title resolver
[ See more ]   [ ✅ Allow ]   [ 🚫 Deny ]
[ 🔁 Always ]  [ ⏱ For 1h ]
```

**Primary `Allow` button = `allow_once`.** Stated explicitly so it cannot be re-interpreted later. `Always` and `For 1h` on the secondary row are the two explicit overrides. The `Always` button is offered only when scope is rule-synthesizable (same gating as the existing `resolveAlwaysAllowRule` import at `gateway.ts:270`). `For 1h` is a single TTL default, NOT a picker — the picker lives behind expand.

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

**Expired (5-minute prompt timeout):** the broker expiry job runs every 30s; on each expiry it issues `editMessageReplyMarkup` to strip the buttons and `editMessageText` to set the body to `⌛ Expired — agent will re-request.` The pending nonce row is marked consumed. **A tap on an already-expired callback** returns `answerCallbackQuery({ text: 'this prompt expired' })` — a brief toast — and surfaces no error to the agent (which has already received `{ status: 'timeout' }` and either re-issued or moved on). Expired-nonce rejection happens at the broker callback-router layer before any decision-write logic runs.

**Revoked-after-grant:** on the next use attempt the agent gets a denial; the kernel posts a fresh notification card identifying which standing grant fired the denial and offering one-tap reinstate.

### 8.2 humanize() with a 500ms render budget

The kernel calls the namespace's `humanize()` before rendering, but **never blocks on it.** Spec:

1. Kick `humanize(scope)` immediately on `requestApproval`.
2. Race it against a **500ms timer.**
3. If `humanize()` resolves first → card ships with the humanized title.
4. If the timer fires first → card ships with the raw scope as the title; when `humanize()` later resolves (success), patch via `editMessageText` to the humanized version.
5. If `humanize()` rejects or times out fully (5s ceiling) → leave the raw scope and append a small `(could not resolve)` annotation.

The card is never delayed by humanize.

### 8.3 Preserved patterns (must not regress through migration)

- **`perm:more` expand button** at `gateway.ts:1946` — basis of the new card's expand. Same UX shape.
- **`summarizeToolForTitle` lift-to-title** at `gateway.ts:1938` (import at `:269`) — preserve for `tool:` scopes.
- **`vd:unlock` deferred-secret card flow** at `gateway.ts:5497` — Phase 2 migrates this surface; the inline-passphrase capture step must survive the move.
- **`aq:` topic-routing + reaction lifecycle** at `gateway.ts:8209` — inherit, do not rebuild.
- **`allowFrom` enforcement on every callback** — pattern at `gateway.ts:8218-8222`.

## 8a. First-run onboarding for new MCPs (v1: two options only)

When a new MCP wrapper is enabled, the kernel posts a one-time setup card before the first per-resource prompt fires.

```
🆕 Google Drive enabled. How should klanker access your Drive?

[ Allow all of Drive (less secure, fewer prompts) ]
[ Per-doc approval (default, more secure)         ]
```

**v1 ships exactly these two options.** The v2 draft included a third "Choose folders now → /approvals add with glob template" option — that was the v1 anti-pattern in disguise (user grants narrow, then has to widen under fatigue). It is dropped.

Footnote: folder-scoped grants land in **Phase 3.5** with a real Telegram folder picker. Until then, users widen via `/approvals add` post-grant if the per-doc default proves too noisy.

## 9. Audit, revocation, staleness

- `/approvals list` — paginated, two-level. Top-level `/approvals list` shows agent summary counts (`klanker: 12 grants, gymbro: 3 grants, …`) with tappable inline buttons to drill in. `/approvals list <agent>` shows up to 20 rows; older rows accessible via inline `Next →` button. Each row has inline `Revoke`. Telegram's 4096-char per-message cap is respected by capping at 20 rows + footer. User mental model is "what can klanker do?"; GitHub-style permissions UI is the reference.
- `/approvals revoke <id>` — single revoke; logs to `approval_audit` and appends to `approval_revocations` chain. **Every grant card's confirmation message includes `· /approvals revoke <id>` inline** so revocation is one tap from the grant itself.
- `/approvals add` — wizard for adding grants outside a prompt context (e.g. "allow all of Drive" post-onboarding).
- `/approvals stats` — surfaces 7-day request/grant/deny counts per agent. Used by the soft-alert in §11.
- `/revoke-all` — killswitch. See §9.2 for the exact ordered sequence.

### 9.1 Staleness model with weekly digest coalescing

Drop fixed-cadence digests of *everything*. Replace with two triggers, both rate-limited:

- **New-grants digest (threshold-triggered):** when `count(allow_always WHERE never_seen_in_digest) >= 3`, send a digest of the new standing grants. Rate-limited to at most one digest per 24h.
- **Stale-grants digest (weekly coalescing).** v2 specced one prompt per row, which scales badly: 40 stale rows = 40 separate "revoke?" prompts. v3: stale prompts coalesce into a **single weekly digest** with the same threshold-trigger logic — *N grants haven't fired in 30d, review?* — with one inline `Revoke` button per row in the digest. **No more than one staleness digest per week regardless of how many rows go stale.** Suppression is set per-row when the user taps `Keep` (suppressed for another 30d) or implicitly when the row remains in the digest unchanged for 4 consecutive weeks (auto-revoke under "stale and ignored", configurable).

Steal sudo's pattern: surface staleness, not totals.

### 9.2 `/revoke-all` ordered sequence

`/revoke-all` is a multi-step operation with real failure modes; spec the ordering exactly:

1. **Telegram `revokeToken`** — call the Bot API to evict the current token at Telegram's edge. If this fails: abort, surface `revoke_all_step1_failed`; nothing has changed yet.
2. **Mark all active rows revoked** — append-only chain entry per row, batch transactional. If this fails after step 1: token is already dead at Telegram; the gateway will fail to receive updates on next poll. Operator must run `switchroom token rotate` to restore. Surface `revoke_all_step2_failed_run_token_rotate`.
3. **Write new token to vault** — under the existing bot-token slot (Phase 0).
4. **SIGHUP gateway** — gateway re-reads token from vault. If the gateway fails to come back up: vault still holds the new token; operator can re-run `revoke-all` (step 1 is idempotent — Telegram `revokeToken` on an already-revoked token is a no-op) or just `systemctl --user restart switchroom-gateway.service`.
5. **Mark `revoke-all` complete** — audit row.

`switchroom token rotate` is the recovery command — idempotent re-run of steps 1, 3, 4. Document this in the killswitch help text.

## 10. Wait protocol — short-poll, not long-poll

The vault broker is request/response. Approvals can wait up to 5 minutes for a user tap. v2 specced long-poll (broker holds the connection open with keepalives); v3 drops that.

**Why drop.** Long-poll ties up a broker socket per pending request, opens a small DoS surface (an agent that opens many requests but never reads exhausts file descriptors), and requires keepalive framing inside the existing request/response IPC. None of that complexity is necessary.

**Short-poll spec:**

1. Agent calls `requestApproval(...)` → returns `{ status: 'pending', request_id }` immediately.
2. Agent calls `lookupDecision({ request_id })` every **2 seconds**. Broker responds immediately with `{ status: 'pending' | 'granted' | 'denied' | 'expired', mode?, ttl? }`.
3. On `granted`/`denied`/`expired`, agent stops polling.
4. On gateway restart between polls, the agent simply retries — `lookupDecision` is stateless from the agent's perspective.

**Caps (DoS defense):**

- Per `agent_unit`: max **2 concurrent pending** requests. A third `requestApproval` returns `{ status: 'rate_limited', retry_after_ms: 5000 }`.
- Global cap: **32 pending** requests across all agents. New requests get `rate_limited` until the queue drains.

This is a much smaller change to the existing broker than long-poll; no socket-lifetime semantics, no keepalive, no reconnect-replay logic.

## 11. Risks and open questions

- **Phase 4 `perm:` migration: kernel-only with settings.json write-back.** The existing `perm:always` path writes a Claude Code allow-rule via `permission-rule.ts` (133 lines). v3 picks **kernel-as-source-of-truth**: the kernel becomes authoritative; on every grant change, a write-back hook rewrites Claude Code's `settings.json` `permissions.allow` from kernel state. **User/tool edits to `settings.json` get overwritten** — this is the documented cost of authoritative kernel state. A CLI command `switchroom approvals sync-settings` exists for manual reconciliation if the file gets out of sync (e.g. after a kernel-side migration). The dual-write reconciliation alternative (kernel writes its row AND emits the Claude rule, with reconciliation on revoke) was rejected for chronic-bug risk.
- **HMAC threat-model honesty.** Repeated from §3 attack 5 and §5.1 because reviewers keep flagging it: per-row HMAC is **tamper detection, not prevention.** A same-uid attacker with `ptrace_scope=0` or `CAP_SYS_PTRACE` can read the row-integrity key from broker memory and forge rows. Real prevention needs user-namespace isolation; out of scope for v1, tracked as Phase 5+.
- **`--print` mode and Phase 2 secrets.** `--print` bypasses Claude's permission-request flow. Secrets enforcement lives broker-side, not gateway-side, so Phase 0 (bot token in vault) plus the broker-mediated secret fetch means `--print` agents *still* go through the kernel for secret access — the bypass only affects tool-permission prompts (Phase 4), not secret unlocks. Document explicitly.
- **Cross-agent grant scope is unit-scoped, not user-scoped.** `allow_always` for `secret:OPENAI_API_KEY` granted to klanker does **not** auto-grant to gymbro. Each `agent_unit` is a separate principal, matching existing vault grants. User-scoped grants are out of scope for v1.
- **Callback delivery is best-effort.** If the gateway is down when the user taps, the tap is lost. 5-minute timeout, `timeout` audit row, agent re-issues if still wanted. With nonce write-ahead persistence (§6.2), gateway restart **does not** lose pending cards — the v2 risk note about restart-loses-pending is resolved and removed.
- **OAuth tokens (Google refresh tokens) live in vault.** Kernel asks vault for the token by slot name; vault enforces its own grant on that slot; kernel never persists raw tokens.
- **Group / multi-user is out of scope but trip-wired.** The drift-revocation rule (§5.2) makes this safe-by-default: the moment `allowFrom` grows past one entry, every standing grant becomes dormant pending re-confirmation.
- **Tap-budget target and instrumentation.** Day 1 of Drive enablement: 10–30 taps expected (cold cache, no folder grants). Steady state: <5 taps/day. **Instrumentation:** `/approvals stats` surfaces 7-day tap counts per agent off the existing audit table. **Soft-alert (DM)** at >10 taps/day sustained for 3 days. If exceeded, **batch coalescing** kicks in: the kernel buffers prompts for 5 seconds; if 3+ pending share a scope-prefix (e.g. `doc:gdrive:folder/Work/*`), it collapses into a single "klanker is requesting access to 4 docs in /Work — allow folder?" card.

## 12. Migration plan

**Phase 0 — bot token to vault. Prerequisite for everything else.** Move the Telegram bot token from its current filesystem location into the vault under a slot only `switchroom-gateway.service` can unlock. Any agent with filesystem read of the current token location is **already game-over** — it can post fake approval cards as the bot and intercept the user's tap. ~0.5 day.

### 12.0.1 Phase 0 rollback plan

The token migration is a real cutover with three failure modes; spec each:

1. **Atomic move sequence.**
   - Read token from current filesystem location.
   - Write to vault slot; verify by reading it back.
   - Restart the gateway with vault-backed token loading; verify it can post a smoke message.
   - **Only after the smoke succeeds**, `shred -u` the old file.

2. **Failure modes.**
   - **Vault-write fails** → abort; token still on disk; no change. Operator inspects vault state and retries.
   - **Vault-read after write fails** (corruption, key-derivation glitch) → restore old file from backup taken before the migration; the gateway continues to read from disk; operator re-runs once vault is healthy.
   - **Smoke message fails** → restore old file from backup; revert gateway config.
   - **`shred` fails** (filesystem doesn't support secure delete, e.g. btrfs CoW) → log loudly and continue. Token now exists in two places — **SECURITY incident**, requires immediate token rotation via `/revoke-all` once Phase 1 ships, or via `switchroom token rotate` standalone.

3. **Boot chicken-and-egg.** Gateway needs the token to start; vault needs to be unlocked to give up the token. Resolved via the existing auto-unlock mechanism at `src/vault/auto-unlock.ts` (machine-bound encryption of the vault passphrase, decrypted at boot using `/etc/machine-id` + per-user state). If auto-unlock is **not enabled** on this machine, gateway start fails fast with: `vault locked, run "switchroom vault unlock" or enable auto-unlock with "switchroom vault broker enable-auto-unlock"`. The error is actionable; no silent boot loop.

**Phase 1 — kernel folded into vault broker.** New tables in `vault-grants.db` (no rename, see §4), new RPC methods on `src/vault/broker/server.ts`, broaden peercred regex with pidfd pinning (§4.1), HMAC row protection with HKDF + key versioning (§5.1), revocation chain (§5.3), audit chain (§5.4), short-poll wait protocol (§10), `apv:` callback router in gateway, `/approvals list|revoke|add|stats` commands, drift revocation, write-ahead nonce persistence, plus tests matching the existing broker's coverage (16 broker test files under `src/vault/broker/`). **~2 days, not 1.** v2's 1-day estimate ignored the new subsystems and tests.

**Phase 2 — secrets as first consumer.** Migrate the deferred-secret card path (`gateway.ts:5497`) to call the kernel. Lower-traffic, validates the abstraction, and the move from in-memory to SQLite is itself a real upgrade. Preserve the inline-passphrase capture UX. ~1 day.

**Phase 3 — Google Docs MCP wrapper as kernel consumer.** Build the MCP wrapper (default: `taylorwilsdon/google_workspace_mcp`) that calls the kernel for every doc/folder access. OAuth tokens in vault, extending the existing `auth:` slot pattern (`gateway.ts:8179`, `src/auth/`). Includes the §8a onboarding card (two options only) and the §11 batch coalescing. ~2 days. **Phase 3.5 — folder picker UI** is split out: real Telegram folder picker for grant scopes; ~1 day, can land separately once Phase 3 stabilizes.

**Phase 4 — `perm:` migration with settings.json write-back (separate PR, separate review).** Highest regression risk; runs on the hot path of every tool call. Kernel-only with write-back to `settings.json` as decided in §11. Defer until kernel has weeks of production proof. ~2 days.

## 13. Estimated effort

**Phases 0–3: ~6.5 focused engineering days** (revised up from v2's 4.5d).

| Phase | v2 estimate | v3 estimate | Delta drivers |
|------:|------------:|------------:|---------------|
| 0     | 0.5d        | 0.5d        | — |
| 1     | 1d          | 2d          | HKDF + key versioning, revocation chain, audit chain, pidfd pinning, short-poll + caps, drift canonicalization, write-ahead nonces, `/approvals list/revoke/add/stats`, settings.json write-back hook, tests matching existing 16-file broker coverage |
| 2     | 1d          | 1d          | — |
| 3     | 2d          | 2d          | — (3.5 folder picker split out as separate ~1d) |
| **Total 0–3** | **4.5d** | **6.5d** | |

Phase 4 is a separate ~2-day effort under its own review. Phase 3.5 (folder picker) is ~1d and can ship anytime after Phase 3.

## 14. Out of scope

- Group / multi-user bot support.
- Per-action MFA prompts beyond approval — Telegram 2FA is sufficient at this trust level.
- Web dashboard approval UX (CLI + Telegram only for v1).
- User-scoped (cross-agent) grants — every grant is unit-scoped in v1.
- Per-agent BindPaths / user-namespace isolation of the DB file — HMAC row protection (§5.1) is the v1 detection layer; namespace isolation is Phase 5+ hardening for prevention.
- Bash-arg matching beyond prefix (§6.1) — Phase 4+ work.
- DB filename rename to `vault.db` — kept as `vault-grants.db` to preserve downgrade path (§4).
