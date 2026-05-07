# Switchroom Diagrams — Unified Design System (v3)

All three explanatory diagrams (`progress-card-anatomy`, `approval-grant-flow`,
`wake-audit-lifecycle`) MUST share these recipes so they read as a set.

## Canvas
- viewBox: `0 0 1200 800`
- Background: `#FAF7EF` (`--paper`)
- Inner padding: `48px` minimum on all edges
- Accent dots: 4× brass (`#E8B657`, r=4, opacity .55) at corners ~80px in;
  2× cord (`#C8302C`, r=3, opacity .5) at offset ~140px. Same coords across all three.

## Cards (the universal primitive)
- `rx = 14`, stroke `#EDE7D7` (`--bone-2`) `1.5px`, fill `#FFFFFF`
- Drop shadow filter `#cardShadow`: `dx=0 dy=6 stdDeviation=10 flood=#14171C opacity=0.18`
- Slight rotation per card: `-1.2°` for primary / focal, `+0.8°` for secondary,
  `-0.6°` for tertiary. Never axis-aligned.
- Dark-card exception (progress-card mock only): fill `#14171C`, otherwise identical
  recipe (same rx, same shadow, same rotation). It's a "guest" card on the light canvas.

## Numbered callouts
- Circle r=16 (32px diameter), `1.5px` stroke matching fill role
- Number font: Inter 700 13px, fill `#FAF7EF`
- Roles (strict):
  - **Brass** `#E8B657` fill = sequence step / numeric label
  - **Teal** `#4A9B8E` fill = success / grant / done
  - **Cord** `#C8302C` fill = pause / wait / warning

## Connecting lines
- **Primary flow arrow:** solid curved `#C8302C` (cord) `2.5px`, round caps,
  arrowhead `marker-end="url(#arrowCord)"`
- **Leader line (callout → label):** dotted `#8A8F98` (ink-300) `1.4px`,
  `stroke-dasharray="2 4"`, no arrowhead

## Icons
- One family: outlined, `1.5px` stroke `#23282F` (ink-700), round caps/joins, no fill.
- Sized at 20×20 inside a 24×24 box.

## Typography (one stack)
- Stack: `'Inter', system-ui, -apple-system, sans-serif`
- Mono (only inside card mocks): `'JetBrains Mono', ui-monospace, monospace`
- Sizes: heading `18px/700`, body `14px/500`, caption `11px/500 italic`
- Body fill `#23282F`, caption fill `#5A6069` (ink-400)

## Palette (exhaustive — no others)
`--paper #FAF7EF`, `--bone #F5F1E8`, `--bone-2 #EDE7D7`,
`--ink-900 #0E1013`, `--ink-700 #23282F`, `--ink-400 #5A6069`,
`--ink-300 #8A8F98`, `--ink-200 #B8BCC3`,
`--brass #E8B657`, `--brass-deep #B8873A`,
`--cord #C8302C`, `--teal #4A9B8E`. No gradients. No invented hues.
