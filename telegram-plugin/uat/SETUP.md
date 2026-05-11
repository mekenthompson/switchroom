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

## 5. The `test-harness` agent (Phase 2a — DM focus)

Phase 2a tests run against a **persistent** `test-harness` agent
created once via `switchroom agent add`. This pivots from the epic's
original child-process-per-scenario plan (written before the Docker
runtime landed) — the standard runtime now gets us most of the
hermeticity we want without re-inventing the agent lifecycle. Forum
topic + per-scenario STATE_DIR isolation rolls in with Phase 2b.

### One-shot agent creation

```bash
# Resolve the driver's user_id once via mtcute (the helper prints
# only the integer id to stdout; the session string never appears):
cd ~/code/switchroom/telegram-plugin
read -sp "Vault passphrase: " SWITCHROOM_VAULT_PASSPHRASE; echo
export SWITCHROOM_VAULT_PASSPHRASE
DRIVER_UID=$(bun uat/driver-info.ts)
echo "Driver user_id: $DRIVER_UID"

# Then create the agent. `--topology dm --allow-from $DRIVER_UID`
# bypasses the @BotFather DM-pair flow and writes the driver's
# user_id directly into allowFrom — so the bot will respond only
# to DMs from the driver, never from arbitrary Telegram users
# (important: the test bot's token is in vault scoped to
# `test-harness` only, but the bot itself is publicly reachable
# on Telegram).
SWITCHROOM_BOT_TOKEN=$(switchroom vault get --no-broker telegram-test-bot-token) \
  switchroom agent add test-harness \
    --profile default \
    --topology dm \
    --bot-username meken_switchroom_test_bot \
    --allow-from "$DRIVER_UID"
unset SWITCHROOM_BOT_TOKEN SWITCHROOM_VAULT_PASSPHRASE

# Verify the agent is up:
switchroom agent status test-harness
```

`agent add` runs the n+1 wizard: scaffolds the per-agent dir under
`~/.switchroom/agents/test-harness/`, refreshes the compose file,
boots the container, runs a preflight. On success the agent is
running and will reply to DMs from the driver user account.

> **Known papercut — fix in #1001.** The wizard currently writes the
> `--allow-from` user_id into `access.json` as a **number**; the
> gateway requires it as a **string** and silently ignores DMs until
> patched. Until #1001 lands, after `agent add` succeeds, edit the
> file by hand (the file is owned by the per-agent UID; needs sudo):
>
> ```bash
> sudo python3 -c "
> import json
> p = '/home/$USER/.switchroom/agents/test-harness/telegram/access.json'
> d = json.load(open(p))
> d['allowFrom'] = [str(x) for x in d['allowFrom']]
> d['groups'] = {}   # see #1002: scaffold leaves a stray placeholder chat_id
> json.dump(d, open(p, 'w'), indent=2)
> "
> ```

> **Known papercut — fix in #1002.** The scaffold leaves a
> placeholder `groups: {"-100…"}` entry pointing at a chat the bot
> isn't in. The gateway probes it at boot and gets a 404 (noisy log,
> not fatal). The `sudo python3` snippet above clears it; otherwise
> ignore the `boot-probe-failed` log line.

### When this agent should be running

- During UAT runs: yes. Scenarios fail with `expectMessage` timeouts
  if the agent isn't responding.
- Idle: harmless to leave running. It consumes one Claude turn only
  when DMed by the driver — no scheduled work, no MCP polls.

### Resetting state between runs

Phase 2a accepts mild state pollution across scenarios (the agent's
history accumulates). To reset hard:

```bash
switchroom agent stop test-harness
rm -rf ~/.switchroom/agents/test-harness/state
switchroom agent start test-harness
```

Phase 2b adds per-scenario state-dir scoping so this becomes
automatic.

### Optional: force progress-card on every turn (Phase 2c+ card scenarios)

The gateway's `progress_card.delay_ms` defaults to 45 s, so short DM
turns (most of UAT) never trigger the pinned card and the card-
lifecycle scenarios (`progress-card-dm.test.ts`) skip themselves.
To unskip — and validate `expectPinnedCard` / `waitForCardPhase`
against real Telegram — override the delay on `test-harness` only:

Edit `~/.switchroom/switchroom.yaml`, find the `test-harness:`
block, and add the highlighted lines:

```yaml
  test-harness:
    extends: default
    topic_name: Test Harness
    channels:
      telegram:
        progress_card:
          delay_ms: 1000     # short — make every turn flash a card
```

Then apply + restart:

```bash
switchroom apply
switchroom agent restart test-harness
```

Production agents keep the 45 s default; this override is test-only.
Once configured, unskip the card scenario by changing
`describe.skip(...)` → `describe(...)` in
`scenarios/progress-card-dm.test.ts`.

## 6. Running scenarios — env setup

The harness reads four env vars at `spinUp()` time. Source them from
vault once, run tests, then clear:

```bash
cd ~/code/switchroom/telegram-plugin

read -sp "Vault passphrase: " SWITCHROOM_VAULT_PASSPHRASE; echo
export SWITCHROOM_VAULT_PASSPHRASE

export TELEGRAM_API_ID=$(switchroom vault get --no-broker telegram-uat-api-id)
export TELEGRAM_API_HASH=$(switchroom vault get --no-broker telegram-uat-api-hash)
export TELEGRAM_UAT_DRIVER_SESSION=$(switchroom vault get --no-broker telegram-uat-driver-session)
export TELEGRAM_TEST_BOT_USERNAME=meken_switchroom_test_bot

unset SWITCHROOM_VAULT_PASSPHRASE

bun run test:uat

unset TELEGRAM_API_HASH TELEGRAM_UAT_DRIVER_SESSION TELEGRAM_API_ID TELEGRAM_TEST_BOT_USERNAME
```

> **Known papercut — fix in #999.** Each `vault get --no-broker` line
> above relies on `$SWITCHROOM_VAULT_PASSPHRASE` being set in the env
> because the vault CLI's passphrase prompt writes to stdout — which
> `$(...)` captures into the env var, so the prompt is never shown to
> the operator and the read fails silently. Setting
> `SWITCHROOM_VAULT_PASSPHRASE` first sidesteps the prompt entirely.
> If you forget, you'll see `Error: Passphrase cannot be empty` for
> each line and `TELEGRAM_API_HASH=` will be empty, leading to a
> later misleading "API ID invalid" from Telegram.

The vault passphrase is unset BEFORE the tests run so a misbehaving
scenario can't smuggle it into a chat message. The remaining env
vars are scoped to the shell session — close the shell to clear.

## 7. Verification checklist before running scenarios

- [ ] `switchroom vault list` shows `telegram-test-bot-token`,
      `telegram-uat-api-id`, `telegram-uat-api-hash`,
      `telegram-uat-driver-session` (and `telegram-uat-chat-id` for
      Phase 2b).
- [ ] `switchroom agent status test-harness` reports the agent active.
- [ ] Driver user can DM `@meken_switchroom_test_bot` from Telegram
      and get a reply (manual sanity check before automating).

When all three are checked, the env block above + `bun run test:uat`
is safe to run.

## 8. Port allocator vs unix sockets (Phase 1 scaffold note)

The Phase 1 `port-allocator.ts` is held in reserve for Phase 2b's
child-process flow — Phase 2a (standard-runtime agent) doesn't need
it. Kept rather than deleted because the allocator's bind-probe is
the right shape for what 2b will need.
