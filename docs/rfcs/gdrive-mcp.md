# RFC C: Google Drive MCP integration

Status: Draft v1
Author: klanker (sub-agent draft)
Date: 2026-05-06

Prerequisite: **RFC B — Approval kernel** (`docs/rfcs/approval-kernel.md`) must be in place. The Drive MCP is the first real consumer.

## 1. Summary

Add a Google Drive MCP server so agents can read and (with explicit approval) write Drive docs. OAuth tokens live in the vault; every doc/folder access goes through the approval kernel; first-run onboarding offers two coarse-grained policies (whole Drive vs per-doc default); a richer folder picker is deferred to a future RFC. Scope-prefix batch coalescing handles the common "klanker just opened a /Work folder, expect a flurry of doc reads" pattern without spamming the user.

## 2. MCP server choice

**Recommended:** [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp). Maintained, covers Drive + Docs + Sheets + Calendar in one server, supports refresh-token flow which we can store in the vault. Alternative servers exist but most either bundle to a single doc, lack token persistence, or require running under a Google service account (which loses the per-user approval semantics).

We run the MCP server as a switchroom-managed subprocess of each agent that has Drive enabled, the same way other MCP servers are managed today. Configuration goes through the existing MCP config surface; no new config plane.

## 3. OAuth token storage

- The Google OAuth flow (initial consent, code exchange) runs through a one-time CLI command — `switchroom drive connect <agent>` — which opens the browser, captures the code via a local loopback redirect, exchanges it, and writes the **refresh token** into a vault slot like `gdrive:<agent_unit>:refresh_token`. Access tokens are short-lived and not persisted; the MCP server refreshes them on demand.
- The vault slot's ACL grants the agent's unit only. Same model as RFC A's bot-token slot.
- The MCP wrapper, on startup, reads the refresh token via the broker, exchanges for an access token, and holds the access token in process memory only.
- Token revocation: `switchroom drive disconnect <agent>` calls Google's revoke endpoint AND deletes the slot AND writes a `mcp:gdrive` audit row. The kernel's `/revoke-all` killswitch (§9.2 of RFC B) extends to call this for each Drive-connected agent.

## 4. First-run onboarding card

When the operator enables Drive for an agent, the kernel posts a one-time setup card before the first per-resource prompt fires.

```
🆕 Google Drive enabled for klanker. How should it access your Drive?

[ Allow all of Drive (less secure, fewer prompts) ]
[ Per-doc approval (default, more secure)         ]
```

**v1 ships exactly these two options.** A "Choose folders now" option was considered and dropped — it's the v1 anti-pattern in disguise: user grants narrow, then has to widen under prompt fatigue. Better to default to per-doc and let the user widen via `/approvals add` once they have a real feel for what's noisy.

The whole-Drive option writes a single `allow_always` row at scope `doc:gdrive:**`. The per-doc default writes nothing — every doc access goes through `requestApproval`.

## 5. Folder picker — deferred

A real Telegram-side folder picker (browse Drive, tap a folder, grant `doc:gdrive:folder/<id>/**`) lands in a **future RFC, not this one**. Until then, users widen via `/approvals add` post-grant if the per-doc default proves too noisy. The batch-coalescing behavior in §6 below softens the noise meaningfully in the meantime.

## 6. Scope-prefix batch coalescing

Per RFC B §11, the kernel buffers prompts for 5 seconds; if 3+ pending share a scope-prefix, it collapses into a single card. Drive is the first surface where this matters in practice.

Common pattern: an agent opens a folder, then reads 6 docs in it back-to-back. With per-doc approval, that's 6 prompts. With coalescing:

```
🔐 klanker is requesting access to 4 docs in /Work
"Q3 Strategy Notes", "Hiring plan", "Roadmap draft", "+1 more"
[ See all ]   [ ✅ Allow this folder ]   [ 🚫 Deny ]
[ ✅ Allow these 4 only ]
```

Tapping "Allow this folder" writes `allow_always` at `doc:gdrive:folder/<id>/**`. "Allow these 4 only" writes 4 `allow_once` rows. "Deny" denies all four; subsequent reads in the buffer window roll up into the same card.

The coalescing window is short (5s) so the user doesn't perceive lag — they see a single card a beat after the agent starts the burst.

## 7. Card UX details

- `humanize()` for `doc:gdrive:<id>` resolves the doc title via the MCP's metadata endpoint, with the 500ms render budget specified in RFC B §8.2.
- For folder scopes, `humanize()` resolves the folder path (e.g. `/Work/2026/Q3`).
- The expand row shows the raw scope string for verification, plus the "why this access" line the agent supplied.

## 8. Migration / rollout

1. Land the MCP wrapper code, vault slot for refresh tokens, and `switchroom drive connect|disconnect` commands.
2. Operator runs `switchroom drive connect klanker` (or whichever agent first).
3. Kernel posts the §4 onboarding card.
4. Normal usage begins.

The first week is the high-traffic window — 10–30 taps/day expected per RFC B §11. Steady state should drop under 5/day once the user has either chosen the whole-Drive option or accumulated enough folder-prefix grants via "Allow this folder" taps.

## 9. Effort

~1 day. MCP wrapper + OAuth onboarding + vault slot + onboarding card + the prefix-coalescing trigger living inside the kernel.

## 10. Out of scope

- **Folder picker UI** — separate future RFC.
- **Drive write operations** — same approval surface, but we'll start read-only and turn on writes once the read flow has real-world miles. Writes get their own scope namespace (e.g. `doc:gdrive:write:<id>`) so a read grant never silently authorizes a write.
- **Notion, Slack, Gmail wrappers** — same shape, separate RFCs as they come up.
- **Service-account auth** — sticks with per-user OAuth so approvals remain meaningful.
