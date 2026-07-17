// Outbound guard against accidental LINE-START BLOCK CONSTRUCTS (issue #3252,
// sibling of dollar-math-guard.ts).
//
// ── Root cause ───────────────────────────────────────────────────────────
// Since the Bot API 10.1 migration (#2669) every assistant reply is sent to
// Telegram as RAW GFM markdown via `sendRichMessage({ markdown })`. Telegram
// parses that markdown server-side with a CommonMark/GFM-family parser. That
// means a line of ordinary PROSE that merely happens to START with a markdown
// block-construct trigger (`#`, `>`, `-`/`+`/`*`, or `N.`) can be silently
// promoted to a heading / blockquote / bullet / ordered-list item the model
// never intended:
//   "> 50% of users"  → blockquote        ">2x faster" → blockquote
//   "# of items"      → heading           "#1 priority" → heading (live-proved)
//   "- 5 degrees"     → bullet            "2026. was a great year" → ol item
//
// ── Why this is the HARD, AMBIGUOUS guard family ─────────────────────────
// Unlike the `$…$` currency case (where math typesetting of a two-dollar span
// is NEVER wanted), the agent DELIBERATELY emits headings, bullets, ordered
// lists and blockquotes — Ken's rich-formatting directive treats them as a
// wanted feature. The SAME leading character means "format this" (intended)
// or "literal prose" (accidental) depending purely on authorial intent, which
// is not recoverable from the bytes. A blanket line-start escape would DESTROY
// intended formatting and is unacceptable. So this guard is deliberately
// CONSERVATIVE: it escapes ONLY the narrow sub-patterns that are unmistakably
// accidental and can be disambiguated DETERMINISTICALLY from the byte stream,
// and it leaves every plausibly-intended construct byte-for-byte untouched.
// Everything that cannot be made safe is DEFERRED (see the block comment on
// `escapeAccidentalLineStart` and guard-linestart-note.md), NOT guessed at.
//
// ── What this guard ACTUALLY escapes (the safe subset) ───────────────────
//   1. Blockquote comparison-operator: a line-start `>` glued DIRECTLY to a
//      digit or `=` (`>2x`, `>50%`, `>=3`). An INTENDED blockquote is always
//      written `> ` WITH a space; `>` glued to a digit/`=` is a "greater than"
//      comparison in prose, never a blockquote. Escaping only the no-space,
//      digit/`=`-adjacent form leaves every real `> quoted line` untouched.
//   2. Ordered-list with a 4+ digit "number": a line starting `2026. ` /
//      `1999) ` — i.e. a YEAR or other 4+ digit integer followed by `.`/`)`
//      and a space. No real numbered list is authored starting at item 2026;
//      4+ digit leading integers are effectively always accidental years/
//      quantities. Real lists (`1.`–`999.`) are LEFT ALONE.
//   3. GLUED heading hashes: a line-start (or list-item-content-start) run of
//      `#` glued DIRECTLY to a non-space character (`#3293`, `#word`,
//      `##3293`, `- #3293: …`, `1. #3293: …`). An INTENDED heading is always
//      written `# ` WITH a space. CommonMark would render the glued form
//      literally, but Telegram's rich-markdown parser is LAXER: a LIVE probe
//      (2026-07-17, Bot API sendRichMessage round-trip; full transcript in
//      guard-linestart-note.md) proved it promotes EVERY glued form — bare
//      line, bullet content, and ordered-item content alike — to a
//      `{type:"heading"}` block, EATING the `#`. This is the recorded
//      `- #3293: …` giant-H1 incident. The same probe proved `\#` renders a
//      literal `#` (backslash consumed), including inside list items, and
//      that a single `\` before the FIRST hash neutralises a multi-hash run
//      (`\##3293` → literal `##3293`). Because the guard must catch the
//      incident shape, this is the ONE arm that also looks past a leading
//      list-item marker (`- ` / `* ` / `+ ` / `1. ` / `42) `) — the other two
//      arms remain true-line-start only.
// All are backslash-escaped (`\>`, `2026\.`, `\#3293`) exactly like the dollar
// guard — `>`, `.`, `)`, `#` are ASCII punctuation, escapable per CommonMark's
// "any ASCII punctuation may be backslash-escaped" rule; Telegram's rich parser
// strips the backslash the same way `escapeMarkdown` relies on for `~ = | * _`
// (live-verified for `#`, see guard-linestart-note.md).
//
// ── What is DEFERRED (left to the rich-formatting workstream) ────────────
//   • Heading `# ` (with the required space): indistinguishable from an
//     INTENDED heading — headings are a wanted feature, so the spaced form is
//     never touched. (The GLUED `#x` form is guarded — arm 3 above.)
//   • Bullet lists `-`/`+`/`*` + space (`- 5 degrees`): genuinely ambiguous
//     with the heavily-used bullet construct; the glued form `-5` (no space)
//     is not a list item → already literal → no guard needed. Escaping the
//     spaced form would eat intended bullets, so the whole family is deferred.
//   • Ordered-list with 1–3 digit numbers (`1. `, `42. `): ambiguous with a
//     real numbered list. Decimals (`3.14`) have no space after the dot → not
//     a list item → already literal.
//
// ── Where this runs ──────────────────────────────────────────────────────
// Same seam as the dollar guard: `richMessage()` (rich-send.ts) — the ONE
// adapter every `{ markdown }` wire send funnels through. Integration of this
// function into that seam is done SEPARATELY by the integrator; this file only
// exports the pure transform + its helpers. `plain`-mode degradations bypass
// `richMessage` (no markdown parsing) and are correctly untouched.
//
// Idempotent: an already-escaped `\>` / `2026\.` no longer matches the
// accidental patterns (the leading char is now `\`), so re-running is a strict
// no-op. Code spans / fenced code blocks and 4-space indented code lines are
// NEVER touched.
//
// ── Telegram-parser assumptions and live evidence (see note) ─────────────
// Vitest cannot cover server-side Telegram rendering. The `>` / `2026.` arms
// rest on CommonMark analogy + the `escapeMarkdown` chars Telegram
// demonstrably strips. The `#` arm is stronger: pinned by a LIVE Bot API
// round-trip probe on 2026-07-17 (server-parsed `rich_message.blocks`
// inspected on the send response). Full transcript, the exact promotion rule,
// and the escape-consumption proof live in guard-linestart-note.md.

