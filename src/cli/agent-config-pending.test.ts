import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stagePendingScheduleEntry,
  listPendingScheduleEntries,
  commitPendingScheduleEntry,
  denyPendingScheduleEntry,
} from "./agent-config-pending.js";
import { scheduleAddOrStage, checkOperatorContext } from "./agent-config-write.js";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scp-"));
  savedEnv = process.env.SWITCHROOM_AGENT_NAME;
  process.env.SWITCHROOM_AGENT_NAME = "alice";
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
  else process.env.SWITCHROOM_AGENT_NAME = savedEnv;
});

describe("stagePendingScheduleEntry", () => {
  it("writes yaml + meta.json under .pending/", () => {
    const r = stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "schedule:\n  - cron: '0 9 * * *'\n    prompt: hi\n",
      reason: "secrets_requires_approval",
      summary: "test entry",
      entry: { cron: "0 9 * * *", prompt: "hi", secrets: ["v/k"] },
      root,
      stageId: "cap_deadbeef",
      nowMs: 1700000000000,
    });
    expect(r.stageId).toBe("cap_deadbeef");
    expect(existsSync(r.yamlPath)).toBe(true);
    expect(existsSync(r.metaPath)).toBe(true);
    const yaml = readFileSync(r.yamlPath, "utf-8");
    expect(yaml).toContain("prompt: hi");
    const meta = JSON.parse(readFileSync(r.metaPath, "utf-8"));
    expect(meta.v).toBe(1);
    expect(meta.stage_id).toBe("cap_deadbeef");
    expect(meta.reason).toBe("secrets_requires_approval");
    expect(meta.entry.secrets).toEqual(["v/k"]);
    expect(meta.staged_at).toBe(1700000000000);
  });

  it("creates the .pending/ dir on first stage", () => {
    const pending = join(root, "alice", "schedule.d", ".pending");
    expect(existsSync(pending)).toBe(false);
    stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "",
      reason: "quota_exceeded",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "p" },
      root,
    });
    expect(existsSync(pending)).toBe(true);
  });
});

describe("listPendingScheduleEntries", () => {
  it("returns [] when .pending/ does not exist", () => {
    expect(listPendingScheduleEntries("alice", { root })).toEqual([]);
  });

  it("lists all staged entries with metadata", () => {
    stagePendingScheduleEntry({ agent: "alice", yamlText: "a", reason: "secrets_requires_approval", summary: "one", entry: { cron: "0 9 * * *", prompt: "a" }, root, stageId: "cap_aaaa" });
    stagePendingScheduleEntry({ agent: "alice", yamlText: "b", reason: "quota_exceeded", summary: "two", entry: { cron: "0 10 * * *", prompt: "b" }, root, stageId: "cap_bbbb" });
    const list = listPendingScheduleEntries("alice", { root });
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.stageId).sort()).toEqual(["cap_aaaa", "cap_bbbb"]);
    expect(list.find((e) => e.stageId === "cap_aaaa")?.meta.summary).toBe("one");
  });

  it("skips orphan meta files (yaml missing)", () => {
    const pdir = join(root, "alice", "schedule.d", ".pending");
    stagePendingScheduleEntry({ agent: "alice", yamlText: "x", reason: "secrets_requires_approval", summary: "s", entry: { cron: "0 9 * * *", prompt: "x" }, root, stageId: "cap_zzz" });
    writeFileSync(join(pdir, "cap_orphan.meta.json"), JSON.stringify({ v: 1, stage_id: "cap_orphan", staged_at: 0, agent: "alice", reason: "quota_exceeded", summary: "s", entry: { cron: "0 9 * * *", prompt: "x" } }));
    const list = listPendingScheduleEntries("alice", { root });
    expect(list.map((e) => e.stageId)).toEqual(["cap_zzz"]);
  });

  it("skips malformed meta.json", () => {
    const pdir = join(root, "alice", "schedule.d", ".pending");
    stagePendingScheduleEntry({ agent: "alice", yamlText: "y", reason: "quota_exceeded", summary: "s", entry: { cron: "0 9 * * *", prompt: "y" }, root, stageId: "cap_good" });
    writeFileSync(join(pdir, "cap_bad.yaml"), "ignored");
    writeFileSync(join(pdir, "cap_bad.meta.json"), "{ not valid json");
    const list = listPendingScheduleEntries("alice", { root });
    expect(list.map((e) => e.stageId)).toEqual(["cap_good"]);
  });
});

