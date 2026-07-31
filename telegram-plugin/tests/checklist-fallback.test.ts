import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyChecklistPatch,
  initChecklistState,
  renderChecklistFallback,
  type ChecklistState,
} from '../checklist-fallback.js'

/**
 * send_checklist used to call Telegram's native `sendChecklist` with top-level
 * `title` / `tasks`, which returned `400: Bad Request: parameter "checklist"
 * is required`. Even a correctly-serialized `checklist` wrapper would then fail:
 * the official Bot API docs mark `sendChecklist` / `editMessageChecklist` as
 * "on behalf of a connected business account" with `business_connection_id`
 * Required:Yes — ordinary bots (every switchroom agent) cannot send them.
 *
 * The fix degrades DETERMINISTICALLY to a formatted GFM message. These tests
 * pin the OUTCOME: a checklist renders as a title + `- [ ]`/`- [x]` lines, and
 * an update patches that rendered state — the shape the gateway actually
 * delivers to a normal DM instead of throwing a raw 400.
 */
describe('checklist fallback rendering', () => {
  it('renders a title + one open/done line per task (the delivered message body)', () => {
    const state = initChecklistState('Release checklist', [
      { text: 'cut branch', done: true },
      { text: 'run tests' },
      { text: 'open PR', done: false },
    ])
    const body = renderChecklistFallback(state)
    expect(body).toBe(
      '**Release checklist**\n\n- [x] cut branch\n- [ ] run tests\n- [ ] open PR',
    )
  })

  it('renders title-only when there are no tasks', () => {
    expect(renderChecklistFallback({ title: 'Empty', tasks: [] })).toBe('**Empty**')
  })

  it('assigns sequential positive ids so update_checklist can target tasks', () => {
    const state = initChecklistState('t', [{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    expect(state.tasks.map(t => t.id)).toEqual([1, 2, 3])
  })
})

describe('checklist fallback patching (update_checklist)', () => {
  const base: ChecklistState = initChecklistState('Plan', [
    { text: 'design' },
    { text: 'build' },
  ])

  it('marks an existing task done by id and re-renders', () => {
    const next = applyChecklistPatch(base, { tasks: [{ id: '1', done: true }] })
    expect(renderChecklistFallback(next)).toBe('**Plan**\n\n- [x] design\n- [ ] build')
  })

  it('appends id-less tasks with fresh unique ids, preserving existing ids', () => {
    const next = applyChecklistPatch(base, { tasks: [{ text: 'ship' }] })
    expect(next.tasks.map(t => t.id)).toEqual([1, 2, 3])
    expect(next.tasks[2]).toMatchObject({ id: 3, text: 'ship', done: false })
  })

  it('updates the title without touching tasks', () => {
    const next = applyChecklistPatch(base, { title: 'Plan v2' })
    expect(renderChecklistFallback(next)).toBe('**Plan v2**\n\n- [ ] design\n- [ ] build')
  })

  it('renames an existing task by id', () => {
    const next = applyChecklistPatch(base, { tasks: [{ id: 2, text: 'implement' }] })
    expect(renderChecklistFallback(next)).toBe('**Plan**\n\n- [ ] design\n- [ ] implement')
  })

  it('degrades gracefully when prior state is unknown (post-restart)', () => {
    const next = applyChecklistPatch(undefined, {
      title: 'Recovered',
      tasks: [{ text: 'one', done: true }, { text: 'two' }],
    })
    expect(renderChecklistFallback(next)).toBe('**Recovered**\n\n- [x] one\n- [ ] two')
  })

  it('does not throw on an unknown id (treats it as an add, never a raw error)', () => {
    const next = applyChecklistPatch(base, { tasks: [{ id: '999', text: 'stray' }] })
    expect(next.tasks.map(t => t.text)).toContain('stray')
  })
})

/**
 * Regression guard on the WIRING — this is the assertion that would FAIL on the
 * pre-fix gateway. The old rawSendChecklist called the native
 * `_rawSendChecklist(...)` with top-level `title` / `tasks` (the 400 source).
 * The fix routes both raw fns through the rich-send fallback and never invokes
 * the native checklist methods at call time.
 */
describe('gateway checklist wiring — degrades instead of calling native API', () => {
  const src = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')

  function fnBody(name: string): string {
    const start = src.indexOf(`async function ${name}(`)
    expect(start).toBeGreaterThan(0)
    // Bounded slice — each raw fn is well under 2k chars.
    return src.slice(start, start + 2000)
  }

  it('rawSendChecklist renders the fallback and sends it via sendRichMessage', () => {
    const body = fnBody('rawSendChecklist')
    expect(body).toMatch(/renderChecklistFallback\(/)
    expect(body).toMatch(/sendRichMessage\(/)
    // The pre-fix 400 source — invoking the native raw method — must be gone.
    expect(body).not.toMatch(/_rawSendChecklist\s*as/)
  })

  it('rawEditMessageChecklist patches state and edits via editMessageText', () => {
    const body = fnBody('rawEditMessageChecklist')
    expect(body).toMatch(/applyChecklistPatch\(/)
    expect(body).toMatch(/renderChecklistFallback\(/)
    expect(body).toMatch(/editMessageText\(/)
    expect(body).not.toMatch(/_rawEditMessageChecklist\s*as/)
  })

  it('enforces the 30-task cap in the fallback path', () => {
    expect(fnBody('rawSendChecklist')).toMatch(/MAX_CHECKLIST_TASKS/)
    expect(src).toMatch(/const MAX_CHECKLIST_TASKS = 30/)
  })
})
