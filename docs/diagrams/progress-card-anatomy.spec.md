# progress-card-anatomy — diagram spec

Status: needs-revision (cosmetic — concept is correct)
The committed `progress-card-anatomy.jpg` has two defects to fix on
regeneration; the card structure itself still matches the renderer.

Source of truth in code:
- `telegram-plugin/progress-card.ts` — pinned progress-card renderer
- `docs/telegram-plugin.md` (streaming-modes section) — header/footer semantics
- `telegram-plugin/gateway/diff-preview-card.ts` — the *sibling* card type (NOT a progress card)

Defects to correct:
1. **Typo**: callout text reads "In-flight row with filled **bollid**" →
   must read "filled **bullet**".
2. **Callout numbering**: current sequence is `1,2,3,4,3,6,9`
   (duplicate `3`, gaps). Renumber monotonically `1..7` in reading order.

Headline: (none — anatomy diagram, dark card centered)
Footer:   "One card per task. Updates in place. Nothing buried." (unchanged)

## Nodes

- One dark card (the v3 dark-card exception, `#14171C`, focal rotation)
  containing, top to bottom: quoted-user reply block · header row
  (phase · ⏱ elapsed · 🔧 tool count) · `PARENT (+N earlier)` rollup ·
  tool-call rows (open bullet) · in-flight row (filled bullet, bold) ·
  footer (📌 pin · timestamp).

## Callouts (renumbered, monotonic)

1. Quoted user message — reply style
2. Header: phase + elapsed timer + tool count
3. `PARENT (+N earlier)` — rolled-up ancestry
4. Typical tool-call row (open bullet)
5. In-flight row with **filled bullet** (bold)   ← fixes "bollid"
6. Footer: pin + timestamp
7. (new) The diff-preview approval card is a **separate** sibling card
   type, not a progress card — point at an inset thumbnail, link to
   `drive-write-approval.spec.md`. Keeps readers from conflating the two.

## Style notes

Inherits v3. No structural change to the card mock — only the typo,
the renumber, and the new callout 7 inset. Leader lines stay dotted
`--ink-300`, callout circles keep their role colors.
