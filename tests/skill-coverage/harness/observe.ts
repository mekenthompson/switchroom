/**
 * Tail an agent's active session JSONL and surface `SessionEvent`s as
 * an async iterator scoped to a single turn.
 *
 * Reuses `startSessionTail` from telegram-plugin/session-tail.ts —
 * that module already handles the cwd-sanitized projects-dir lookup,
 * incremental file reads, and rotation across sub-agent JSONLs. The
 * harness just needs:
 *
 *  1. start tailing,
 *  2. inject a probe,
 *  3. iterate events until `turn_end` (or timeout),
 *  4. extract Skill tool-uses + their `input.skill` field.
 */

import {
  startSessionTail,
  type SessionEvent,
} from "../../../telegram-plugin/session-tail.js";

export interface ObserveTurnOptions {
  /** Agent working directory (cwd) — feeds session-tail's project lookup. */
  cwd: string;
  /** Override CLAUDE_CONFIG_DIR; default: env or ~/.claude. */
  claudeHome?: string;
  /** Max wall-clock to wait for `turn_end`. Default 120_000 ms. */
  timeoutMs?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface TurnObservation {
  events: SessionEvent[];
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run a single turn observation. Returns once we've seen `turn_end`
 * OR the timeout elapses. Caller is responsible for calling
 * `inject` once `start()` returns.
 *
 * Usage:
 *   const obs = createTurnObserver({ cwd, timeoutMs: 30_000 });
 *   await obs.start();        // tail attached
 *   await injectInbound(...);
 *   const result = await obs.waitForTurnEnd();
 *   obs.stop();
 */
export interface TurnObserver {
  start(): Promise<void>;
  waitForTurnEnd(): Promise<TurnObservation>;
  stop(): void;
}

export function createTurnObserver(opts: ObserveTurnOptions): TurnObserver {
  const { cwd, claudeHome, timeoutMs = 120_000, log } = opts;
  const events: SessionEvent[] = [];
  let tail: ReturnType<typeof startSessionTail> | null = null;
  let resolveTurnEnd: ((obs: TurnObservation) => void) | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let sawTurnEnd = false;

  return {
    async start(): Promise<void> {
      startedAt = Date.now();
      tail = startSessionTail({
        cwd,
        claudeHome,
        log,
        onEvent: (ev) => {
          events.push(ev);
          if (ev.kind === "turn_end") {
            sawTurnEnd = true;
            if (resolveTurnEnd) {
              const r = resolveTurnEnd;
              resolveTurnEnd = null;
              if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
              }
              r({
                events: events.slice(),
                timedOut: false,
                durationMs: Date.now() - startedAt,
              });
            }
          }
        },
      });
    },
    waitForTurnEnd(): Promise<TurnObservation> {
      if (sawTurnEnd) {
        return Promise.resolve({
          events: events.slice(),
          timedOut: false,
          durationMs: Date.now() - startedAt,
        });
      }
      return new Promise<TurnObservation>((resolve) => {
        resolveTurnEnd = resolve;
        timeoutTimer = setTimeout(() => {
          resolveTurnEnd = null;
          timeoutTimer = null;
          resolve({
            events: events.slice(),
            timedOut: true,
            durationMs: Date.now() - startedAt,
          });
        }, timeoutMs);
      });
    },
    stop(): void {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (tail) {
        try { tail.stop(); } catch { /* ignore */ }
        tail = null;
      }
    },
  };
}

/**
 * Extract the list of skills invoked during a turn. The
 * telegram-plugin tool-label code documents `input.skill` as the
 * canonical field for Skill-tool invocations (see
 * `telegram-plugin/tool-labels.ts:247`). We honour that contract
 * here — falling through to the empty list if the field is absent.
 */
export function extractSkillsInvoked(events: SessionEvent[]): string[] {
  const skills: string[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    if (ev.toolName !== "Skill") continue;
    const input = ev.input as Record<string, unknown> | undefined;
    const skill = input?.skill;
    if (typeof skill === "string" && skill.length > 0) {
      skills.push(skill);
    }
  }
  return skills;
}