// Segment splitting is shared across all #3252 guards — one source of truth in
// render/code-segments.ts. `splitProtectedSegments` skips code spans/fences AND
// link destinations / autolinks / GFM table rows verbatim.
import { splitProtectedSegments } from "./code-segments.js";

/** Line-start `>` glued directly to a digit or `=` — the "greater than"
 *  comparison-operator prose that Telegram wrongly quotes. NOT matched when a
 *  space follows the `>` (that is an intended blockquote). */
const ACCIDENTAL_BLOCKQUOTE = /^>[0-9=]/;

/** Line-start 4+ digit integer followed by `.`/`)` then a space or end-of-line
 *  — a year/quantity Telegram wrongly promotes to an ordered-list item. Real
 *  lists (1–3 digit markers) are excluded by the `{4,}` bound. */
const ACCIDENTAL_ORDERED_LIST = /^(\d{4,})([.)])(\s|$)/;

/** A run of `#` glued DIRECTLY to a non-space, non-`#` character (`#3293`,
 *  `#word`, `##3293`). NOT matched when a space follows the hashes (that is an
 *  intended heading — headings are a wanted feature). Live-probed: Telegram
 *  promotes every glued form to a heading block, so the whole family is
 *  accidental. A single `\` before the FIRST hash neutralises the run. */
const ACCIDENTAL_HEADING = /^#+[^#\s]/;

/** An intended list-item marker: `-`/`+`/`*` or a 1–3 digit ordered marker
 *  (`1.` / `42)`), followed by at least one space. Telegram promotes a glued
 *  `#` at the START OF THE ITEM'S CONTENT to a heading INSIDE the list item
 *  (live-probed — the recorded `- #3293: …` incident), so the heading arm must
 *  look past this prefix. 4+ digit markers are excluded: those are themselves
 *  escaped by the ordered-list arm and are then no longer list items. */
