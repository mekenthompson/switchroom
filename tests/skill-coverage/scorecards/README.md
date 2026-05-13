# Skill-coverage scorecards

Checked-in scorecards from harness runs. Update via:

```bash
# Run the harness (see ../../../docs/skill-coverage/runbook.md):
bun tests/skill-coverage/cli-claude.ts --limit-per-skill=8

# Promote the live-run artifact to a checked-in scorecard:
cp tests/skill-coverage/out/skill-coverage-claude.scorecard.md \
   tests/skill-coverage/scorecards/baseline.scorecard.md
cp tests/skill-coverage/out/skill-coverage-claude.scorecard.json \
   tests/skill-coverage/scorecards/baseline.scorecard.json
cp tests/skill-coverage/out/skill-coverage-claude.run.json \
   tests/skill-coverage/scorecards/baseline.run.json

git add tests/skill-coverage/scorecards/
```

## Threshold

Goal: every skill at trigger F1 ≥ 0.9 and execution success ≥ 0.95.

Current baseline (`baseline.scorecard.md`) is the first end-to-end
measurement after the harness lands. Most skills are well below the
threshold — see `docs/skill-coverage/audit.md` for the per-skill
description issues those gaps reflect. Iterations:

1. **Round 1 baseline** — checked in this PR. Identifies the long tail
   of skills failing on natural-language phrasings.
2. **Round N** — after each batch of audit-recommended description
   fixes lands (#1217 was the first), re-run the harness and update
   the baseline. The `run.json` keeps every probe for forensic diff
   between rounds.

## Methodology

The runner (`tests/skill-coverage/cli-claude.ts`) invokes `claude -p`
in a workspace symlinked to every bundled SKILL.md, parses the
`tool_use` events from stream-json output, and scores per skill.
Three other runners (the MTCute UAT runner, the inject_inbound
runner) target real running agents; the claude-cli runner is the
fastest baseline path and the one this directory tracks.
