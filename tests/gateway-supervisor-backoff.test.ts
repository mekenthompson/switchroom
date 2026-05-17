import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// RFC J Phase 2: the _switchroom_supervise gateway supervisor must
// (a) preserve the EX_CONFIG=78 immediate-quarantine path, and
// (b) for every OTHER non-zero exit, back off exponentially and
//     retry INDEFINITELY (never permanently give up) so an agent
//     self-heals when a transient dependency (the vault-broker,
//     recreated+relocked by a routine `switchroom apply`) returns.
// Regression guard for install-validation 2026-05-17: the old
// "10 restarts in 60s -> give up forever" turned a broker recreate
// into a dead fleet until a human intervened.

const TEMPLATE = join(__dirname, "..", "profiles", "_base", "start.sh.hbs");

// Extract the pure-shell _switchroom_supervise function from the
// handlebars template (the function body contains no {{ }} tokens —
// asserted below so this test fails loudly if that ever changes).
function extractSupervisor(): string {
  const src = readFileSync(TEMPLATE, "utf-8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes("_switchroom_supervise() {"));
  expect(start, "_switchroom_supervise() not found in start.sh.hbs").toBeGreaterThanOrEqual(0);
  // Function ends at the first subsequent line that is exactly the
  // 2-space-indented closing brace.
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "  }") { end = i; break; }
  }
  expect(end, "closing brace of _switchroom_supervise not found").toBeGreaterThan(start);
  // De-indent two spaces so it's a valid top-level function.
  const fn = lines.slice(start, end + 1).map((l) => l.replace(/^ {2}/, "")).join("\n");
  expect(fn).not.toContain("{{"); // no handlebars inside the function
  return fn;
}

let dir: string;
let fnPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sup-test-"));
  // Shrink the 60s cap to 4s so exponential backoff (1,2,4,4) is
  // observable in a fast test without changing the logic under test.
  const fn = extractSupervisor().replace("local _cap=60", "local _cap=4");
  fnPath = join(dir, "sup.fn");
  writeFileSync(fnPath, fn);
});

function runBash(script: string, timeoutMs: number): string {
  const p = join(dir, `drv-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(p, `set -u\nsource ${JSON.stringify(fnPath)}\n${script}\n`);
  try {
    return execFileSync("bash", [p], { encoding: "utf-8", timeout: timeoutMs });
  } finally {
    rmSync(p, { force: true });
  }
}

describe("gateway supervisor — RFC J Phase 2 backoff", () => {
  it("exit 78 (EX_CONFIG) quarantines, returns 0, never retries", () => {
    const log = join(dir, "a.log");
    const out = runBash(
      `_switchroom_supervise tA ${JSON.stringify(log)} sh -c 'exit 78'; echo "RC=$?"`,
      10_000,
    );
    expect(out).toContain("RC=0");
    const l = readFileSync(log, "utf-8");
    expect(l).toContain("quarantined, not restarting");
    expect(l).not.toContain("retrying in");
  });

  it("transient non-zero exits back off exponentially and NEVER give up", () => {
    const log = join(dir, "b.log");
    // Supervisor in background; kill after ~9s (enough for attempts
    // 1..4 with delays 1+2+4 = 7s elapsed before attempt 4 logs).
    runBash(
      `_switchroom_supervise tB ${JSON.stringify(log)} sh -c 'exit 1' & SPID=$!
       sleep 9; kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; true`,
      20_000,
    );
    const l = readFileSync(log, "utf-8");
    expect(l).toContain("attempt=1) — retrying in 1s");
    expect(l).toContain("attempt=2) — retrying in 2s");
    expect(l).toContain("attempt=3) — retrying in 4s");
    expect(l).toContain("attempt=4) — retrying in 4s"); // capped at _cap
    expect(l).not.toMatch(/giving up|hit 10 restarts/i);
  }, 20_000);

  it("a run lasting >= cap resets the backoff (attempt back to 1)", () => {
    const log = join(dir, "c.log");
    const cnt = join(dir, "c.cnt");
    writeFileSync(cnt, "0");
    // 1st,2nd exits fast (attempt climbs to 3); 3rd run sleeps 5s
    // (>= cap 4) then exits — the NEXT failure must show attempt=1.
    runBash(
      `_switchroom_supervise tC ${JSON.stringify(log)} sh -c '
         n=$(cat ${JSON.stringify(cnt)}); n=$((n+1)); echo $n > ${JSON.stringify(cnt)}
         if [ $n -eq 3 ]; then sleep 5; fi
         exit 1' & SPID=$!
       sleep 14; kill "$SPID" 2>/dev/null; wait "$SPID" 2>/dev/null; true`,
      25_000,
    );
    const l = readFileSync(log, "utf-8");
    // The failure after the long (>=cap) run reports a long ran= and
    // attempt=1 (backoff was reset).
    expect(l).toMatch(/ran=[4-9][0-9]?s, attempt=1\)/);
  }, 30_000);
});
