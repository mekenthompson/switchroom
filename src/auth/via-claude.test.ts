import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractAuthorizeUrl,
  runViaClaude,
  PRE_PASTE_RULES,
  POST_PASTE_RULES,
} from "./via-claude.js";

describe("extractAuthorizeUrl", () => {
  it("extracts a wrapped URL from a real claude pane snapshot (claude.com/cai)", () => {
    const pane = `
 Browser didn't open? Use the url below to sign in (c to copy)

https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88
ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co
m%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainf
erence+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_
challenge=su2LvUxoYRoqzuPID7nQpVG_20ZpHusYIpc0LHcizXg&code_challenge_method=S256
&state=kJN-K2wyCgX47qj_mCUvBKi2XPstImxQfyV_vIwyPA4


 Paste code here if prompted >
`;
    const url = extractAuthorizeUrl(pane);
    expect(url).not.toBeNull();
    expect(url).toContain("https://claude.com/cai/oauth/authorize?");
    expect(url).toContain("scope=org%3Acreate_api_key");
    // Confirm the line-wrapping collapse worked — no whitespace inside.
    expect(url).not.toMatch(/\s/);
  });

  it("extracts the legacy claude.ai/oauth URL too", () => {
    const pane = "Browser didn't open? Use the URL: https://claude.ai/oauth/authorize?client_id=x&code=true\n\n Paste code here >";
    const url = extractAuthorizeUrl(pane);
    expect(url).not.toBeNull();
    expect(url).toContain("https://claude.ai/oauth/authorize?");
  });

  it("returns null when no URL is on the pane", () => {
    expect(extractAuthorizeUrl("just a theme picker here")).toBeNull();
    expect(extractAuthorizeUrl("")).toBeNull();
  });

  it("strips ANSI escape sequences around the URL", () => {
    const pane = "\x1b[31mhttps://claude.com/cai/oauth/authorize?x=1\x1b[0m\n\n Paste code here";
    const url = extractAuthorizeUrl(pane);
    expect(url).toBe("https://claude.com/cai/oauth/authorize?x=1");
  });
});

describe("PRE_PASTE_RULES + POST_PASTE_RULES sanity", () => {
  it("theme picker fires on the real claude header", () => {
    const rule = PRE_PASTE_RULES.find((r) => r.name === "theme")!;
    expect(rule.match.test("Choose the text style that looks best with your terminal")).toBe(true);
  });
  it("login method picker fires on the real heading", () => {
    const rule = PRE_PASTE_RULES.find((r) => r.name === "login-method")!;
    expect(rule.match.test("Select login method:")).toBe(true);
  });
  it("post-paste rules fire on the success/security panes", () => {
    const loggedIn = POST_PASTE_RULES.find((r) => r.name === "logged-in")!;
    expect(loggedIn.match.test("Logged in as me@example.com")).toBe(true);
    expect(loggedIn.match.test("Login successful. Press Enter to continue…")).toBe(true);

    const security = POST_PASTE_RULES.find((r) => r.name === "security-notes")!;
    expect(security.match.test("Security notes:")).toBe(true);
  });
});

