// Auto-wrap tool dispatch with a Telegram typing-indicator loop so the user
// sees a live "agent is working" signal during the 3–30s gap where the
// progress card is deliberately suppressed (its initialDelayMs is 3s).
// The first tool call on a given chat fires the typing loop immediately so
// there's no silent dead window before the progress card appears. Subsequent
// calls on the same chat honour the debounce to avoid churn.
// Surface tools own their own loop — see isSurfaceTool.

export interface TypingWrapperDeps {
  startTypingLoop: (chatId: string) => void
  stopTypingLoop: (chatId: string) => void
  isSurfaceTool: (toolName: string) => boolean
  debounceMs?: number
}

export interface TypingWrapper {
  onToolUse: (toolUseId: string, chatId: string, toolName: string) => void
  onToolResult: (toolUseId: string) => void
  drainAll: () => void
}

interface Entry {
  chatId: string
  timer: ReturnType<typeof setTimeout>
  started: boolean
}

export function createTypingWrapper(deps: TypingWrapperDeps): TypingWrapper {
  const debounceMs = deps.debounceMs ?? 500
  const pending = new Map<string, Entry>()
  // Track chats that already have an active typing loop so the first
  // tool call fires immediately while subsequent calls use the debounce.
  const activeChats = new Set<string>()

  return {
    onToolUse(toolUseId, chatId, toolName) {
      if (!toolUseId) return
      if (deps.isSurfaceTool(toolName)) return
      // Replace any pre-existing entry for the same id defensively.
      const prior = pending.get(toolUseId)
      if (prior) {
        clearTimeout(prior.timer)
        if (prior.started) deps.stopTypingLoop(prior.chatId)
        pending.delete(toolUseId)
      }
      // First tool on this chat: fire immediately rather than waiting for
      // the debounce — this closes the silent dead window before the first
      // progress card appears.
      if (!activeChats.has(chatId)) {
        deps.startTypingLoop(chatId)
        activeChats.add(chatId)
        const entry: Entry = {
          chatId,
          started: true,
          timer: setTimeout(() => {}, 0), // no-op sentinel
        }
        pending.set(toolUseId, entry)
        return
      }
      const entry: Entry = {
        chatId,
        started: false,
        timer: setTimeout(() => {
          deps.startTypingLoop(chatId)
          entry.started = true
        }, debounceMs),
      }
      pending.set(toolUseId, entry)
    },

    onToolResult(toolUseId) {
      if (!toolUseId) return
      const entry = pending.get(toolUseId)
      if (!entry) return
      clearTimeout(entry.timer)
      if (entry.started) {
        deps.stopTypingLoop(entry.chatId)
        activeChats.delete(entry.chatId)
      }
      pending.delete(toolUseId)
    },

    drainAll() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        if (entry.started) deps.stopTypingLoop(entry.chatId)
      }
      pending.clear()
      activeChats.clear()
    },
  }
}
