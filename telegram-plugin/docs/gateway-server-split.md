# Gateway / server split — inventory + migration plan

## Where we are

`telegram-plugin/` has two parallel Telegram dispatch entry points:

| File | Lines | Role |
|---|---|---|
| `telegram-plugin/server.ts` | 6661 | **Legacy monolith** — registers grammy bot handlers and runs the polling loop in-process |
| `telegram-plugin/gateway/gateway.ts` | 8257 | **New gateway split** — same handlers but designed to run in a separate process from the agent, with IPC between them |

Both register near-identical sets of `bot.command()`, `bot.on()`, `bot.callbackQuery()`, and `bot.use()` handlers. The intent is for `gateway.ts` to fully replace `server.ts`. The work is in-progress and never finished — neither side is complete on its own.

This document is the parity inventory + migration plan to finish the split.

## Command parity matrix

Every `bot.command()` in either file:

| Command | server.ts | gateway.ts | Notes |
|---|---|---|---|
| `/agents` | ✅ | ✅ | |
| `/agentstart` | ✅ | ✅ | (was `/switchroomstart` pre-#527) |
| `/approve` | ✅ | ✅ | |
| `/auth` | ✅ | ✅ | |
| `/authfallback` | — | ✅ | **gateway-only** |
| `/commands` | ✅ | ✅ | (was `/switchroomhelp` pre-#527) |
| `/dangerous` | ✅ | ✅ | |
| `/deny` | ✅ | ✅ | |
| `/doctor` | ✅ | ✅ | |
| `/grant` | ✅ | ✅ | |
| `/help` | ✅ | ✅ | |
| `/interrupt` | ✅ | ✅ | |
| `/issues` | — | ✅ | **gateway-only** |
| `/logs` | ✅ | ✅ | |
| `/memory` | ✅ | ✅ | |
| `/new` | ✅ | ✅ | |
| `/pending` | ✅ | ✅ | |
| `/permissions` | ✅ | ✅ | |
| `/pins-status` | ✅ | — | **server-only** |
| `/reauth` | ✅ | ✅ | |
| `/reset` | ✅ | ✅ | |
| `/restart` | ✅ | ✅ | |
| `/start` | ✅ | ✅ | Telegram bot pairing |
| `/status` | ✅ | ✅ | |
| `/stop` | ✅ | ✅ | |
| `/topics` | ✅ | ✅ | |
| `/update` | ✅ | ✅ | |
| `/usage` | — | ✅ | **gateway-only** |
| `/vault` | ✅ | ✅ | |
| `/version` | ✅ | ✅ | |

**Parity gaps to close:**
- **`/pins-status`** (server-only) — admin/debug command for the pinned-progress-card lifecycle. Already hidden from the slash menu (per `welcome-text.test.ts` `droppedFromMenu` list). Move to gateway, or fold into a generalised `/debug` admin surface.
- **`/authfallback`** (gateway-only) — manual quota check + fallback. Power-user. Should also exist in server for parity (or accept that server is in sundown mode and skip).
- **`/issues`** (gateway-only) — the `/issues` card surface added by #428. Recent enough that server didn't get it.
- **`/usage`** (gateway-only) — Pro/Max plan quota display. Recent.

## Other handler parity

Both files register these `bot.on()` handlers (essentially identical signatures):

| Event | Both? | Notes |
|---|---|---|
| `callback_query:data` | ✅ | Inline-keyboard tap dispatcher |
| `message:text` | ✅ | Inbound text message |
| `message:photo` | ✅ | |
| `message:document` | ✅ | |
| `message:voice` | ✅ | |
| `message:audio` | ✅ | |
| `message:video` | ✅ | |
| `message:video_note` | ✅ | |
| `message:sticker` | ✅ | |
| `message_reaction` | ✅ | (with grammy parameter cast) |

Plus `bot.use()` middleware in both for shared authorization gating.

## Why two files exist

The split was started to enable a **gateway process model**:

- `gateway.ts` runs as a long-lived daemon, owns the Telegram polling loop and shared resources (IPC server, MCP-side state, etc.)
- Per-agent processes (claude CLI runs) communicate with the gateway over a unix socket
- This decouples agent restarts from Telegram polling — restarting `clerk` doesn't drop in-flight inbounds for `klanker`

`server.ts` was the prior monolithic model where each agent ran its own polling loop in-process. The plan is to retire it.

The problem: **the migration was never completed**. Both files coexist, drift on every PR (witness `/issues`, `/authfallback`, `/usage` landing only in gateway), and impose double maintenance for any new handler.

## Migration plan (Wave 3)

### F1 — This document

Inventory + plan. No code change. **(this PR)**

### F2 — Backport server-only commands to gateway

Port `/pins-status` to gateway (or remove it as the now-obsolete pre-#469 surface — it predates the heartbeat-driven pinned-card lifecycle).

Result: gateway.ts is a strict superset of server.ts.

### F3 — Make gateway the only path agents launch

Today, agents may start in either mode depending on env / config. Audit `start.sh.hbs` and the bridge wiring — flip the default to gateway. Keep server.ts as an opt-out for one release for safety.

### F4 — Delete `telegram-plugin/server.ts`

Once F3 has soaked for one release (or one week of fleet usage with no rollback), delete server.ts. Update tests and docs that reference it.

Estimated effort:
- F2: half-day (one command move + smoke test on a fleet agent)
- F3: 1-2 days (audit + flip + soak)
- F4: half-day (delete + clean references)

Total: ~3-4 days of focused work, spread across 3 PRs to keep blast radius small.

## Risks

- **F2 risk: low.** Adding a single command to gateway is mechanical; the parity test (which exists in `tests/telegram-commands.test.ts`) catches the diff.
- **F3 risk: medium.** If gateway has any agent-process-specific bugs that only manifest under load, F3's fleet-wide flip is when they'd surface. Soak window mitigates.
- **F4 risk: low** (assuming F3 soaked cleanly). Pure delete.

## What this unblocks

Once gateway is the only entry point:
- New handlers land in one file. No more parity drift.
- Wave 1's `/switchroomhelp` → `/commands` rename only had to be done twice because of the split. Future renames are once.
- Wave 2 PR E (perms consolidation) can land cleanly without coordinating two dispatchers.
- The 6661 + 8257 = 14918-line burden drops to 8257 + new code, with shared imports staying single-source.

## Anchor for follow-up issues

When opening the F2/F3/F4 PRs, link back to this doc as the canonical inventory + plan. The parity matrix is the regression-prevention test: any new `bot.command()` added to gateway during the split must EITHER be a known server-only-doesn't-need-port command OR get mirrored to server until F3 lands.
