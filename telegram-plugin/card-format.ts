/**
 * Shared formatting utilities for Telegram status cards.
 *
 * Both the main-agent progress card (progress-card.ts) and the background
 * worker card (subagent-watcher.ts) import from here so duration strings,
 * HTML escaping, and truncation are byte-identical across both surfaces.
 *
 * Duration format: `<1s` for sub-second, `00:SS` for < 1 minute, `MM:SS`
 * for >= 1 minute. This is the format used by the main progress card and is
 * now the canonical format for all status cards.
 */

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `00:${s.toString().padStart(2, '0')}`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
