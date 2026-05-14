/**
 * Drive `claude` interactively in a tmux session so a host operator
 * can produce a broader-scope `.credentials.json` that `claude
 * setup-token` can't mint. Used by `switchroom auth add <label>
 * --via-claude` (and the first-time setup wizard).
 *
 * Why this exists
 * ---------------
 * `claude setup-token` requests `scope=user:inference` only. That
 * scope is enough for `claude --print`-style one-shot inference, but
 * `claude --dangerously-load-development-channels server:…` (the mode
 * every switchroom agent runs in) refuses the resulting token at
 * boot and falls back to the "Select login method" TUI picker. The
 * picker mints the broader scope set
 * (`org:create_api_key user:profile user:inference
 * user:sessions:claude_code user:mcp_servers user:file_upload`) that
 * server: mode requires.
 *
 * RFC H's `auth add --from-oauth` was designed around `setup-token`'s
 * output, which means a fresh install runs into the scope mismatch
 * on first agent boot. This module is the install-validation fix:
 * spawn `claude` in a clean tmux pane, dispatch the well-known
 * keystroke sequence to land on the broader-scope OAuth URL, surface
 * the URL to the operator, accept the pasted code, and wait for
 * `<CLAUDE_CONFIG_DIR>/.credentials.json` to appear. The caller
 * (`src/cli/auth.ts:add`) then ingests it via the existing
 * `--from-credentials` codepath and registers it with the auth-
 * broker via `client.addAccount(...)`.
 *
 * No new OAuth code lives here — switchroom never speaks the
 * code-for-token exchange directly. Claude does it.
 *
 * Install-validation finding #38.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* ── Tmux primitives (single-session scope) ─────────────────────── */

/**
 * Session name we use for the auth REPL. One concurrent flow per host
 * operator. Re-running the verb while a stale session lingers kills
 * the old one (the operator can't usefully recover a half-completed
 * flow anyway — OAuth state-param won't match).
 */
const SESSION = "switchroom-via-claude";

/**
 * Polling intervals + budgets. Numbers are intentionally low at the
 * fine-grained end (URL render is fast; we want the operator to see
 * the URL within a couple of seconds) and forgiving at the coarse
 * end (network OAuth round-trip + Anthropic's server-side write of
 * credentials.json can take 10+ seconds in the wild).
 */
export const VIA_CLAUDE_DEFAULTS = {
  /** Max time to wait for the URL line to appear in the pane. */
  urlTimeoutMs: 20_000,
  /** Max time to wait for `.credentials.json` to appear post-paste. */
  credentialsTimeoutMs: 60_000,
  /** Pane poll interval. */
  pollMs: 500,
} as const;

export function tmuxHasSession(session: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", session], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

export function tmuxKillSession(session: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", session], {
      stdio: "ignore",
      timeout: 3000,
    });
  } catch {
    /* best-effort */
  }
}

function tmuxCapturePane(session: string): string {
  try {
    const out = execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", session, "-S", "-200"],
      { timeout: 3000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 },
    );
    return out.toString("utf8");
  } catch {
    return "";
  }
}