const LIST_ITEM_MARKER = /^(?:[-+*]|\d{1,3}[.)]) +/;

/**
 * Escape the accidental block-construct trigger at the start of ONE line
 * (the string must NOT contain a newline). Applies only when the line is a
 * true line start (the caller guarantees this). A no-op unless the line begins
 * with one of the narrow, deterministically-accidental patterns above.
 *
 * Lines indented 4+ spaces are an indented-code context in CommonMark and are
 * left verbatim.
 */
function escapeAccidentalLineStart(line: string): string {
  const indent = /^ */.exec(line)![0];
  // 4+ leading spaces => indented code block; never a block construct here.
  if (indent.length >= 4) return line;
  const rest = line.slice(indent.length);

  // 1. Accidental blockquote (`>2x`, `>50%`, `>=3`). Idempotent: an already
  //    escaped `\>` starts with `\`, so `rest` no longer starts with `>`.
  if (ACCIDENTAL_BLOCKQUOTE.test(rest)) {
    return indent + "\\" + rest;
  }

  // 2. Accidental ordered-list from a 4+ digit number (`2026. was`).
  //    Idempotent: `2026\.` has a `\` where the delimiter was, so the
  //    `(\d{4,})([.)])` shape no longer matches.
  const ol = ACCIDENTAL_ORDERED_LIST.exec(rest);
  if (ol) {
    const digits = ol[1];
    const delim = ol[2];
    return indent + digits + "\\" + delim + rest.slice(digits.length + 1);
  }

  // 3. Accidental heading from glued hashes (`#3293 foo`, `#word`, `##3293`),
  //    at the line start OR at list-item-content start (`- #3293: …`,
  //    `1. #3293: …` — the recorded incident shape). Escaping the FIRST hash
  //    neutralises the whole run (live-verified). Idempotent: after escaping,
  //    the content starts with `\`, so `#+` no longer matches; an intended
  //    `# heading` (space after hashes) never matches at all.
  if (ACCIDENTAL_HEADING.test(rest)) {
    return indent + "\\" + rest;
  }
  const marker = LIST_ITEM_MARKER.exec(rest);
  if (marker) {
    const content = rest.slice(marker[0].length);
    if (ACCIDENTAL_HEADING.test(content)) {
      return indent + marker[0] + "\\" + content;
    }
  }

  return line;
}

/**
 * Neutralise accidental line-start block constructs (heading / blockquote /
 * bullet / ordered-list promotion of prose) on the FINAL rendered rich-markdown
 * string (post-`render`). CONSERVATIVE and deterministic: escapes ONLY the three
 * unmistakably-accidental patterns documented above and leaves all plausibly
 * intended formatting untouched. Code spans / fenced blocks / 4-space indented
 * code are never touched. Idempotent and a strict no-op absent a real signal.
 */
export function guardAccidentalBlockConstructs(text: string): string {
  // Cheap short-circuit: no `>`, no `#`, and no plausible 4+ digit list
  // marker => no-op.
  if (!text.includes(">") && !text.includes("#") && !/\d{4,}[.)]/.test(text)) {
    return text;
  }

  const segments = splitProtectedSegments(text);
  let out = "";
  // True at text start and immediately after any emitted `\n`.
  let atLineStart = true;

  for (const seg of segments) {
    if (seg.code) {
      out += seg.text;
      // Code spans never contain a newline; fenced blocks end on backticks, not
      // a newline. Either way the next char is on the same line unless the code
      // text itself ends with a newline.
      atLineStart = seg.text.endsWith("\n");
      continue;
    }
    const lines = seg.text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      // A prose segment can begin MID-LINE (right after an inline code span),
      // so its first line is a real line start only if the running flag says so.
      const lineIsAtStart = k === 0 ? atLineStart : true;
      const processed = lineIsAtStart ? escapeAccidentalLineStart(lines[k]) : lines[k];
      out += processed;
      if (k < lines.length - 1) out += "\n";
    }
    atLineStart = seg.text.endsWith("\n");
  }

  return out;
}