describe("runViaClaude end-to-end (mocked tmux)", () => {
  /**
   * Simulates the pane lifecycle: starts empty, transitions through
   * theme picker → URL → logged-in → security → REPL. The test
   * harness also tracks send-keys and lazily materialises the
   * credentials file at the "right" moment (mid-poll, after the
   * operator's code has been "dispatched").
   */
  function makeFakeClaude(tmp: string) {
    const credsPath = join(tmp, ".credentials.json");
    const sent: Array<{ keys: readonly string[]; literal: boolean }> = [];
    let phase: "theme" | "login" | "url" | "logged-in" | "security" | "done" =
      "theme";
    let pollsSincePaste = 0;
    let codeSent = false;
    const pane = (): string => {
      switch (phase) {
        case "theme":
          return "Choose the text style that looks best with your terminal\n  1. Auto\n  2. Light";
        case "login":
          return "Select login method:\n  1. Claude account with subscription";
        case "url":
          return `Browser didn't open? Use the URL: https://claude.com/cai/oauth/authorize?scope=org%3Acreate_api_key+user%3Ainference&x=1\n\n Paste code here if prompted >`;
        case "logged-in":
          return "Logged in as me@example.com\nLogin successful. Press Enter to continue…";
        case "security":
          return "Security notes:\n  1. Claude can make mistakes\n\nPress Enter to continue…";
        case "done":
          return "  Welcome to Claude Code\n\n>";
      }
    };
    const send = (keys: readonly string[], literal?: boolean) => {
      sent.push({ keys, literal: literal === true });
      // Transition logic: every dispatched Enter advances one phase
      // in the canonical sequence.
      const enterCount = keys.filter((k) => k === "Enter").length;
      for (let i = 0; i < enterCount; i++) {
        if (phase === "theme") phase = "login";
        else if (phase === "login") phase = "url";
        else if (phase === "logged-in") phase = "security";
        else if (phase === "security") phase = "done";
      }
      // The literal code paste flips us into "logged-in" (mimics
      // claude's behaviour: code accepted → success screen).
      if (literal && keys.length === 1 && keys[0]!.includes("code-")) {
        codeSent = true;
        phase = "logged-in";
      }
    };
    const capture = () => {
      // After the code's been pasted and we've advanced into "logged-in",
      // materialise credentials.json on the second post-paste poll so
      // the poll-loop has a chance to also dispatch the post-paste
      // Enter rules before the file appears.
      if (codeSent) {
        pollsSincePaste++;
        if (pollsSincePaste === 2) {
          writeFileSync(
            credsPath,
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "sk-ant-oat01-fake",
                refreshToken: "rt-fake",
                expiresAt: Date.now() + 86_400_000,
                scopes: ["org:create_api_key", "user:profile", "user:inference"],
              },
            }),
          );
        }
      }
      return pane();
    };
    return { capture, send, sent };
  }

  it("walks the full flow and returns parsed credentials", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-via-claude-"));
    try {
      const fake = makeFakeClaude(tmp);
      const result = await runViaClaude({
        configDir: tmp,
        promptForCode: async (url) => {
          expect(url).toContain("https://claude.com/cai/oauth/authorize?");
          return "code-abc#state-xyz";
        },
        spawnClaude: () => {
          /* test seam — no real tmux */
        },
        capturePane: fake.capture,
        sendKeys: fake.send,
        pollMs: 5,
        urlTimeoutMs: 5_000,
        credentialsTimeoutMs: 5_000,
        log: () => {
          /* quiet in tests */
        },
      });

      expect(result.credentialsPath).toBe(join(tmp, ".credentials.json"));
      expect(result.credentials.claudeAiOauth.accessToken).toBe("sk-ant-oat01-fake");

      // Verify the send-keys sequence — theme Enter, login Enter,
      // literal code, Enter to submit, logged-in Enter, security Enter.
      const flat = fake.sent.map((s) => ({ literal: s.literal, keys: s.keys.join("|") }));
      const enters = flat.filter((s) => s.keys === "Enter").length;
      expect(enters).toBeGreaterThanOrEqual(3);
      const codeSends = flat.filter((s) => s.literal);
      expect(codeSends).toHaveLength(1);
      expect(codeSends[0]!.keys).toBe("code-abc#state-xyz");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects when promptForCode returns empty string", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-via-claude-empty-"));
    try {
      // Pane just gets stuck at the URL screen; no progression. We
      // bail on the empty code paste before any timeout.
      let phase: "theme" | "login" | "url" = "theme";
      const capture = () => {
        const s = phase;
        if (phase === "theme") phase = "login";
        else if (phase === "login") phase = "url";
        return s === "theme"
          ? "Choose the text style that looks best with your terminal"
          : s === "login"
            ? "Select login method:"
            : "https://claude.com/cai/oauth/authorize?scope=x&y=1\n\n Paste code here";
      };
      await expect(
        runViaClaude({
          configDir: tmp,
          promptForCode: async () => "   ",
          spawnClaude: () => undefined,
          capturePane: capture,
          sendKeys: () => undefined,
          pollMs: 5,
          urlTimeoutMs: 1_000,
          credentialsTimeoutMs: 1_000,
          log: () => undefined,
        }),
      ).rejects.toThrow(/Empty code/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("times out cleanly when claude never renders the URL", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-via-claude-timeout-"));
    try {
      await expect(
        runViaClaude({
          configDir: tmp,
          promptForCode: async () => "irrelevant",
          spawnClaude: () => undefined,
          capturePane: () => "stuck forever",
          sendKeys: () => undefined,
          pollMs: 5,
          urlTimeoutMs: 100,
          credentialsTimeoutMs: 100,
          log: () => undefined,
        }),
      ).rejects.toThrow(/Timed out.*OAuth URL/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
