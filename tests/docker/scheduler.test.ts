/**
 * Scheduler dispatch + audit tests with a mocked exec runner.
 *
 * Live `docker exec` against a real fleet is deferred to Phase 1b. Here
 * we validate the deterministic core: collectScheduleEntries, dispatch
 * argv shape, audit-row capture, error-path handling.
 */

import { describe, it, expect } from "vitest";
import {
  collectScheduleEntries,
  dispatchEntry,
  type ExecRunner,
  type SchedulerEntry,
} from "../../src/scheduler/dispatch.js";
import {
  InMemoryAuditSink,
  SCHEDULER_DB_DDL,
} from "../../src/scheduler/audit.js";
import { registerSchedule, pickSink, type CronLib } from "../../src/scheduler/index.js";
import { InMemoryAuditSink as _InMem, JsonlAuditSink as _Jsonl } from "../../src/scheduler/audit.js";
import { SqliteAuditSink } from "../../src/scheduler/audit-sqlite.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(scheduleByAgent: Record<string, Array<{ cron: string; prompt: string }>>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "x", skills_dir: "y" },
    telegram: { bot_token: "x" },
    agents: Object.fromEntries(
      Object.entries(scheduleByAgent).map(([name, schedule]) => [
        name,
        { schedule: schedule.map((s) => ({ ...s, secrets: [] })), tools: { allow: [], deny: [] } },
      ]),
    ),
  } as unknown as SwitchroomConfig;
}

describe("collectScheduleEntries", () => {
  it("flattens schedule[] in deterministic order (agent name asc, then index)", () => {
    const cfg = makeConfig({
      zebra: [{ cron: "0 8 * * *", prompt: "morning" }],
      alpha: [
        { cron: "*/15 * * * *", prompt: "tick" },
        { cron: "0 0 * * *", prompt: "midnight" },
      ],
    });
    const entries = collectScheduleEntries(cfg);
    expect(entries.map((e) => `${e.agent}#${e.scheduleIndex}`)).toEqual([
      "alpha#0", "alpha#1", "zebra#0",
    ]);
  });

  it("computes a 12-char promptKey from SHA-256", () => {
    const cfg = makeConfig({ a: [{ cron: "* * * * *", prompt: "hello" }] });
    const [entry] = collectScheduleEntries(cfg);
    expect(entry!.promptKey).toMatch(/^[0-9a-f]{12}$/);
  });

  it("handles agents with no schedule", () => {
    const cfg = makeConfig({ idle: [] });
    expect(collectScheduleEntries(cfg)).toEqual([]);
  });
});

describe("dispatchEntry", () => {
  const entry: SchedulerEntry = {
    agent: "klanker",
    scheduleIndex: 0,
    cron: "0 8 * * *",
    prompt: "morning briefing",
    promptKey: "abcdef123456",
  };

  it("invokes docker exec with the right argv shape", async () => {
    let captured: { args: string[]; stdin: string } | null = null;
    const runner: ExecRunner = async (args, stdin) => {
      captured = { args, stdin };
      return { exitCode: 0, output: "ok" };
    };
    await dispatchEntry(entry, runner);
    expect(captured!.args).toEqual(["exec", "-i", "agent-klanker", "claude", "-p"]);
    expect(captured!.stdin).toBe("morning briefing");
  });

  it("captures stdout/stderr into outputSummary, trimmed to 200 chars", async () => {
    const big = "x".repeat(500);
    const runner: ExecRunner = async () => ({ exitCode: 0, output: big });
    const r = await dispatchEntry(entry, runner);
    expect(r.outputSummary.length).toBe(200);
  });

  it("propagates non-zero exit codes", async () => {
    const runner: ExecRunner = async () => ({ exitCode: 42, output: "boom" });
    const r = await dispatchEntry(entry, runner);
    expect(r.exitCode).toBe(42);
  });
});

describe("registerSchedule", () => {
  it("registers one cron task per entry, calls the audit sink on fire", async () => {
    const cfg = makeConfig({ a: [{ cron: "* * * * *", prompt: "p1" }] });
    const entries = collectScheduleEntries(cfg);
    const sink = new InMemoryAuditSink();
    let firedHandler: (() => Promise<void>) | null = null;
    const stubCron: CronLib = {
      schedule: (_expr, handler) => {
        firedHandler = handler as () => Promise<void>;
        return { stop: () => {} };
      },
    };
    const runner: ExecRunner = async () => ({ exitCode: 0, output: "ran" });
    const tasks = registerSchedule({ entries, sink, cronLib: stubCron, runner });
    expect(tasks.length).toBe(1);
    expect(firedHandler).not.toBeNull();
    await firedHandler!();
    expect(sink.fires.length).toBe(1);
    expect(sink.fires[0]!.exitCode).toBe(0);
    expect(sink.fires[0]!.outputSummary).toBe("ran");
  });

  it("records dispatch errors in the audit log", async () => {
    const cfg = makeConfig({ a: [{ cron: "* * * * *", prompt: "p1" }] });
    const entries = collectScheduleEntries(cfg);
    const sink = new InMemoryAuditSink();
    let firedHandler: (() => Promise<void>) | null = null;
    const stubCron: CronLib = {
      schedule: (_e, h) => { firedHandler = h as () => Promise<void>; return { stop: () => {} }; },
    };
    const runner: ExecRunner = async () => { throw new Error("docker daemon down"); };
    registerSchedule({ entries, sink, cronLib: stubCron, runner });
    await firedHandler!();
    expect(sink.fires.length).toBe(1);
    expect(sink.fires[0]!.exitCode).toBe(-1);
    expect(sink.fires[0]!.outputSummary).toContain("docker daemon down");
  });
});

describe("pickSink (env-flag sink selection)", () => {
  it("returns InMemoryAuditSink when inMemory=true", () => {
    const sink = pickSink({ inMemory: true, sqliteDbPath: undefined, jsonlPath: "/dev/null" });
    expect(sink).toBeInstanceOf(_InMem);
  });
  it("returns SqliteAuditSink when sqliteDbPath is set (production telemetry path)", () => {
    // Use the stub-ctor injection so we don't need better-sqlite3 at the
    // repo root. Phase 1b scheduler image installs the native dep inside
    // the container; tests just verify the dispatch picked the SQLite branch.
    const stubCtor = function (_p: string) {
      return {
        exec(_sql: string) {},
        prepare(_sql: string) {
          return { run() { return { changes: 0, lastInsertRowid: 0 }; } };
        },
        close() {},
      };
    } as unknown as ConstructorParameters<typeof SqliteAuditSink>[0]["sqliteCtor"];
    const sink = pickSink({
      inMemory: false,
      sqliteDbPath: ":memory:",
      jsonlPath: "/dev/null",
      _testSqliteCtor: stubCtor,
    });
    expect(sink).toBeInstanceOf(SqliteAuditSink);
  });
  it("returns JsonlAuditSink as default", () => {
    const tmp = mkdtempSync(join(tmpdir(), "scheduler-pick-"));
    const sink = pickSink({
      inMemory: false,
      sqliteDbPath: undefined,
      jsonlPath: join(tmp, "fires.jsonl"),
    });
    expect(sink).toBeInstanceOf(_Jsonl);
  });
});

describe("SCHEDULER_DB_DDL", () => {
  it("declares the frozen schema columns the brief required", () => {
    for (const col of [
      "when_ms", "agent", "schedule_index", "prompt_key", "exit_code", "output_summary",
    ]) {
      expect(SCHEDULER_DB_DDL).toContain(col);
    }
    expect(SCHEDULER_DB_DDL).toContain("CREATE INDEX");
  });
});
