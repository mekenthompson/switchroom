# Telegram features

Three opt-in features tune how an agent talks on Telegram. All three
land under `channels.telegram.*` in `switchroom.yaml` and cascade
through the standard defaults → profile → agent layering.

The `switchroom telegram` CLI verb is the supported way to turn each
one on. Hand-editing `switchroom.yaml` works too — the CLI just edits
the same keys.

```sh
switchroom telegram status
# Agent    Voice-in       Telegraph   Webhook sources
# gymbro   ✓ openai (en)  —           —
# lawgpt   —              ✓ 3000      —
# klanker  —              —           ✓ github

switchroom telegram enable telegraph --agent lawgpt --threshold 2500
switchroom telegram disable telegraph --agent lawgpt
```

## Telegraph long-reply publishing

**What:** replies above a threshold are published to telegra.ph; the
agent sends a single message linking to the article, which Telegram
renders as an Instant View card.

**Why:** keeps a chat scrollable when an agent produces a long
research write-up or a multi-paragraph briefing.

**Tradeoff (content residency):** the article body is hosted by
Telegraph (Telegram's pastebin-style service), not on your machine.
Don't enable for agents whose output may include secrets or
client-confidential material.

**Enable:**

```sh
switchroom telegram enable telegraph --agent lawgpt --threshold 3000
```

Optional flags: `--short-name`, `--author-name` (Telegraph article
metadata).

## Voice-in transcription

**What:** inbound voice / audio messages are downloaded and
transcribed via OpenAI Whisper, then surfaced to the agent as the
user's text input.

**Why:** lets you talk to an agent on the move without typing.

**Tradeoff (subscription-honest):** Whisper requires an OpenAI API
key. That's the one place Switchroom asks you to leave the
Pro/Max-only ceiling — there's no Anthropic-side voice transcription
yet. The key only ships voice bytes for transcription; the agent
itself still runs through your Pro/Max subscription.

**Enable** (will land in a follow-up PR after #604):

```sh
switchroom telegram enable voice-in --agent gymbro --api-key sk-...
# stores the key in the vault, sets channels.telegram.voice_in.enabled
```

## Webhook ingest

**What:** an external service (e.g. GitHub) POSTs events to
`https://<your-host>/webhook/<agent>/<source>` and the agent receives
them as inbound messages.

**Why:** notify an agent when a PR is opened, a build fails, an
incident page lands — without you forwarding it manually.

**Tradeoff (security perimeter):** a webhook secret must be set per
agent and source; the web endpoint validates the signature. A
mis-configured secret means events are silently rejected with a 401.

**Enable** (will land in a follow-up PR after #604):

```sh
switchroom telegram enable webhook --agent klanker \
  --source github --secret whsec_...
```

See `docs/webhook-ingest.md` for the underlying signature scheme.
