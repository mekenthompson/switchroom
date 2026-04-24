import { execFileSync } from "node:child_process";

/**
 * Poll a tmux pane until it shows "Paste code here" (case-insensitive),
 * waiting up to `timeoutMs` milliseconds between attempts every `intervalMs`.
 *
 * Returns `{ ready: true }` as soon as the prompt is visible.
 * Returns `{ ready: false, reason: "session-gone" }` if the tmux session
 * can no longer be found.
 * Returns `{ ready: false, reason: "prompt-not-visible" }` if the timeout
 * expires before the prompt appears.
 */
export type PaneReadyResult =
  | { ready: true }
  | { ready: false; reason: "prompt-not-visible" | "session-gone" };

/**
 * Dependencies surface for unit testing without a real tmux process.
 */
export interface PaneReadyDeps {
  capturePane: (sessionName: string) => string | null;
  sleepMs: (ms: number) => void;
  nowMs: () => number;
}

export function defaultPaneReadyDeps(): PaneReadyDeps {
  return {
    capturePane(sessionName: string): string | null {
      try {
        return execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName, "-S", "-200"], {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    },
    sleepMs(ms: number): void {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    nowMs(): number {
      return Date.now();
    },
  };
}

/**
 * Returns true if `paneText` contains the "Paste code here" prompt that
 * `claude setup-token` emits after rendering the OAuth URL. Case-insensitive
 * to tolerate minor CLI wording changes.
 */
export function paneHasCodePrompt(paneText: string): boolean {
  return /paste code here/i.test(paneText);
}

/**
 * Polls the named tmux pane until "Paste code here" appears or the timeout
 * expires. Returns a `PaneReadyResult`.
 *
 * @param sessionName - tmux session/window/pane target (e.g. "switchroom-auth-foo")
 * @param timeoutMs   - maximum wait in milliseconds (default 5 000)
 * @param intervalMs  - poll interval in milliseconds (default 250)
 * @param deps        - injectable dependencies for unit testing
 */
export function probeForCodePrompt(
  sessionName: string,
  timeoutMs = 5_000,
  intervalMs = 250,
  deps: PaneReadyDeps = defaultPaneReadyDeps(),
): PaneReadyResult {
  const deadline = deps.nowMs() + timeoutMs;
  while (deps.nowMs() < deadline) {
    const paneText = deps.capturePane(sessionName);
    if (paneText === null) {
      // null means tmux returned an error — session is gone.
      return { ready: false, reason: "session-gone" };
    }
    if (paneHasCodePrompt(paneText)) {
      return { ready: true };
    }
    deps.sleepMs(intervalMs);
  }
  return { ready: false, reason: "prompt-not-visible" };
}
