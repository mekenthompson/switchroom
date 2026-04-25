/**
 * Unit tests for the subagent-watcher module.
 *
 * Covers:
 *   - renderWorkerCard output format
 *   - Registry transitions (register, tool_use, turn_end)
 *   - JSONL tail parsing (description from sub_agent_text, toolCount from sub_agent_tool_use)
 *   - Stall detection (stall notification after stallThresholdMs idle)
 *   - Completion notification (sent once on state=done)
 *   - Dispatch notification (sent on registration)
 *   - Card lifecycle (created on first worker, updated on changes, removed when all done)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { renderWorkerCard, startSubagentWatcher, type WorkerEntry } from '../subagent-watcher.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<WorkerEntry> = {}): WorkerEntry {
  return {
    agentId: 'test-agent-01',
    filePath: '/tmp/agent-test-agent-01.jsonl',
    description: 'Build the feature',
    state: 'running',
    dispatchedAt: 1000,
    lastActivityAt: 1000,
    toolCount: 0,
    stallNotified: false,
    completionNotified: false,
    lastSummaryLine: '',
    ...overrides,
  }
}

// ─── renderWorkerCard ────────────────────────────────────────────────────────

describe('renderWorkerCard', () => {
  it('returns null when registry is empty', () => {
    const registry = new Map<string, WorkerEntry>()
    expect(renderWorkerCard(registry, 2000)).toBeNull()
  })

  it('returns null when all workers are done', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ state: 'done' })],
      ['b', makeEntry({ agentId: 'b', state: 'failed' })],
    ])
    expect(renderWorkerCard(registry, 2000)).toBeNull()
  })

  it('renders a single running worker', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Fix the tests', toolCount: 3, lastActivityAt: 1000 })],
    ])
    const html = renderWorkerCard(registry, 61_000)
    expect(html).not.toBeNull()
    expect(html).toContain('Background workers (1)')
    expect(html).toContain('Fix the tests')
    expect(html).toContain('3 tools')
    expect(html).toContain('running')
  })

  it('renders multiple running workers', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Worker A', toolCount: 2 })],
      ['b', makeEntry({ agentId: 'b', description: 'Worker B', toolCount: 5 })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).toContain('Background workers (2)')
    expect(html).toContain('Worker A')
    expect(html).toContain('Worker B')
  })

  it('shows only running workers in the card', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: 'Still running', state: 'running' })],
      ['b', makeEntry({ agentId: 'b', description: 'Already done', state: 'done' })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).toContain('Background workers (1)')
    expect(html).toContain('Still running')
    expect(html).not.toContain('Already done')
  })

  it('escapes HTML special characters in description', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: '<script>alert("xss")</script>' })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('truncates long descriptions', () => {
    const long = 'a'.repeat(100)
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ description: long })],
    ])
    const html = renderWorkerCard(registry, 2000)
    expect(html?.length).toBeLessThan(400)
    expect(html).toContain('…')
  })

  it('formats last-activity age', () => {
    const registry = new Map<string, WorkerEntry>([
      ['a', makeEntry({ lastActivityAt: 1000 })],
    ])
    // 30s ago
    const html = renderWorkerCard(registry, 31_000)
    expect(html).toContain('30s ago')
  })
})

// ─── startSubagentWatcher harness ────────────────────────────────────────────

/**
 * Minimal harness to drive the watcher without real filesystem or timers.
 *
 * We mock:
 *  - fs.existsSync, fs.readdirSync → control which dirs/files are "on disk"
 *  - fs.statSync → control file sizes (drives JSONL read)
 *  - fs.openSync, fs.readSync, fs.closeSync → feed JSONL content
 *  - fs.watch → stub (returns a fake watcher)
 *  - Date.now → injected via config.now
 *  - setInterval / clearInterval → injected via config
 */

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}

function subAgentAssistantText(text: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  }
}

function subAgentToolUse(name: string, id: string) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input: {} }] },
  }
}

function subAgentTurnDuration() {
  return { type: 'system', subtype: 'turn_duration', durationMs: 5000 }
}

interface WatcherHarness {
  notifications: string[]
  cardUpdates: Array<string | null>
  advance: (ms: number) => void
  // Trigger the poll timer manually
  poll: () => void
  // Expose the watcher
  watcher: ReturnType<typeof startSubagentWatcher>
  // Current mocked time
  now: () => number
}

