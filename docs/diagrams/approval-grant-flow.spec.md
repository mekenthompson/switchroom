# approval-grant-flow — diagram spec

Status: current (verified accurate — no regeneration needed)
Captured so the diagram set is fully spec-backed and so
`drive-write-approval` can link its kernel reuse here.

Source of truth in code:
- `src/vault/approvals/schema.ts`, `kernel.ts` — SQLite-backed grant store
- `src/vault/approvals/kernel-server.ts` — per-agent UDS IPC
- `src/vault/approvals/acl.ts` — TTL'd grants, one-off vs always scope
- `src/agents/compose.ts:898` — `approval-kernel` singleton service

Headline: "Every gated tool call. User-confirmed in Telegram. TTL'd. Audited."
Footer:   (none)

## Nodes

1. `agent · claude REPL` · "Paused — awaiting approval" mock (Tool/File/Diff/Status) · dark card
2. `approval kernel` · "SQLite + IPC broker" · grant table (id/tool/state/ttl) · plain, focal
   - caption: "Grants are TTL'd. One-off allow does not silently become forever."
3. `your phone (Telegram)` · approval card mock: `@worker wants to edit`, diff, **Allow / Deny**, scope chips "this call · ttl 15m · always" · phone frame

## Edges

- 1 → 2 · "1 — agent → kernel: tool call" · primary-flow (brass step ①)
- 2 → 3 · "2 — kernel → phone: pause and push approval card" · primary-flow (cord step ②)
- 3 → 2 · "3 — phone → kernel: user taps allow" · primary-flow (cord step ③)
- 2 → 1 · "4 — kernel → agent: tool resumes" · primary-flow (teal step ④)

## Style notes

Inherits v3. Verified still accurate as of this spec. The Drive write
path (`drive-write-approval.spec.md`) reuses this exact kernel + the
`apv:<request_id>:once` callback — keep both diagrams visually
consistent (same kernel card treatment, same step-numbering colors).
