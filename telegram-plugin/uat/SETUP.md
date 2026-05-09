# UAT Harness — One-time Setup

This is the operator runbook for bringing up the Telegram UAT harness
introduced by epic [#863](https://github.com/switchroom/switchroom/issues/863).
Phase 1 ships scaffolding only — every step in this file is a manual
prerequisite that must be completed once before the first scenario can
run against real Telegram.

> ⚠️ **Security floor.** The mtcute *session string* this harness mints
> is **bearer-equivalent to the driver Telegram user account**. Anyone
> holding it can read every chat the user can read and impersonate them
> in messages. Treat it with the same care as a long-lived OAuth refresh
> token:
>
> - **Never** log it. **Never** echo it to a terminal. **Never** commit
>   it. **Never** paste it into chat for "debugging."
> - It lives in vault under key `telegram-uat-driver-session` and that
>   is the only legitimate location.
> - Same rules apply to `telegram-test-bot-token` (a normal bot token,
>   but a bot the harness drives autonomously — leak = remote control).

---

## 1. BotFather: create the test bot

1. Open `@BotFather` from the operator's Telegram account.
2. `/newbot` → name (e.g. `Switchroom UAT`) → username (e.g.
   `@switchroom_uat_bot`).
3. Copy the HTTP API token BotFather returns.
4. **Disable privacy mode** so the test bot sees all messages in groups,
   not just commands: `/setprivacy` → select the bot → `Disable`.
   (Privacy mode does not affect the driver's ability to read the bot —
   bots cannot read other bots regardless. This is for the bot reading
   the driver user.)
5. Vault the token:
   ```bash
   switchroom vault set telegram-test-bot-token
   # paste token at the prompt; do not pass via argv
   ```
6. Sanity check:
   ```bash
   TOKEN=$(switchroom vault get telegram-test-bot-token)
   curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq .ok
   # expect: true
   unset TOKEN
   ```

## 2. Create the test supergroup

1. New Group → add the test bot + the driver user → "Upgrade to
   supergroup" (Settings → Group Type, or just enable Topics; both
   actions imply supergroup).
2. Settings → **Topics: Enabled**.
3. Settings → Administrators → promote both:
   - test bot — needs at least: Manage Topics, Pin Messages, Delete
     Messages.
   - driver user — needs at least: Manage Topics (so per-scenario
     topic creation works without the bot doing it).
4. Note the chat id. Easiest: forward any message from the supergroup
   to `@RawDataBot` and copy `forward_from_chat.id`. It will be
   negative and ~13 digits (`-100…`).
5. Stash the chat id under your shell profile or a UAT env file (NOT
   in the repo):
   ```bash
   echo 'export SWITCHROOM_UAT_CHAT_ID=-1001234567890' >> ~/.config/switchroom/uat.env
   ```

## 3. Driver user: mint the mtcute session

The mtcute MTProto driver runs as a **Telegram user account**, not a
bot, because bots cannot read other bots' messages even with admin
rights. ([Telegram Bots FAQ](https://core.telegram.org/bots/faq).)

You will need:
- An `api_id` and `api_hash` from <https://my.telegram.org/apps> (one
  per developer; reusable across projects).
- The driver user's phone number, the SMS/Telegram login code, and the
  2FA password if set.

Run:
```bash
cd telegram-plugin
TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abcdef0123... bun run uat:login
```

The script prompts for phone, login code, and 2FA password on stdin,
captures the session string in memory, and writes it to vault as
`telegram-uat-driver-session`. It **never prints the session string
to stdout or stderr** — if you see one in your scrollback, file an
incident.

## 4. 2FA / new-device re-login playbook

mtcute session strings can get invalidated when:
- The user changes/sets a 2FA password.
- The user terminates the session from another client (Settings →
  Devices → Active sessions → Terminate).
- Telegram's anti-abuse heuristics decide the session is suspicious
  (rare, but happens after long idle + IP change).

When a scenario fails with `AUTH_KEY_UNREGISTERED`,
`SESSION_REVOKED`, or `SESSION_PASSWORD_NEEDED`:

1. Confirm via the Telegram app (Settings → Devices) that the prior
   session is gone.
2. Re-run `bun run uat:login` from the operator's machine.
3. Enter the current 2FA password when prompted.
4. The script overwrites the vault key. No other action required —
   nothing caches the old string.

If the driver account is locked entirely (e.g. SPAM_WAIT), only the
account owner can resolve it via support@telegram.org. The harness has
no recourse.

## 5. Worktree-based agent install (NOT `switchroom agent add`)

The UAT harness does **not** persistently install the test-harness
agent through `switchroom agent add` (which writes a systemd unit + a
persistent state dir — wrong shape for hermetic test runs). Instead,
the harness `exec`s the agent as a child process per scenario with:

- `STATE_DIR=$(mktemp -d)` — ephemeral; teardown rm-rfs it.
- A unique `TELEGRAM_GATEWAY_PORT` (see port allocator note below).
- `SWITCHROOM_AGENT_NAME=test-harness`.
- The test bot token loaded from `telegram-test-bot-token`.

The Phase 1 scaffold stubs this out in `harness.ts`; Phase 2 wires it
end-to-end.

## 6. Port allocator vs unix sockets

Phase 1 commits to a **process-wide port allocator** (see
`uat/port-allocator.ts`) rather than unix sockets. Rationale:

- The gateway already speaks IP loopback to the bridge; switching to
  unix sockets is a code change in `gateway/` we don't want bundled
  with the UAT scaffold work.
- Tests only ever run from one harness process, so a node-local
  monotonic counter starting at a high ephemeral port (default 47000)
  is enough to avoid collisions with the system + with sibling
  scenarios in the same run.
- The allocator also `bind()`s a probe socket and releases it before
  returning, which catches "port already in use by another process"
  before the agent boots and produces a confusing crash.

If we ever want concurrent harness runs from CI, swap to unix sockets;
the harness API takes a `transport` shape so it's a one-line change.

## 7. Verification checklist before running scenarios

- [ ] `switchroom vault get telegram-test-bot-token` returns a token.
- [ ] `switchroom vault get telegram-uat-driver-session` returns a
      session string (the command output may be redacted by the
      vault — that's fine, you only need exit code 0).
- [ ] `$SWITCHROOM_UAT_CHAT_ID` exported and is a negative int.
- [ ] Test bot is admin in the supergroup.
- [ ] Driver user is admin in the supergroup.
- [ ] Topics enabled in the supergroup.

When all six are checked, `bun run test:uat` is safe to run.