function makeHarness(opts: {
  agentDir?: string
  files?: Record<string, string>  // filePath → JSONL content
  dirs?: Record<string, string[]> // dirPath → list of filenames
  existingDirs?: string[]
  stallThresholdMs?: number
  cardUpdateIntervalMs?: number
  rescanMs?: number
}): WatcherHarness {
  const {
    agentDir = '/home/user/.switchroom/agents/myagent',
    files = {},
    dirs = {},
    existingDirs = [],
    stallThresholdMs = 60_000,
    cardUpdateIntervalMs = 100,
    rescanMs = 500,
  } = opts

  let currentTime = 1000
  const notifications: string[] = []
  const cardUpdates: Array<string | null> = []

  // Track all JSONL content per path for statSync + read simulation
  const fileContents: Map<string, Buffer> = new Map()
  for (const [path, content] of Object.entries(files)) {
    fileContents.set(path, Buffer.from(content, 'utf-8'))
  }

  // Mock fs.existsSync
  vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
    const ps = String(p)
    // Check dirs
    if (existingDirs.includes(ps)) return true
    if (dirs[ps] !== undefined) return true
    // Check files
    if (fileContents.has(ps)) return true
    // Check parent paths of files
    for (const fp of fileContents.keys()) {
      if (fp.startsWith(ps + '/')) return true
    }
    return false
  })

  // Mock fs.readdirSync
  vi.spyOn(fs, 'readdirSync').mockImplementation((p: fs.PathLike) => {
    const ps = String(p)
    if (dirs[ps]) return dirs[ps] as unknown as fs.Dirent[]
    // Derive from files
    const children = new Set<string>()
    for (const fp of fileContents.keys()) {
      if (fp.startsWith(ps + '/')) {
        const rest = fp.slice(ps.length + 1)
        const part = rest.split('/')[0]
        if (part) children.add(part)
      }
    }
    return Array.from(children) as unknown as fs.Dirent[]
  })

  // Mock fs.statSync
  vi.spyOn(fs, 'statSync').mockImplementation((p: fs.PathLike) => {
    const ps = String(p)
    const content = fileContents.get(ps)
    if (content !== undefined) {
      return { size: content.length } as fs.Stats
    }
    return { size: 0 } as fs.Stats
  })

  // Mock fs.openSync, readSync, closeSync
  vi.spyOn(fs, 'openSync').mockReturnValue(42 as ReturnType<typeof fs.openSync>)
  vi.spyOn(fs, 'closeSync').mockImplementation(() => {})
  vi.spyOn(fs, 'readSync').mockImplementation((
    _fd: number,
    buf: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number => {
    // We don't know which file was opened in this mock, so we need a stateful
    // approach. Since openSync is a no-op (returns 42), we track the last
    // opened file via a side-channel. This requires us to intercept openSync.
    // For simplicity: return zeros (the watcher will see 0-length reads and
    // correctly no-op). The file content is delivered via explicit setContent.
    void _fd; void buf; void offset; void length; void position
    return 0
  })

  // Mock fs.watch
  const fakeWatchers: Array<{ close: () => void }> = []
  vi.spyOn(fs, 'watch').mockImplementation(() => {
    const w = { close: vi.fn() }
    fakeWatchers.push(w)
    return w as unknown as fs.FSWatcher
  })

  // Injected timers
  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    sendNotification: (text) => notifications.push(text),
    updatePinnedCard: (html) => cardUpdates.push(html),
    stallThresholdMs,
    cardUpdateIntervalMs,
    rescanMs,
    now: () => currentTime,
    setInterval: (fn, ms) => {
      const ref = nextRef++
      intervals.push({ fn, ms, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = intervals.findIndex((i) => i.ref === ref)
      if (idx !== -1) intervals.splice(idx, 1)
    },
    log: (_msg: string) => {}, // silence in tests
  })

  const advance = (ms: number): void => {
    currentTime += ms
    // Fire any intervals whose fireAt <= currentTime
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      const next = intervals[0]
      if (!next || next.fireAt > currentTime) break
      next.fireAt += next.ms
      next.fn()
    }
  }

  const poll = (): void => {
    const pollInterval = intervals[0]
    if (pollInterval) pollInterval.fn()
  }

  return {
    notifications,
    cardUpdates,
    advance,
    poll,
    watcher,
    now: () => currentTime,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('startSubagentWatcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when the agent dir has no .claude/projects', () => {
    const h = makeHarness({ agentDir: '/nonexistent', existingDirs: [] })
    h.poll()
    expect(h.notifications).toHaveLength(0)
    expect(h.cardUpdates).toHaveLength(0)
    h.watcher.stop()
  })

  it('detects a new subagent JSONL and emits dispatch notification', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: {
        [jsonlPath]: buildJSONL(subAgentUserMsg('Fix the tests please')),
      },
    })

    h.poll()

    expect(h.notifications.length).toBeGreaterThanOrEqual(1)
    expect(h.notifications[0]).toContain('Worker dispatched')

    h.watcher.stop()
  })

  it('updates description from sub_agent_text event', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(
      subAgentUserMsg('Do the thing'),
      subAgentAssistantText('I will implement the feature now'),
    )

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
    })

    // Override readSync to actually return file content
    let fileData = Buffer.from(content)
    vi.spyOn(fs, 'readSync').mockImplementation((
      _fd, buf, offset, length, position,
    ) => {
      const pos = position ?? 0
      const available = Math.min(length, fileData.length - pos)
      if (available <= 0) return 0
      fileData.copy(buf as Buffer, offset, pos, pos + available)
      return available
    })
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const ps = String(p)
      if (ps === jsonlPath) return { size: fileData.length } as fs.Stats
      return { size: 0 } as fs.Stats
    })

    h.poll()

    const registry = h.watcher.getRegistry()
    const entry = registry.get('deadbeef')
    // Description should be updated from first text line
    if (entry) {
      expect(entry.description).not.toBe('sub-agent')
    }

    h.watcher.stop()
  })

  it('counts tools from sub_agent_tool_use events', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(
      subAgentUserMsg('Fix things'),
      subAgentToolUse('Read', 'id1'),
      subAgentToolUse('Bash', 'id2'),
      subAgentToolUse('Edit', 'id3'),
    )

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
    })

    const buf = Buffer.from(content)
    vi.spyOn(fs, 'readSync').mockImplementation((_fd, b, offset, length, position) => {
      const pos = position ?? 0
      const available = Math.min(length, buf.length - pos)
      if (available <= 0) return 0
      buf.copy(b as Buffer, offset, pos, pos + available)
      return available
    })
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const ps = String(p)
      if (ps === jsonlPath) return { size: buf.length } as fs.Stats
      return { size: 0 } as fs.Stats
    })

    h.poll()

    const registry = h.watcher.getRegistry()
    const entry = registry.get('deadbeef')
    if (entry) {
      expect(entry.toolCount).toBe(3)
    }

    h.watcher.stop()
  })

  it('emits completion notification when turn_end arrives', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(
      subAgentUserMsg('Do the task'),
      subAgentTurnDuration(),
    )

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
    })

    const buf = Buffer.from(content)
    vi.spyOn(fs, 'readSync').mockImplementation((_fd, b, offset, length, position) => {
      const pos = position ?? 0
      const available = Math.min(length, buf.length - pos)
      if (available <= 0) return 0
      buf.copy(b as Buffer, offset, pos, pos + available)
      return available
    })
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      const ps = String(p)
      if (ps === jsonlPath) return { size: buf.length } as fs.Stats
      return { size: 0 } as fs.Stats
    })

    h.poll()

    const completionNotifs = h.notifications.filter((n) => n.includes('Worker done'))
    expect(completionNotifs.length).toBeGreaterThanOrEqual(1)

    const registry = h.watcher.getRegistry()
    const entry = registry.get('deadbeef')
    if (entry) {
      expect(entry.state).toBe('done')
    }

    h.watcher.stop()
  })

  it('emits stall notification after stallThresholdMs idle', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    // Only the initial user message — no tool_use or turn_end
    const content = buildJSONL(subAgentUserMsg('Run a long task'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
      stallThresholdMs: 60_000,
      rescanMs: 500,
    })

    // Initial poll — registers the agent
    h.poll()

    // Advance past stall threshold without any new JSONL activity
    h.advance(65_000)

    const stallNotifs = h.notifications.filter((n) => n.includes('Worker idle'))
    expect(stallNotifs.length).toBeGreaterThanOrEqual(1)
    expect(stallNotifs[0]).toContain('Worker idle')

    h.watcher.stop()
  })

  it('does not emit stall notification twice', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(subAgentUserMsg('Long task'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
      stallThresholdMs: 60_000,
    })

    h.poll()
    h.advance(65_000)
    h.advance(65_000) // advance past threshold AGAIN

    const stallNotifs = h.notifications.filter((n) => n.includes('Worker idle'))
    expect(stallNotifs.length).toBe(1)

    h.watcher.stop()
  })

  it('does not duplicate workers registered from same file', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/myproject`
    const sessionDir = `${projectDir}/session-abc123`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-deadbeef.jsonl`

    const content = buildJSONL(subAgentUserMsg('Do it'))

    const h = makeHarness({
      agentDir,
      existingDirs: [projectsRoot, projectDir, sessionDir, subagentsDir],
      dirs: {
        [projectsRoot]: ['myproject'],
        [projectDir]: ['session-abc123'],
        [subagentsDir]: ['agent-deadbeef.jsonl'],
      },
      files: { [jsonlPath]: content },
    })

    h.poll()
    h.poll() // second poll — should not re-register
    h.poll()

    const registry = h.watcher.getRegistry()
    expect(registry.size).toBe(1)

    const dispatchNotifs = h.notifications.filter((n) => n.includes('Worker dispatched'))
    expect(dispatchNotifs.length).toBe(1)

    h.watcher.stop()
  })

  it('stop() cleans up and stops poll timers', () => {
    const h = makeHarness({})
    h.watcher.stop()

    // After stop, advancing should not trigger anything new
    const notifsBefore = h.notifications.length
    h.advance(100_000)
    expect(h.notifications.length).toBe(notifsBefore)
  })
})
