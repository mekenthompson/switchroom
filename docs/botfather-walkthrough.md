# BotFather walkthrough — create your switchroom bots

Step-by-step bot creation in Telegram. ~3 minutes for one bot, ~5 for
both. No screenshots; everything below is exactly what you type or tap.

## Prerequisites

- A Telegram account. Open the Telegram app (mobile, desktop, or web).
- Have your switchroom install ready to receive the tokens (you'll
  paste them into `switchroom setup` and `switchroom setup --foreman`).

## What you'll create

For a typical install you need **two** bots:

| Bot | Purpose | Where the token goes |
|---|---|---|
| **Foreman (admin) bot** | Fleet control: `/agents`, `/restart`, `/update apply`, etc. | `switchroom setup --foreman` |
| **Agent bot** | The bot you actually chat with — one per agent. | `switchroom setup` (first agent), then `switchroom agent add` |

You can create more bots later (one per additional agent). The process
is identical; this guide does the first two.

## Step 1 — Open BotFather

In Telegram, search for `@BotFather` (the official Telegram bot for
making bots — verified blue checkmark). Hit **Start** if you've never
talked to it.

## Step 2 — Create the foreman bot

Send these messages to BotFather, in order:

```
/newbot
```

BotFather replies asking for a name. This is the display name (can
contain spaces, change it later if you want):

```
My Fleet Foreman
```

Then it asks for a username. Must end in `bot` (case-insensitive),
must be unique on Telegram, 5-32 characters:

```
my_fleet_foreman_bot
```

BotFather replies with a token. **Save it**. Looks like:

```
1234567890:ABCdefGhIjKlMnOpQrStUvWxYz-abcdefghi
```

## Step 3 — Disable privacy mode on the foreman (optional but recommended)

If you plan to use the foreman in a group chat (not just DM), tell it
to see all messages, not just commands:

```
/setprivacy
```

Pick the foreman bot, then `Disable`. For DM-only use you can skip
this — privacy mode doesn't affect DMs.

## Step 4 — Create the agent bot

Repeat Step 2 with new names — for example:

```
/newbot
My Assistant
my_assistant_agent_bot
```

Save the second token.

## Step 5 — Use the tokens

In your switchroom host's shell:

```sh
# 5a — foreman bot
TELEGRAM_FOREMAN_BOT_TOKEN=<foreman token from step 2> \
  TELEGRAM_USER_ID=<your telegram user id> \
  switchroom setup --foreman

# 5b — first agent (only if you skipped `switchroom setup` so far)
switchroom setup
# When prompted for "agent bot token", paste the agent token from step 4.
```

If you don't know your Telegram user ID, message `@userinfobot` in
Telegram — it replies with your numeric ID immediately.

## Step 6 — DM your bot once

For each bot, open it in Telegram (search by username, or use the
direct link BotFather sent: `t.me/<bot_username>`) and tap **Start**.

The foreman won't reply until you bring the fleet up
(`switchroom apply && docker compose -p switchroom … up -d`). The
agent bot won't reply until both setup *and* `switchroom auth login`
are done.

## Optional: profile picture + description

For each bot, you can set:

```
/setdescription   → text shown above the chat input
/setabouttext     → text on the bot's profile page
/setuserpic       → upload a profile photo
```

Switchroom doesn't care; these are pure cosmetics.

## Troubleshooting

- **"Sorry, this username is already taken."** — Telegram usernames
  are globally unique. Try a more specific variant
  (`my_assistant_2026_bot`).
- **"This username is invalid."** — Must end in `bot`, be 5-32 chars,
  alphanumeric + underscore. No hyphens, no leading numbers.
- **Lost the token** — In BotFather: `/mybots` → pick your bot → API
  Token → Revoke and regenerate.
- **Want a "better" username later** — BotFather: `/setname` /
  `/setusername`. Tokens stay valid.

## Security

- Each token is **bearer authentication** for that bot. Treat them
  like passwords. Don't paste them into chats, gists, screenshots.
- Switchroom stores tokens in its encrypted vault
  (`~/.switchroom/vault/`) after setup. The tokens never go to disk
  in plaintext once setup completes.
- If a token leaks, revoke and rotate via BotFather: `/mybots` →
  pick bot → API Token → Revoke.
