#!/usr/bin/env node
/**
 * Stop hook — reaps stale tool-label sidecar files.
 *
 * Removes $TELEGRAM_STATE_DIR/tool-labels-*.jsonl files older than 24h.
 * If more than 50 sidecar files exist, removes the oldest down to 50.
 * Always exits 0.
 *
 * Issue #783.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const MAX_SIDECARS = 50

function main() {
  const stateDir = process.env.TELEGRAM_STATE_DIR
  if (!stateDir || stateDir.length === 0) process.exit(0)

  let entries
  try {
    entries = readdirSync(stateDir)
  } catch {
    process.exit(0)
  }

  const now = Date.now()
  const sidecars = []
  for (const name of entries) {
    if (!name.startsWith('tool-labels-') || !name.endsWith('.jsonl')) continue
    const full = join(stateDir, name)
    try {
      const st = statSync(full)
      sidecars.push({ path: full, mtime: st.mtimeMs })
    } catch {
      // ignore
    }
  }

  // 1) Age-based reap
  for (const s of sidecars) {
    if (now - s.mtime > TWENTY_FOUR_HOURS_MS) {
      try { unlinkSync(s.path) } catch { /* ignore */ }
      s._removed = true
    }
  }

  // 2) Cap by count — drop oldest beyond MAX_SIDECARS
  const remaining = sidecars.filter((s) => !s._removed)
  if (remaining.length > MAX_SIDECARS) {
    remaining.sort((a, b) => a.mtime - b.mtime)
    const toDrop = remaining.length - MAX_SIDECARS
    for (let i = 0; i < toDrop; i++) {
      try { unlinkSync(remaining[i].path) } catch { /* ignore */ }
    }
  }

  process.exit(0)
}

main()
