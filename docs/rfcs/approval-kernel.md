# RFC: Unified human-approval kernel

Status: Draft
Author: klanker (sub-agent draft)
Date: 2026-05-06

## 1. Summary

Today switchroom asks the user to approve sensitive actions through at least four independent code paths, each with its own callback grammar, storage, and UX. This RFC proposes a single approval kernel — one IPC broker, one SQLite store, one Telegram card primitive, one audit log — that all current and future surfaces (secrets, vault grants, tool/skill permission requests, Google Docs and other MCPs) plug into. The kernel is shaped on the existing `vault-broker` trust model and reuses the proven SO_PEERCRED + cgroup-derived unit identity.

## 2. Motivation

Four approval-shaped surfaces exist in the codebase right now:

- **Deferred-secret cards** with `vd:unlock|cancel` callbacks, in-memory only — `src/gateway.ts:1304`.
- **Vault grants** via the `/vault grant` wizard, persisted to SQLite at `~/.switchroom/vault-grants.db` — `src/vault/grants-db.ts`.
- **Tool/Skill permission requests** via MCP `notifications/claude/channel/permission_request`, rendered as `perm:allow|deny|always` cards — `src/gateway.ts:1980`, `src/bridge.ts:451`.
- **Operator and dashboard prompts** under the `op:` and `auth:` callback prefixes — `src/gateway.ts:8291`.

Adding a Google Docs MCP — and the inevitable Notion, Slack, and Gmail wrappers after it — means a fifth, sixth, and seventh surface unless the approval shape is unified. Each new surface duplicates: callback parser, storage decision (memory vs disk), TTL semantics, revocation command, audit trail. The cost compounds; the user sees inconsistent UX; there is no single `/revoke-all` killswitch.

## 3. Threat model and trust root

Switchroom is a **1:1 bot ↔ user** product. A single allowlisted Telegram `user_id` is identity, approver, and audit subject. This is a load-bearing assumption — the kernel relies on it. If group or multi-user bots ever ship, an `approvers` subset of `allowFrom` plus DM-only delivery of approval cards must be added; flagged here so future readers know what to revisit.

Telegram (with 2FA) is the auth factor. Inbound `callback_query.from.id` is authenticated by Telegram's bot session and cannot be spoofed remotely.

**Local threat surface.** All switchroom processes — gateway, agents, brokers — run as the same uid (`kenthompson`) under `systemd --user`. Filesystem permissions are *not* a security boundary between gateway and an agent: an agent can read the bot token from `~/.switchroom/...` and call Telegram directly as the bot, or read `vault-grants.db` directly off disk. The kernel must therefore not rely on file perms for authorization. Authorization happens at the IPC seam.

## 4. Design — broker model

