# drive-write-approval — diagram spec

Status: new
Source of truth in code:
- `telegram-plugin/gateway/drive-write-approval.ts:10-23` — registers a kernel approval request at scope, returns kernel `request_id` + `expires_at`, hook polls
- `telegram-plugin/gateway/diff-preview-card.ts:2-17` — RFC E §4.2 renderer; emits `BuiltApprovalCard` with two scope buttons + reuses `apv:<request_id>:once`
- `src/drive/diff-preview.ts` — `buildDiffPreview()` (the rendered diff body)
- `telegram-plugin/gateway/approval-callback.ts` — Allow/Deny callback routing
- Reuses the kernel from `approval-grant-flow.spec.md` (do not draw a second kernel)

Headline: "Editing a Google Doc is a gated tool call too."
Footer:   "Same kernel, same TTL, same audit — a diff you approve before it lands in Drive."

## Nodes

1. `agent` · Drive write intent (MCP tool) · dark card
2. `approval kernel` · same singleton as approval-grant-flow — render with the *identical* card treatment, not a new component · plain, focal
3. `diff-preview card (Telegram)` · phone frame:
   - file name + rendered diff (`buildDiffPreview`)
   - **two scope buttons**: "Suggest edit" → grants `doc:gdrive:suggest:<id>`; "⚠ Apply directly" → grants `doc:gdrive:write:<id>` (the second hidden unless escalation is configured)
   - on grant: card gains an **"Open in Drive"** button
4. `Google Drive` · the write/suggestion lands · teal

## Edges

- 1 → 2 · "register kernel request @ scope, get request_id + expires_at" · primary-flow ①
- 2 → 3 · "post diff-preview card" · primary-flow ②
- 3 → 2 · "user taps one button (the other expires) — apv:<request_id>:once" · primary-flow ③
- 2 → 1 · "hook polls request_id → resumes / denies" · primary-flow ④
- 1 → 4 · "write or suggestion applied" · primary-flow ⑤
- 3 → 4 · "Open in Drive" · leader (post-grant button, not the flow)

## Style notes

Inherits v3. This is the sibling of `approval-grant-flow`: reuse its
kernel card 1:1 and the same ①②③④ step-color scheme so a reader sees
"Drive writes ride the existing approval rail." The only new surface is
the two-scope diff card (suggest vs apply-directly) + the Open-in-Drive
post-grant button. Callout 7 of `progress-card-anatomy` points here.
