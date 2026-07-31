/**
 * Checklist fallback rendering + patch logic (pure).
 *
 * Telegram's native `sendChecklist` / `editMessageChecklist` are, per the
 * official Bot API docs, "on behalf of a connected business account" and
 * require a `business_connection_id` (Required: Yes). Ordinary bots — which is
 * what every switchroom agent runs — cannot send them to a normal DM; the API
 * rejects the call with `400: Bad Request: parameter "checklist" is required`
 * (and would then reject the missing business connection even if the
 * serialization were fixed). See https://core.telegram.org/bots/api#sendchecklist.
 *
 * So the checklist tools degrade DETERMINISTICALLY to a formatted GFM message:
 * a bold title followed by `- [ ]` / `- [x]` task lines. This module holds the
 * pure text-rendering and patch-application logic; the gateway wires it to the
 * rich-send path and tracks per-message state so `update_checklist` can patch
 * (add / rename / mark done) an existing fallback message.
 */

/** A single tracked checklist task in a rendered fallback message. */
export type ChecklistTask = {
  /** Positive, unique-within-the-checklist id used to target patches. */
  id: number
  text: string
  done: boolean
}

/** The full tracked state of one fallback checklist message. */
export type ChecklistState = {
  title: string
  tasks: ChecklistTask[]
}

/** Task shape accepted by `send_checklist`. */
export type InputTask = { text: string; done?: boolean }

/** Task-patch shape accepted by `update_checklist`. */
export type PatchTask = { id?: string | number; text?: string; done?: boolean }

/**
 * Build the initial tracked state from a `send_checklist` payload. Assigns
 * sequential positive ids (1..N) so `update_checklist` can later target tasks.
 */
export function initChecklistState(title: string, tasks: InputTask[]): ChecklistState {
  return {
    title,
    tasks: tasks.map((t, i) => ({ id: i + 1, text: t.text, done: t.done === true })),
  }
}

/**
 * Apply an `update_checklist` patch to prior state (or an empty checklist when
 * prior state is unknown, e.g. after a gateway restart).
 *
 * - `title` (when provided) replaces the title.
 * - Each patch task WITH an `id` targets the existing task with that id:
 *   `text` / `done` are updated when provided. An id that matches nothing is
 *   ignored (never throws — degradation stays graceful).
 * - Each patch task WITHOUT an `id` is appended as a new task, receiving a
 *   fresh id one greater than the current max (so ids stay unique + stable).
 *
 * This mirrors the documented native-checklist patch semantics ("tasks with an
 * id target existing items; tasks without an id are added; preserves ids").
 * Removal is expressed the native way — omit removed ids is NOT how the native
 * API works, so we keep the additive/mutating contract and do not delete.
 */
export function applyChecklistPatch(
  prev: ChecklistState | undefined,
  patch: { title?: string; tasks?: PatchTask[] },
): ChecklistState {
  const state: ChecklistState = prev
    ? { title: prev.title, tasks: prev.tasks.map(t => ({ ...t })) }
    : { title: '', tasks: [] }

  if (patch.title != null) state.title = patch.title

  if (patch.tasks != null) {
    let nextId = state.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1
    for (const pt of patch.tasks) {
      const idNum = pt.id != null ? Number(pt.id) : undefined
      if (idNum != null && Number.isFinite(idNum)) {
        const existing = state.tasks.find(t => t.id === idNum)
        if (existing) {
          if (pt.text != null) existing.text = pt.text
          if (pt.done != null) existing.done = pt.done === true
          continue
        }
        // Unknown id → treat as an add so the intent (a task) isn't dropped.
      }
      if (pt.text != null) {
        state.tasks.push({ id: nextId++, text: pt.text, done: pt.done === true })
      }
    }
  }

  return state
}

/**
 * Render a checklist state as a GFM message: a bold title followed by one
 * `- [ ]` (open) or `- [x]` (done) line per task. The gateway sends this
 * through the rich-message path (markdown-parsed), so the `**title**` renders
 * bold and the task lines render as a bulleted list.
 */
export function renderChecklistFallback(state: ChecklistState): string {
  const header = `**${state.title}**`
  const lines = state.tasks.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`)
  return state.tasks.length > 0 ? `${header}\n\n${lines.join('\n')}` : header
}

/** Outcome of planning an `update_checklist` edit against tracked state. */
export type ChecklistEditPlan =
  | { action: 'edit'; state: ChecklistState }
  | { action: 'state_lost' }

/**
 * Decide whether an `update_checklist` patch can be safely applied to a live
 * message, WITHOUT clobbering it.
 *
 * The tracked-state Map is in-memory only and gateway/agent restarts are
 * routine, so a patch can arrive for a message whose prior state we no longer
 * hold (`prev === undefined`). Editing from the patch alone would corrupt the
 * live checklist — the DOMINANT mark-done-only patch (`{id, done}`, no text)
 * reconstructs to an EMPTY checklist and renders the degenerate `****`, and
 * even a content patch would silently drop the message's untracked tasks. So on
 * a tracking miss (or any resulting empty/degenerate state) we refuse the edit
 * and signal the caller to resend, rather than destroy the user's checklist.
 */
export function planChecklistEdit(
  prev: ChecklistState | undefined,
  patch: { title?: string; tasks?: PatchTask[] },
): ChecklistEditPlan {
  if (prev === undefined) return { action: 'state_lost' }
  const state = applyChecklistPatch(prev, patch)
  if (state.title === '' && state.tasks.length === 0) return { action: 'state_lost' }
  return { action: 'edit', state }
}
