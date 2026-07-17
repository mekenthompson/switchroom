# guard-linestart-note — live Telegram-parser evidence for the line-start guards

This is the note `line-start-guard.ts` has referenced since the #3252 guards
shipped. It records the LIVE round-trip evidence for the Telegram-parser
assumptions the guard rests on — specifically the heading (`#`) arm, whose
original "Telegram renders `#1` literally" claim was an unverified CommonMark
analogy that a real incident disproved.

## The incident (why the `#` arm exists)

2026-07: an outbound reply containing

```
**Landing now**

- #3293: proxy-side 401s route to you as operator instead of hitting users with a bogus re-auth card
```

rendered the bullet's content as a **giant H1 heading** on the operator's
phone (gateway history.db message_id 19159; operator confirmed on-device,
19160/19163). The build had the #3252 guards live — they deliberately skipped
the `#` case on the assumption that `#`+non-space is not an ATX heading and
therefore renders literally. That assumption is FALSE for Telegram's
rich-markdown parser.

## Live probe — 2026-07-17

Method: real Bot API `sendRichMessage({ markdown })` round-trips (grammy
1.44 / Bot API 10.1) against Telegram production; the server-parsed
`rich_message.blocks` structure was read directly off each send RESPONSE (the
server returns the parsed block tree, so this is Telegram's own parse, not a
client-side re-parse). Probe messages were deleted after capture.

| # | Input (markdown) | Telegram server parse |
|---|---|---|
| 1 | `#3293 foo` | `{type:"heading", text:"3293 foo", size:1}` — **promoted**, `#` eaten |
| 2 | `- #3293: foo` | list item containing `{type:"heading", text:"3293: foo", size:1}` — **promoted inside the bullet** (the incident shape) |
| 3 | `#word probe` | `{type:"heading", text:"word probe", size:1}` — **promoted** (letters too, NOT a hashtag entity) |
| 4 | `# Real heading` | `{type:"heading", text:"Real heading", size:1}` — intended heading, works |
| 5 | `##3293 foo` | `{type:"heading", text:"3293 foo", size:2}` — multi-hash glued also promotes |
| 6 | `\#3293 foo` | `{type:"paragraph", text:"#3293 foo"}` — **backslash escapes, and is consumed** |
| 7 | `- \#3293: foo` | list item containing `{type:"paragraph", text:"#3293: foo"}` — escape works inside list content |
| 8 | `1. #3293: foo` | ordered item containing `{type:"heading", text:"3293: foo", size:1}` — **promoted inside ordered-item content** |
| 9 | `\##3293 foo` | `{type:"paragraph", text:"##3293 foo"}` — one `\` before the FIRST hash neutralises a multi-hash run |
| 10 | `#- foo` | `{type:"heading", text:"- foo", size:1}` — `#`+punctuation also promotes |
| 11 | `  - #3293: foo` | same as #2 — indented (1–3 spaces) bullet content also promotes |
| 12 | `1. \#3293: foo` | ordered item containing a paragraph `#3293: foo` — escape works there too |

Corroborating documentation: the Bot API 10.1 rich-markdown reference
(`@grammyjs/types` `rich.d.ts` syntax block) itself writes a line-start
hashtag example as `\#hashtag` — escaped — which is only necessary if an
unescaped line-start `#` is heading-promoted.

## The pinned rule

Telegram's rich-markdown parser promotes a run of `#` characters at the start
of a line **or at the start of a list item's content** to a heading block
regardless of whether a space follows — `#`+digit, `#`+letter, `#`+punctuation,
and multi-hash runs all promote. There is NO literal-rendering fallback for the
glued form (contra CommonMark, where ATX headings require `#`+space).

Escape semantics (live-verified): a single backslash before the first `#`
renders the entire hash run literally, and the backslash is consumed by the
parser — the reader sees exactly the original prose.

## What the guard therefore does (arm 3 of `line-start-guard.ts`)

- Escapes `#+` glued to a non-space character (`ACCIDENTAL_HEADING =
  /^#+[^#\s]/`) at a true line start (indent < 4).
- Applies the SAME check past a single list-item marker
  (`[-+*] ` / `1.`–`999.`/`)` + space), because the recorded incident was
  bullet-content, not line-start.
- Never touches `#`+space (`# Real heading` — headings are a wanted,
  intended-supported feature; probe row 4 confirms they render as intended).
- Never touches `#` mid-line, or inside code spans / fences / links / tables
  (inherited from `splitProtectedSegments`).
- Idempotent: after escaping, the content starts with `\`, which matches
  neither pattern.

## Status of the OTHER two arms' assumptions

The `>`+digit/`=` and `\d{4,}[.)]` arms still rest on CommonMark analogy plus
the escape-consumption behaviour Telegram demonstrably applies to
`escapeMarkdown`'s characters — now additionally corroborated for the
backslash-consumption half by probe rows 6/7/9/12 (`\#` consumed exactly as
predicted for `\>`/`\.`). A dedicated `>2x` / `2026. ` probe has not been run;
if one is added, record it here.
