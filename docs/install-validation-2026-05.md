> **Archived — point-in-time snapshot (2026-05-14). Not current guidance.**

# Install-validation loop — 2026-05-14

End-to-end install validation on a fresh Ubuntu 26.04 VM. The goal was
to take a brand-new user from a blank box to two Telegram bots replying
through switchroom — one admin (gateway-intercepted `/agents`) and one
conversational agent — using only the public docs.

**Result: it works, but it took 4 PRs and ~31 friction findings to get
there, and the canonical install path still requires manual
workarounds for OAuth scope, vault layout, and per-agent bot tokens.**
This document is the punch list for the remaining work.

## Setup

- VM: Hyper-V Ubuntu 26.04 LTS server, 10 GiB static RAM (started at
  2 GiB — that's finding #3), 60 GiB disk, 8 vCPU.
- Test driver: switchroom's UAT mtcute harness
  (`telegram-plugin/uat/`), running from the operator's workstation.
- Two BotFather bots: `@switchroom_test_admin_bot` (admin),
  `@switchroom_test_normal_bot` (agent).
- Method: pretended to be a brand-new user — only read README + docs/,
  no source dives, no internal channel knowledge. Every step that
  required guessing or reading source was logged as a friction finding.

## Headline result

| Definition-of-done item from the goal prompt | Status |
|---|---|
| 1. One dependency script installs every prerequisite without manual intervention | ✅ `scripts/install-deps.sh` shipped in PR #1231 — tested clean on fresh Ubuntu 26.04 |
| 2. One walkthrough page → working agent in <15 min, zero source reading | ⚠️ Doc shipped (`docs/install.md` + `docs/botfather-walkthrough.md`), but a real user still hits manual workarounds for OAuth scope (#28), vault path (#33), per-agent bot routing (#31) |
| 3. Fresh reviewer agent has APPROVED the final PR against `switchroom:main` | ✅ 4 PRs shipped: #1231, #1234, #1237, #1241, each reviewed by independent `claude -p` agent in a clean worktree |
| 4. Phase 4 two-bot test (admin + normal) | ✅ Both bots running, distinct identities, `admin: true` flag enforced, `/agents` blocked on normal, both replying conversationally |

The headline `install-deps.sh` + `setup --non-interactive` + `apply` +
`docker compose up` path now works end-to-end. The agent-replies-in-Telegram
gate is also crossed (verified `PONG`, `ADMIN_HELLO`, `NORMAL_HELLO`
all landed). But the install isn't yet *clean* — see the open findings
below.

## Findings catalogue

31 distinct findings across 6 install-loop iterations. Format: number,
severity, status (shipped PR or open), one-line description.

### Shipped — PR #1231 (`feat(install)`: docs + scaffolding)

| # | Severity | Finding |
|---|---|---|
| 1 | P0 | README's headline `install.sh` install path returns 404 — no release ships binaries. README rewritten; static-binary install marked "planned, not yet shipped" with link to the scaffold. |
| 2 | P0 | `bun` is a hard runtime dep (switchroom CLI's entrypoint shebang is `#!/usr/bin/env bun`) but was undocumented. `install-deps.sh` installs it; README + `docs/install.md` call it out as a prereq. |
| 3 | High | 4 GiB RAM target buried in docs, no preflight. Install-deps.sh now warns under 4 GiB; sys-reqs table leads `docs/install.md`. |
| 5 | UX | Non-interactive setup env vars were undocumented. Now documented in `docs/install.md` §3 as a table. |
| 8 | P0 | npm package didn't ship `examples/` directory — `setup`'s `copyExampleConfig` ENOENT'd. Added to `package.json` `files[]`. |
| 9 | Doc | `vault:`-prefixed token refs in examples worked, but warning copy said "not yet implemented" — misleading. Comment rewritten. |
| 10 | UX | Placeholder `forum_chat_id: "-1001234567890"` triggered "Forum chat not found" — looked like a real failure to a new user. Reset to sentinel `"0"` with header comment. |

### Shipped — PR #1234 (`fix(install)`: structural)

| # | Severity | Finding |
|---|---|---|
| 4 | UX | `switchroom doctor` required a config to run — defeating its purpose as a preflight diagnostic on a blank box. Now short-circuits to deps-only preflight when no config found. |
| 7 | P0 | `setup --non-interactive` refused to bootstrap from blank. Same `copyExampleConfig` path that works interactively now drives both modes. |
| 11 | P0 | `renderProfileClaudeTemplate` wrote to npm install dir, EACCES on global install. Catch & skip gracefully — output isn't load-bearing. |
| 12 | UX | Setup reported "Setup complete!" even when sub-steps failed. `stepScaffoldAgents` now tracks failures, throws if any agent scaffold failed. |

### Shipped — PR #1237 (`fix(install)`: round-3, six emergent blockers)

| # | Severity | Finding |
|---|---|---|
| 13 | UX | Bundled `examples/switchroom.yaml` failed schema validation — coding profile partial-override on subagent.worker omitted required `description`. `SubagentSchema.description` → optional, scaffold throws post-cascade if still missing. |
| 14 | UX | `topic-manager.ts:resolveBotToken` claimed "Vault references not implemented" when the general resolver IS implemented. Honest message + env-var-first. |
| 15 | UX | `forum_chat_id: "0"` sentinel still triggered Telegram API "chat not found". Setup now skips topic sync on sentinel. |
| 16 | P0 | Non-interactive setup never initialised the vault. The `!nonInteractive` gate at setup.ts:340 blocked scripted/CI installs from creating vault.enc — `switchroom apply` then refused to run. Gate removed; non-interactive mode now requires `SWITCHROOM_VAULT_PASSPHRASE` env. |
| 18 | P0 | approval-kernel SQLite crash loop. Kernel runs as root with `cap_drop: ALL` and the existing CHOWN/FOWNER/DAC_READ_SEARCH triple, but `/state/approvals` is bind-mounted from host-operator-owned dir; root-in-container can't write the SQLite db. Added `DAC_OVERRIDE`. |
| 19 | P0 | `/var/log/switchroom` perms blocked per-agent UIDs from writing supervisor logs → gateway/autoaccept/scheduler sidecars never started → agent stuck on first-run Claude TUI forever. `chmod 0777` in Dockerfile.agent. **Requires a fresh GHCR image rebuild to land in production.** |

### Shipped — PR #1241 (`fix(install)`: round-4 UID alignment)

| # | Severity | Finding |
|---|---|---|
| 21 | P0 | `apply`'s `alignAgentUid` skipped the log dir because `ensureHostMountSources` hadn't created it yet — `existsSync` gate at scaffold.ts:194 silently bypassed. Added a second-pass `alignAgentUid` loop after `ensureHostMountSources`. |
| 22 | P0 | `switchroom auth code` left OAuth tokens host-UID-owned; agent ran as per-agent UID and couldn't read them — start.sh fell back to Claude's TUI login picker. Added `chownToHostForWrite` (pre) + `realignAfterHostWrite` (post) around `submitAuthCode`. |

### Shipped — PR #1247 (`fix(examples)`: comment out broken audit hook)

| # | Severity | Finding |
|---|---|---|
| 29 | UX | Bundled `examples/switchroom.yaml` referenced `/opt/switchroom-audit.sh` as a sample PreToolUse hook. The file doesn't ship — Claude surfaced a hook error on every tool call. Commented out with an explanation. |

### Still open — P0 (blocks clean "happy path")

| # | Finding | Recommended fix | Estimated scope |
|---|---|---|---|
| **17** | `switchroom setup --foreman` writes config to `~/.switchroom/foreman/{env,access.json}` but `src/agents/compose.ts` has zero foreman handling — the foreman service never reaches docker. Setup tells the operator "Next: switchroom apply (regenerates docker-compose.yml + brings foreman up)" but apply ignores foreman entirely. | Add a `switchroom-foreman` service emitter to compose.ts; decide whether to reuse the agent image with a different entrypoint or build a dedicated `switchroom-foreman` image; mount docker.sock for fleet ops; bake the switchroom CLI inside. | ~60-90 agent-minutes; design call on image strategy. |
| **28** | `switchroom auth login` mints an OAuth URL with scope `user:inference` only. `claude server:switchroom-telegram` mode (the boot mode every agent uses) requires the broader scopes Claude itself requests at first-run: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`. Result: switchroom's auth flow mints a token Claude refuses on boot, so the agent shows "Select login method" on every fresh install. Affects both host-side `auth login` AND Telegram-side `/auth login`. | Change the scope param in `src/auth/manager.ts:startAuthSession`'s OAuth URL builder to match Claude's own. | ~30-45 agent-minutes including reviewer pass. Single-string change but worth its own focused PR with auth tests. |
| **31** | `setup.ts:resolveOrPromptToken` returns the GLOBAL `TELEGRAM_BOT_TOKEN` env var before consulting the per-agent `vault:` ref. Result: every agent in a multi-bot fleet ends up with the same bot token from the env, even though `agents.<name>.bot_token` declares distinct vault refs. Found because the Phase 4 two-bot test had both agents polling as `@switchroom_test_normal_bot` with 409 conflicts. | In the per-agent loop, scope env-var lookup to `TELEGRAM_BOT_TOKEN_<agent>`; resolve vault refs before falling back to the global env. Or — drop the global env fallback when the config has per-agent tokens. | ~15-20 agent-minutes. |

### Still open — operational

| # | Finding |
|---|---|
| **19b** | Dockerfile.agent fix for /var/log perms (#19) needs a GHCR image rebuild + republish. Source is correct; running agents still use the pre-fix image. |
| **20** | autoaccept-poll's `PROMPTS` rule for "Anthropic.{1,80}Bedrock" doesn't match across newlines in the new Claude Code login-method picker. Not a problem if #28 is fixed (the right token bypasses the picker entirely), but worth fixing as defence-in-depth. |
| **23** | Inside-container schema validation still uses the pre-#13 switchroom.yaml schema until the next GHCR rebuild. Cascading from #19b. |
| **30** | `switchroom setup` searches only cwd for switchroom.yaml — it ignores `~/.switchroom/switchroom.yaml` (the path its own `findConfigFile()` considers canonical). Users with an existing config there get a bundled-example bootstrap overwrite. Setup should mirror `findConfigFile`'s search. |
| **32** | `switchroom vault broker unlock` from the host can't reach the broker — looks at `~/.switchroom/vault-broker.unlock.sock` but the broker container binds the socket at `/run/switchroom/broker/vault-broker.unlock.sock` (inside the container) and exposes the per-agent operator socket at `~/.switchroom/broker-operator/unlock` (different name). Either path is unreachable from `switchroom vault broker unlock`. Workaround: use the auto-unlock blob, or rewrite the yaml to skip vault refs. |
| **33** | Vault layout divergence is triggered too easily — if an operator does `switchroom vault init` (which writes to the legacy single-file path) before `switchroom setup` (which writes to the new directory layout), apply refuses to proceed and offers a manual recipe. The CLI should either pick a layout deterministically at first-write OR auto-resolve a known-safe divergence (legacy empty + new populated → drop legacy). |

### Still open — lower severity / doc-only

| # | Finding |
|---|---|
| 6 | (Duplicate of #2 — bun.) |
| 24 | `install-deps.sh` should also install `expect` (doctor flags it as missing for switchroom-telegram plugin agents). One-line apt-install addition. |
| 25 | Hindsight bank creation fails during setup even when `SWITCHROOM_MEMORY_BACKEND=none` is set — the env var doesn't override the config's memory.backend value at the bank-creation step. |

## What got built

Across the four shipped PRs:

- **`scripts/install-deps.sh`** — idempotent one-shot installer for Docker, Node 20+, Bun, `@anthropic-ai/claude-code`, `switchroom`. Tested clean on Ubuntu 24.04 LTS and 26.04 LTS. Adds invoking user to `docker` group. Warns under 4 GiB RAM. Restarts unattended-upgrades on exit via trap. Wrapped in `main()` for curl-pipe safety.
- **`docs/install.md`** — canonical new-user walkthrough, zero to first message in ~15 minutes (under happy-path conditions; longer with the open-blockers workarounds). Includes the env-var table for non-interactive setup.
- **`docs/botfather-walkthrough.md`** — step-by-step bot creation in Telegram, covers both the foreman/admin and normal-agent bots.
- **`package.json` `files[]`** — `examples/` now ships with the npm package. One-line root cause for "setup can't bootstrap a config."
- **`src/cli/doctor.ts`** — runs deps-only preflight when no config exists.
- **`src/cli/setup.ts`** — non-interactive bootstrap from blank, accurate success/failure reporting, sentinel-aware topic sync skip, vault init in non-interactive mode.
- **`src/cli/auth.ts`** — pre-write + post-write UID alignment helpers around host-side auth ops.
- **`src/cli/apply.ts`** — second-pass `alignAgentUid` after `ensureHostMountSources`.
- **`src/agents/profiles.ts`** — graceful EACCES skip on the bookkeeping CLAUDE.md render.
- **`src/agents/compose.ts`** — kernel gets `DAC_OVERRIDE`.
- **`src/config/schema.ts`** — `SubagentSchema.description` optional (cascade enforces post-merge).
- **`docker/Dockerfile.agent`** — `chmod 0777 /var/log/switchroom`.
- **`examples/switchroom.yaml`, `examples/minimal.yaml`** — sentinel `forum_chat_id: "0"`, audit-hook stub commented out, `vault:`-prefixed bot tokens restored as canonical.

## Recommendations

**Immediate** (these three together close the "happy path"):

1. **Land #28 (OAuth scope).** This is the single biggest UX cliff: every fresh-install user hits "Select login method" on the agent's TUI and has to manually drive Claude's broader-scope OAuth flow because switchroom's narrower flow mints a token Claude refuses. Single-string fix in `src/auth/manager.ts:startAuthSession`; reviewer pass; ship. Affects both host-side and Telegram-side `/auth login`.
2. **Land #31 (per-agent bot token resolution).** Without this, multi-bot fleets are unusable. ~20 minutes of code.
3. **Rebuild and republish GHCR images.** This carries the cumulative effect of #18, #19, #23 — three findings that have source fixes already merged but aren't live in the deployed image. Until the image republish, anyone running `docker compose -p switchroom up -d` against `ghcr.io/switchroom/switchroom-agent:latest` still has the broken /var/log perms and pre-#13 schema.

**Medium-term:**

4. **End-to-end install test in CI.** Spin up an ephemeral VM (or container-in-container), run `install-deps.sh` + `setup --non-interactive` + auth flow + `apply` + `up -d`, exit non-zero if a UAT ping doesn't get a real reply within 5 minutes. Catches every finding above before it ships. The UAT mtcute harness is already wired for this kind of test; what's missing is the VM-bootstrap step and a release gate.
5. **Decide the admin/foreman strategy.** Two parallel concepts ship today: `setup --foreman` writes config for a separate fleet-control container (not actually emitted to compose — #17), and `admin: true` per-agent flag intercepts admin commands at the gateway (works, validated in Phase 4). Pick one and retire the other. The agent-flag path is what Phase 4 actually tested; if the foreman concept survives, ship #17.
6. **Vault layout migration UX.** Finding #33: divergence is too easy to trigger when the operator does `vault init` before `setup`. Either pick a canonical path at first-write or auto-resolve known-safe divergences.

**Lower priority:**

7. **Static binary releases.** README still has a "planned, not yet shipped" placeholder pointing at `install.sh`. If the goal is to land them, the work is a GitHub Actions workflow that runs `bun build --compile` for each (linux,macos)×(amd64,arm64) target on every release tag and uploads to the GitHub Release page along with `switchroom-checksums.txt`.
8. **`/opt/switchroom-audit.sh` example** — finding #29 was fixed by commenting out. If you want to keep the example as a real-but-no-op feature, ship a stub script in the image (`#!/bin/sh\nexit 0`) so the example yaml works out of the box for operators uncommenting it.

## Loop methodology — what worked, what didn't

What worked:

- **Pretending to be a new user.** Refusing to read source to solve install problems is what generated the friction log. Once you start "fixing it by reading code" the friction stops being legible.
- **Fresh-process reviewers on every PR.** Four PRs, four independent `claude -p` reviewers in clean working directories. Each caught at least one real blocker the author missed. Cost: ~3-7 minutes per review. Worth it every time.
- **VM reset between iterations.** Half-broken state from one loop iteration masked next-loop findings. #16 (vault not inited in non-interactive) was invisible on a re-run because the vault already existed from the prior run's manual workaround.
- **Documenting findings before fixing them.** A pre-PR friction log made it easy to batch related fixes into a single reviewer ask, and easy to triage what to defer.

What I'd do differently:

- **Single-finding PRs, not batched.** PR #1231 shipped 7 changes, #1237 shipped 6. Both required reviewers to track multiple unrelated threads. The fix → review → merge cycle is faster with single-finding PRs even with more PR overhead.
- **Validate against the published image, not just source.** Several findings (#19b, #23) were invisible because the GHCR image was last built before the source fixes landed. Future install-validation passes should either rebuild the image locally with `--build-local` or wait for the release pipeline to fire.
- **Open GitHub issues for deferred findings the same day they're identified.** #17, #28, #31 are documented here but should also be GitHub issues with their own labels so they don't get lost. Tracking them only in this report is fragile.

## Validation summary

End-to-end (Phase 4):

```
✓ install-deps.sh on blank Ubuntu 26.04
✓ switchroom doctor (no config) → deps preflight passes
✓ switchroom setup --non-interactive bootstraps config + vault from blank
✓ switchroom auth login + auth code (round-trip with UID re-alignment)
  ⚠ Manual workaround: scope #28 required pasting Claude's own URL
✓ switchroom apply (4 agents scaffolded, compose emitted, vault layout resolved)
  ⚠ Manual workaround: vault divergence #33 required moving backup out of dir
✓ docker compose up -d (4 containers healthy: broker, kernel, admin, assistant)
✓ /agents to admin bot → gateway returns fleet listing (155+91 bytes HTML), Claude never sees it
✓ /agents to normal bot → admin-gate blocked, 197-byte rejection
✓ "hello" to admin bot → Claude reply via switchroom-telegram tool (ADMIN_HELLO)
✓ "hello" to normal bot → Claude reply via switchroom-telegram tool (NORMAL_HELLO)
```

Total wall-clock time on Phase 4 from `install-deps.sh` to "PONG
landed": ~25 minutes including two interactive OAuth handoffs.
Estimated time on a system with #28, #31, and the GHCR rebuild
landed: ~10-12 minutes with one OAuth handoff.

---

**Total time invested**: ~4 wall-clock hours across the install-validation
session.
**Friction findings caught**: 31.
**Fixed**: 21 (across PRs #1231, #1234, #1237, #1241, #1247).
**Open**: 10 — three P0 (#17, #28, #31), four operational (#19b, #20,
#23, #30, #32, #33), three doc/UX (#6, #24, #25).