function tmuxSendKeys(session: string, keys: readonly string[], literal = false): void {
  try {
    execFileSync(
      "tmux",
      ["send-keys", "-t", session, ...(literal ? ["-l"] : []), ...keys],
      { timeout: 3000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    /* best-effort; caller decides what to do on no-progress */
  }
}

/* ── Pane parsing ───────────────────────────────────────────────── */

/**
 * The OAuth authorize URL claude emits after the operator picks
 * "Claude account with subscription" from the login picker. Matches
 * the two shapes Anthropic has shipped (legacy `claude.ai/oauth/...`
 * and current `claude.com/cai/oauth/...`).
 *
 * Exported so the auth/via-claude.test.ts smoke tests can pin the
 * regex against fixture pane captures.
 */
export function extractAuthorizeUrl(pane: string): string | null {
  // Strip CSI escapes; claude's TUI wraps the URL across multiple
  // lines and decorates it with \x1b[...m colour codes.
  const stripped = pane.replace(/\[[0-9;]*[A-Za-z]/g, "");
  const m = stripped.match(
    /https:\/\/claude\.(?:ai\/|com\/cai\/)oauth\/authorize\?[\s\S]*?(?=\n\s*\n|\n\s*Paste code here|$)/,
  );
  if (!m) return null;
  // Claude line-wraps long URLs across the terminal width. Collapse
  // whitespace so the operator can copy a single-line URL.
  return m[0].replace(/\s+/g, "");
}

/* ── Prompt-sequence dispatch ───────────────────────────────────── */

/**
 * Each rule fires at most once when its regex matches the current pane
 * snapshot. The sequence reflects what `claude` renders on a fresh
 * `CLAUDE_CONFIG_DIR` — first-time boot prompts in order:
 *
 *   1. Theme picker      → Enter (Auto)
 *   2. Login method      → Enter (Claude account with subscription)
 *   3. Browser-didn't-open URL display + "Paste code here" prompt
 *      → handled separately (operator paste; we don't auto-dispatch)
 *   4. (Post-paste) "Logged in as …" + "Press Enter to continue"
 *      → Enter
 *   5. Security notes "Press Enter to continue"
 *      → Enter
 *   6. REPL prompt — flow complete; we tear down.
 *
 * MCP-server trust does NOT appear because we run claude with the
 * default plugin dir (no per-agent .mcp.json under the account dir).
 */
export interface DispatchRule {
  name: string;
  match: RegExp;
  keys: readonly string[];
}

export const PRE_PASTE_RULES: readonly DispatchRule[] = [
  { name: "theme", match: /Choose.{1,30}text.{1,30}style/, keys: ["Enter"] },
  // Login method picker: option 1 = Claude account with subscription.
  // The picker may render the option line with various decorations;
  // matching the heading is enough to know we're here.
  { name: "login-method", match: /Select login method/, keys: ["Enter"] },
];

export const POST_PASTE_RULES: readonly DispatchRule[] = [
  { name: "logged-in", match: /Logged in as|Login successful/, keys: ["Enter"] },
  { name: "security-notes", match: /Security notes:/, keys: ["Enter"] },
];

/* ── The flow ───────────────────────────────────────────────────── */

export interface ViaClaudeOptions {
  /**
   * Where claude writes its `.credentials.json`. The CLI uses
   * `~/.switchroom/accounts/<label>/` so the file lands where the
   * existing `--from-credentials` ingest already looks.
   */
  configDir: string;
  /** Prompt callback: receive the URL, return the pasted code. */
  promptForCode: (url: string) => Promise<string>;
  /** Status callback (stdout writes by default). */
  log?: (line: string) => void;
  /** Overrides for tests. */
  urlTimeoutMs?: number;
  credentialsTimeoutMs?: number;
  pollMs?: number;
  /** Test seam — skip the actual tmux spawn (the test injects a fake pane). */
  spawnClaude?: () => void;
  capturePane?: () => string;
  sendKeys?: (keys: readonly string[], literal?: boolean) => void;
}

export interface ViaClaudeResult {
  /** Path to the credentials.json claude wrote. */
  credentialsPath: string;
  /** Parsed credentials body (caller hands this to the broker). */
  credentials: {
    claudeAiOauth: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      scopes?: string[];
      subscriptionType?: string;
    };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive claude through OAuth and return the credentials it wrote.
 * Throws on timeout at any phase; the CLI catches and surfaces an
 * actionable error.
 */
export async function runViaClaude(opts: ViaClaudeOptions): Promise<ViaClaudeResult> {
  const log = opts.log ?? ((s) => process.stdout.write(s + "\n"));
  const urlTimeout = opts.urlTimeoutMs ?? VIA_CLAUDE_DEFAULTS.urlTimeoutMs;
  const credsTimeout = opts.credentialsTimeoutMs ?? VIA_CLAUDE_DEFAULTS.credentialsTimeoutMs;
  const poll = opts.pollMs ?? VIA_CLAUDE_DEFAULTS.pollMs;

  const configDir = resolve(opts.configDir);
  mkdirSync(configDir, { recursive: true });
  const credentialsPath = join(configDir, ".credentials.json");

  const capture = opts.capturePane ?? (() => tmuxCapturePane(SESSION));
  const send = opts.sendKeys ?? ((keys: readonly string[], literal?: boolean) =>
    tmuxSendKeys(SESSION, keys, literal === true));

  // Wipe any lingering session before we start — re-runs of the verb
  // are common during onboarding (mistyped code, browser closed, etc.).
  if (!opts.spawnClaude) {
    if (tmuxHasSession(SESSION)) tmuxKillSession(SESSION);
  }

  const spawn = opts.spawnClaude ?? (() => {
    // Detached tmux session with claude as its only command. We don't
    // load any development channels here — we want the bare auth path
    // and the smallest possible prompt sequence.
    execFileSync(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x", "200",
        "-y", "50",
        "bash",
        "-lc",
        `CLAUDE_CONFIG_DIR=${quoteShell(configDir)} claude; echo EXITED; sleep 3600`,
      ],
      { stdio: "ignore", timeout: 5000 },
    );
  });

  log("  Spawning claude in a tmux session to mint a broader-scope OAuth token…");
  spawn();

  try {
    // Phase 1: dispatch the pre-paste prompts (theme, login method).
    const preFired = new Set<string>();
    const phase1Deadline = Date.now() + urlTimeout;
    let url: string | null = null;
    while (Date.now() < phase1Deadline) {
      await sleep(poll);
      const pane = capture();
      for (const rule of PRE_PASTE_RULES) {
        if (preFired.has(rule.name)) continue;
        if (rule.match.test(pane)) {
          preFired.add(rule.name);
          send(rule.keys);
        }
      }
      url = extractAuthorizeUrl(pane);
      if (url) break;
    }
    if (!url) {
      throw new Error(
        `Timed out (${Math.round(urlTimeout / 1000)}s) waiting for claude to render the OAuth URL. ` +
          `Re-run with --debug or attach to tmux session '${SESSION}' to see what happened.`,
      );
    }

    log("  Open this URL in any browser and complete the OAuth flow:");
    log("");
    log("    " + url);
    log("");

    const code = (await opts.promptForCode(url)).trim();
    if (!code) {
      throw new Error("Empty code; aborting.");
    }

    // Send the code literally (-l), then Enter.
    send([code], true);
    send(["Enter"]);

    // Phase 2: dispatch post-paste prompts (logged-in, security notes)
    // and poll for the credentials file to appear.
    const postFired = new Set<string>();
    const phase2Deadline = Date.now() + credsTimeout;
    log("  Waiting for credentials to land…");
    while (Date.now() < phase2Deadline) {
      await sleep(poll);
      if (existsSync(credentialsPath)) {
        // Read after a tiny settle to make sure claude's atomic write
        // completed before we ingest.
        await sleep(200);
        const raw = readFileSync(credentialsPath, "utf-8");
        let parsed: ViaClaudeResult["credentials"];
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          throw new Error(
            `claude wrote credentials.json but it didn't parse: ${(err as Error).message}`,
          );
        }
        if (typeof parsed.claudeAiOauth?.accessToken !== "string") {
          throw new Error(
            "credentials.json has no claudeAiOauth.accessToken — auth likely failed",
          );
        }
        return { credentialsPath, credentials: parsed };
      }
      const pane = capture();
      for (const rule of POST_PASTE_RULES) {
        if (postFired.has(rule.name)) continue;
        if (rule.match.test(pane)) {
          postFired.add(rule.name);
          send(rule.keys);
        }
      }
    }

    throw new Error(
      `Timed out (${Math.round(credsTimeout / 1000)}s) waiting for claude to write ` +
        `${credentialsPath}. Check the OAuth code was correct, or attach to tmux ` +
        `session '${SESSION}' to see the failure.`,
    );
  } finally {
    if (!opts.spawnClaude) {
      tmuxKillSession(SESSION);
    }
  }
}

/** Shell-quote a single argument for embedding in a bash -lc string. */
function quoteShell(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