The kernel runs in-gateway (or as a sibling process sharing the gateway's lifecycle) and exposes a unix-socket API at `~/.switchroom/approval-broker.sock`.

Caller identity is established via **SO_PEERCRED + cgroup → systemd unit name**, modeled directly on `src/vault/broker/peercred.ts` and the ACL logic in `src/vault/broker/acl.ts`. The unit name (e.g. `switchroom-klanker.service`) is the authorization principal, not the pid or uid. Reuse the existing helpers — do not reimplement.

File permissions on `approvals.db` are belt-and-suspenders, never the primary control.

**Why a broker over a library.** A library linked into the agent process gives that agent direct access to the SQLite file; an agent can rewrite its own grants, forge audit entries, or read peer agents' decisions. The broker is a single mediating process that owns the DB handle, validates every request against the peer's unit name, and emits the audit row.

## 5. Decision storage

SQLite at `~/.switchroom/approvals.db`, modeled on `vault-grants.db`.

```
decisions(
  id              TEXT PRIMARY KEY,    -- 5-char base32, see §6
  agent_unit      TEXT NOT NULL,       -- systemd unit name
  scope           TEXT NOT NULL,       -- see §6 grammar
  decision        TEXT NOT NULL,       -- allow_once | allow_always | allow_ttl | deny | deny_perm
  ttl_expires_at  INTEGER,             -- unix-ms, NULL for non-ttl
  granted_by_user_id INTEGER NOT NULL, -- Telegram user_id
  granted_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  revoke_reason   TEXT
);
audit(
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  agent_unit      TEXT NOT NULL,
  scope           TEXT NOT NULL,
  action          TEXT NOT NULL,       -- request | grant | deny | revoke | timeout | match
  decision_id     TEXT,
  request_context TEXT                 -- JSON blob, why-string + caller frame
);
```

Persistent grants survive restart. In-memory deferred-prompt state (the open card, awaiting tap) does **not**, matching today's deferred-secret behavior — acceptable.

## 6. Scope grammar

Pluggable per surface. Each consumer registers a namespace and a matcher:

- `secret:OPENAI_*` — env-name glob.
- `tool:bash:rm *` — tool name + arg pattern.
- `tool:Skill:deploy` — Skill invocations.
- `doc:gdrive:1abc...xyz` — specific Drive doc id.
- `doc:gdrive:folder/789/**` — folder glob.
- `mcp:notion:page:...`

Telegram callback_data is hard-capped at 64 bytes including the existing `agent:` prefix injected by the bridge. Scopes will not fit. Use 5-char base32 request ids (existing pattern at `src/gateway.ts:8482`); store the full scope server-side and pass only the id over the wire. Card payload becomes `apv:<id>:allow`, `apv:<id>:deny`, `apv:<id>:ttl:1h`, etc.

## 7. Decision modes

Universal across surfaces:

- `allow_once` — single use, consumed on first match.
- `allow_always` — standing grant, no expiry.
- `allow_ttl` — bounded grant (1h, 24h, 7d picker).
- `deny` — single-shot reject.
- `deny_perm` — standing reject; future requests auto-fail without re-prompting.

## 8. Telegram approval card UX

One shape, every surface. Title line, requesting agent, scope (rendered human-readably from the scope string), why-string (call-site context if the consumer supplied it), inline keyboard with mode choices.

Built on the existing `aq:` (ask_user) primitive at `src/gateway.ts:8326-8345` — that path already handles topic routing, quote-reply targeting, and reaction-lifecycle. The kernel registers a new `apv:` callback handler and reuses everything else.

## 9. Audit and revocation

- `/approvals list` — standing decisions grouped by surface, with TTL countdown.
- `/approvals revoke <id>` — single revoke; logs to `audit`.
- `/revoke-all` — killswitch; sets `revoked_at` on every active row.
- Weekly digest of `allow_always` rows so silent accumulation is visible. Dovetails with the existing scheduled-message infrastructure (`docs/scheduling.md`).

## 10. Migration plan

**Phase 1 — kernel + storage + Telegram primitive.** Standalone. No consumers wired. Includes the `apv:` callback router, the broker socket, the SQLite schema, and `/approvals list|revoke` commands. Estimated ~2 days.

**Phase 2 — secrets as first consumer.** Migrate the deferred-secret card path (`src/gateway.ts:1304`) to call the kernel. Lower-traffic, validates the abstraction, and the move from in-memory to SQLite is itself a real upgrade. ~1 day.

**Phase 3 — Google Docs MCP wrapper as kernel consumer.** Build the MCP wrapper that calls the kernel for every doc/folder access. OAuth tokens (Google's refresh tokens) live in vault, extending the existing `auth:` slot pattern (`src/gateway.ts:8291`, `src/auth/`). ~2 days including OAuth glue.

**Phase 4 — `perm:` migration (separate PR, separate review).** The tool/skill permission path runs on the hot path of every tool call; highest regression risk. Defer until kernel has weeks of production proof. Similar size, ~2 days.

## 11. Risks and open questions

- **`perm:always` writes to Claude Code's allow-rules** (`permission-rule.ts`), not switchroom storage. Migration buys us auditability but is a bigger lift than a wrapper — the kernel needs to write both its own decision row and continue emitting the Claude rule, or we accept that `allow_always` for tools no longer hits Claude's settings.
- **`--print` mode bypasses permission-request entirely** (documented at `docs/stream-json-daemon-mode.md:401`). Pre-existing bug; the kernel inherits it. Out of scope for this RFC; flagged.
- **Callback delivery is best-effort.** If the gateway is down when the user taps, the tap is lost. Approval cards must define a timeout (proposed: 5 minutes). On timeout the kernel emits a `timeout` audit row, the agent sees a failed request, and must re-issue if it still wants the action.
- **OAuth tokens are sensitive.** Vault is the right home. Define explicitly: kernel asks vault for the token by slot name, vault enforces its own grant on that slot, kernel never persists raw tokens.
- **Group / multi-user is out of scope but trip-wired.** First time `allowFrom` grows beyond one entry, the kernel schema needs an `approvers` column and card delivery must become DM-only.

## 12. Google Docs MCP — concrete picks

- `taylorwilsdon/google_workspace_mcp` — most actively maintained, full Workspace coverage, OAuth 2.1.
- `a-bonus/google-docs-mcp` — popular, OAuth 2.1, Docs-only.
- `piotr-agier/google-drive-mcp` — OAuth + auto-refresh, alternative auth modes.

Default to **taylorwilsdon** for breadth. Revisit after the Phase 3 prototype reveals real pain points.

## 13. Estimated effort

5–6 focused engineering days for Phases 1–3. Phase 4 is a separate ~2-day effort under its own review.

## 14. Out of scope

- Group / multi-user bot support.
- Per-action MFA prompts beyond approval — Telegram 2FA is sufficient at this trust level.
- Web dashboard approval UX (CLI + Telegram only for v1).
- Cross-agent shared decisions — each agent's grants are scoped to its unit name; no inheritance between agents.