describe("staged file permissions", () => {
  it("writes yaml + meta at 0600", () => {
    const r = stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "schedule:\n  - cron: '0 9 * * *'\n    prompt: x\n",
      reason: "secrets_requires_approval",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "x" },
      root,
      stageId: "cap_perm",
    });
    const yamlMode = statSync(r.yamlPath).mode & 0o777;
    const metaMode = statSync(r.metaPath).mode & 0o777;
    expect(yamlMode).toBe(0o600);
    expect(metaMode).toBe(0o600);
  });
});

describe("commitPendingScheduleEntry", () => {
  it("moves the yaml into schedule.d and removes meta", () => {
    const staged = stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "schedule:\n  - cron: '0 9 * * *'\n    prompt: morning\n",
      reason: "secrets_requires_approval",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "morning", name: "morning" },
      root,
      stageId: "cap_xy",
    });
    const r = commitPendingScheduleEntry({ agent: "alice", stageId: "cap_xy", root });
    expect(r.committed).toBe(true);
    if (!r.committed) return;
    expect(r.slug).toBe("morning");
    expect(existsSync(r.path)).toBe(true);
    expect(existsSync(staged.yamlPath)).toBe(false);
    expect(existsSync(staged.metaPath)).toBe(false);
  });

  it("returns not_found for unknown stage_id", () => {
    const r = commitPendingScheduleEntry({ agent: "alice", stageId: "cap_nope", root });
    expect(r.committed).toBe(false);
    if (r.committed) return;
    expect(r.reason).toBe("not_found");
  });

  it("refuses to clobber a live schedule.d entry with the same slug", () => {
    // Pre-seed a live entry under the chosen name
    const live = join(root, "alice", "schedule.d");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "morning.yaml"), "schedule:\n  - cron: '0 8 * * *'\n    prompt: live\n");
    stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "schedule:\n  - cron: '0 9 * * *'\n    prompt: staged\n",
      reason: "secrets_requires_approval",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "staged", name: "morning" },
      root,
      stageId: "cap_collide",
    });
    const r = commitPendingScheduleEntry({ agent: "alice", stageId: "cap_collide", root });
    expect(r.committed).toBe(false);
    if (r.committed) return;
    expect(r.reason).toBe("slug_collision");
    // Live file untouched
    const livePath = join(live, "morning.yaml");
    expect(readFileSync(livePath, "utf-8")).toContain("prompt: live");
    // Staged entry should still be there (operator can rename + retry)
    expect(existsSync(join(live, ".pending", "cap_collide.yaml"))).toBe(true);
  });

  it("falls back to stage_id as slug when entry has no name", () => {
    stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "schedule:\n  - cron: '0 9 * * *'\n    prompt: x\n",
      reason: "quota_exceeded",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "x" },
      root,
      stageId: "cap_noname",
    });
    const r = commitPendingScheduleEntry({ agent: "alice", stageId: "cap_noname", root });
    expect(r.committed).toBe(true);
    if (!r.committed) return;
    expect(r.slug).toBe("cap_noname");
  });
});

describe("denyPendingScheduleEntry", () => {
  it("removes both yaml and meta", () => {
    const staged = stagePendingScheduleEntry({
      agent: "alice",
      yamlText: "y",
      reason: "secrets_requires_approval",
      summary: "s",
      entry: { cron: "0 9 * * *", prompt: "p" },
      root,
      stageId: "cap_del",
    });
    const r = denyPendingScheduleEntry({ agent: "alice", stageId: "cap_del", root });
    expect(r.denied).toBe(true);
    expect(existsSync(staged.yamlPath)).toBe(false);
    expect(existsSync(staged.metaPath)).toBe(false);
  });

  it("returns not_found for unknown stage_id", () => {
    const r = denyPendingScheduleEntry({ agent: "alice", stageId: "cap_nope", root });
    expect(r.denied).toBe(false);
    if (r.denied) return;
    expect(r.reason).toBe("not_found");
  });
});

