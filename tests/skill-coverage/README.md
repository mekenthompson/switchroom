# Skill-coverage harness

Probabilistic test harness that fuzzes natural-language phrasings at a
running switchroom agent and scores whether the right skill fires.

## What it does

1. **Generate a corpus** from `fixtures/skills.json` — six paraphrases,
   three typos, three slang variants, three indirect "symptom"
   phrasings, and four negative controls drawn from adjacent skills'
   trigger space. Output: `corpus/<skill>.jsonl`.
2. **Inject** each probe at the agent's gateway socket as a
   synthesized `inject_inbound` envelope (same protocol the in-agent
   scheduler uses for cron-fired turns).
3. **Observe** the agent's session JSONL via `session-tail`, capture
   every `tool_use` event, and pull the `input.skill` field for any
   `Skill` invocations.
4. **Score** precision / recall / F1 per skill plus a negative-control
   FP rate. Output: `scorecard.json` + `scorecard.md`.

## Run

```bash
# Generate the corpus (deterministic given the seed)
bun run tests/skill-coverage/corpus/generate-corpus.ts --seed=1

# Dry-run: build the corpus and exit (no agent contact)
bun run tests/skill-coverage/cli.ts my-agent --regen-corpus

# Live run against a real agent (requires gateway socket + agent cwd)
bun run tests/skill-coverage/cli.ts my-agent \
  --agent-cwd=/home/kenthompson/.switchroom/agents/my-agent \
  --gateway-socket=/run/switchroom/agents/my-agent/gateway.sock \
  --go
```

## Unit tests

```bash
npm test -- --run tests/skill-coverage
```

Tests cover:
- corpus determinism (same seed → byte-identical output)
- score module math (canned input → expected F1)

No network — the runner is unit-tested with an in-memory inject + a
fake observer.

## Authoring curated seeds

Drop a `corpus/seeds/<skill>.yaml` to add hand-written variants:

```yaml
paraphrases:
  - "kill agent X and bring it back up"
slang:
  - "yo kick agent X"
indirect:
  - "agent X is wedged"
negatives:
  - phrase: "publish this to the package registry"
    expectedOtherSkill: "buildkite-secure-delivery"
```

Curated seeds prepend to the rule-based output and dedupe by lowercase
phrase. They count toward the per-category cap, so if you add 6 hand-
written paraphrases the rule-based pass adds zero.