describe("checkOperatorContext (operator-only guard for pending verbs)", () => {
  it("refuses when SWITCHROOM_AGENT_NAME is set (agent-container signal)", () => {
    const r = checkOperatorContext("commit", { SWITCHROOM_AGENT_NAME: "alice" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("operator-only");
    expect(r.message).toContain("alice");
    expect(r.message).toContain("SWITCHROOM_OPERATOR=1");
  });

  it("allows when neither env var is set (operator host default)", () => {
    expect(checkOperatorContext("list", {}).ok).toBe(true);
  });

  it("allows SWITCHROOM_OPERATOR=1 override even when AGENT_NAME is set", () => {
    expect(
      checkOperatorContext("deny", {
        SWITCHROOM_AGENT_NAME: "alice",
        SWITCHROOM_OPERATOR: "1",
      }).ok,
    ).toBe(true);
  });

  it("treats empty SWITCHROOM_AGENT_NAME as unset (does not refuse)", () => {
    expect(checkOperatorContext("commit", { SWITCHROOM_AGENT_NAME: "" }).ok).toBe(true);
  });

  it("does NOT honor SWITCHROOM_OPERATOR values other than literal '1'", () => {
    // Hardening — if an attacker can set the env, they can also set
    // `SWITCHROOM_OPERATOR=1`. But narrow the check so accidental
    // `true` / `yes` / typo'd values don't bypass.
    const r = checkOperatorContext("commit", {
      SWITCHROOM_AGENT_NAME: "alice",
      SWITCHROOM_OPERATOR: "true",
    });
    expect(r.ok).toBe(false);
  });
});

describe("scheduleAddOrStage", () => {
  it("passes through happy-path adds (no staging)", () => {
    const r = scheduleAddOrStage({ cronExpr: "0 9 * * *", prompt: "ok", root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if ("staged" in r) {
      throw new Error("happy-path should not stage");
    }
    expect(r.slug).toMatch(/^cron-/);
  });

  it("stages secrets-bearing entries instead of rejecting", () => {
    const r = scheduleAddOrStage({
      cronExpr: "0 9 * * *",
      prompt: "needs key",
      secrets: ["v/k"],
      root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!("staged" in r)) throw new Error("expected staged result");
    expect(r.staged).toBe(true);
    expect(r.reason).toBe("secrets_requires_approval");
    expect(r.stage_id).toMatch(/^cap_/);
    expect(existsSync(r.yaml_path)).toBe(true);
    const meta = JSON.parse(readFileSync(r.yaml_path.replace(/\.yaml$/, ".meta.json"), "utf-8"));
    expect(meta.entry.secrets).toEqual(["v/k"]);
  });

  it("stages quota_exceeded entries instead of rejecting", () => {
    // Hit the cap (20) with vanilla adds, then a 21st should stage.
    for (let i = 0; i < 20; i++) {
      const r = scheduleAddOrStage({ cronExpr: `${i % 60} 9 * * *`, prompt: `p${i}`, root });
      expect(r.ok).toBe(true);
    }
    const r = scheduleAddOrStage({ cronExpr: "0 10 * * *", prompt: "overflow", root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!("staged" in r)) throw new Error("expected staged result");
    expect(r.reason).toBe("quota_exceeded");
    expect(r.stage_id).toMatch(/^cap_/);
  });

  it("stages too-frequent crons instead of rejecting", () => {
    const r = scheduleAddOrStage({ cronExpr: "* * * * *", prompt: "spammy", root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (!("staged" in r)) throw new Error("expected staged result");
    expect(r.reason).toBe("cron_too_frequent");
  });

  it("commit round-trip: stage → commit produces a live schedule.d entry", () => {
    const r = scheduleAddOrStage({
      cronExpr: "0 9 * * *",
      prompt: "needs key",
      secrets: ["v/k"],
      name: "morning-key",
      root,
    });
    if (!r.ok || !("staged" in r)) throw new Error("expected staged");
    const c = commitPendingScheduleEntry({ agent: "alice", stageId: r.stage_id, root });
    expect(c.committed).toBe(true);
    if (!c.committed) return;
    expect(c.slug).toBe("morning-key");
    const liveDir = join(root, "alice", "schedule.d");
    const files = readdirSync(liveDir).filter((f) => f.endsWith(".yaml"));
    expect(files).toContain("morning-key.yaml");
  });
});
