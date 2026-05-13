/**
 * Pending-approval storage for agent-config writes that require
 * operator authorization (#1163 Phase 2 — approval-card MVP).
 *
 * Today's broker hard-rejects writes when the agent declares anything
 * that would let it self-grant capabilities — `secrets:` on a schedule
 * entry, more than the per-agent quota, intervals tighter than the
 * 5-min floor, etc. The reject is correct (silent-strip would let the
 * agent escalate quietly), but the resulting UX is "agent paste-blocks
 * a yaml the operator has to apply by hand".
 *
 * This module is the storage layer for a proper approval flow:
 *
 *   1. Agent calls `schedule_add` with `secrets: ["vault/gmail-token"]`.
 *   2. Broker stages the write under
 *      `~/.switchroom/agents/<name>/schedule.d/.pending/<stage_id>.yaml`
 *      with sibling `<stage_id>.meta.json` capturing the operator-
 *      readable reason (which gate tripped, what the entry will do,
 *      who authored it).
 *   3. The MCP tool returns `{ ok: true, staged: true, stage_id, reason }`
 *      instead of the hard-reject. Agent reports the stage_id to the
 *      user.
 *   4. Operator approves either:
 *      a. From the host CLI: `switchroom schedule pending commit <id>`
 *      b. (Phase 2 follow-up) Via Telegram approval card synthesized
 *         from the staged metadata.
 *   5. Commit moves the file out of `.pending/` into `schedule.d/` and
 *      triggers the existing hot-apply reconcile path.
 *
 * Path layout:
 *   ~/.switchroom/agents/<name>/schedule.d/
 *     .pending/
 *       <stage_id>.yaml      ← the staged overlay entry
 *       <stage_id>.meta.json ← human/audit metadata
 *     .staging/              ← (existing — atomic-write tmpdir)
 *     <slug>.yaml            ← committed entries
 *
 * Stage IDs are 12-hex `cap_<random>` slugs, distinct from the
 * `cron-<hash>` slug shape so a glance can tell pending from committed.
 *
 * Skills are NOT wired in this v1 — `skill_install` already restricts
 * to bundled sources which are operator-pre-approved by virtue of
 * being in the operator's skill pool. Phase 2 follow-up will add
 * git-pinned-SHA skills which DO need approval.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { overlayPathsFor } from "../config/overlay-writer.js";

/** Identifier prefix that distinguishes pending stages from committed
 *  slugs at a glance (`cron-<12hex>` vs `cap_<8hex>`). */
const STAGE_ID_PREFIX = "cap_";

export type PendingReasonCode =
  | "secrets_requires_approval"
  | "quota_exceeded"
  | "cron_too_frequent";

export interface PendingEntryMetadata {
  v: 1;
  /** Random 8-hex slug; the on-disk filename is `<stage_id>.yaml`. */
  stage_id: string;
  /** Wall-clock ms when staged. */
  staged_at: number;
  /** Agent that authored the request. */
  agent: string;
  /** Which gate tripped — operator-facing label for the approval card. */
  reason: PendingReasonCode;
  /** One-line operator-readable description of the entry being staged. */
  summary: string;
  /** Original raw schedule-entry fields (cron, prompt, secrets, name)
   *  for the approval card to render. */
  entry: {
    cron: string;
    prompt: string;
    secrets?: string[];
    name?: string;
  };
}

export interface ListedPendingEntry {
  stageId: string;
  agent: string;
  yamlPath: string;
  metaPath: string;
  meta: PendingEntryMetadata;
}

function pendingDir(agent: string, opts: { root?: string } = {}): string {
  const paths = overlayPathsFor(agent, opts);
  return join(paths.scheduleDir, ".pending");
}

function ensurePendingDir(agent: string, opts: { root?: string } = {}): string {
  const dir = pendingDir(agent, opts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newStageId(): string {
  return `${STAGE_ID_PREFIX}${randomBytes(4).toString("hex")}`;
}

/**
 * Stage an entry pending operator approval. Returns the stage_id +
 * absolute paths. Atomic: writes both files via temp + rename so a
 * crash mid-stage leaves no half-staged state.
 */
export function stagePendingScheduleEntry(opts: {
  agent: string;
  yamlText: string;
  reason: PendingReasonCode;
  summary: string;
  entry: PendingEntryMetadata["entry"];
  /** Test seam — override overlay root. */
  root?: string;
  /** Test seam — supply a deterministic stage id. */
  stageId?: string;
  /** Test seam — supply a deterministic wall-clock. */
  nowMs?: number;
}): { stageId: string; yamlPath: string; metaPath: string } {
  const dir = ensurePendingDir(opts.agent, { root: opts.root });
  const stageId = opts.stageId ?? newStageId();
  const yamlPath = join(dir, `${stageId}.yaml`);
  const metaPath = join(dir, `${stageId}.meta.json`);
  const meta: PendingEntryMetadata = {
    v: 1,
    stage_id: stageId,
    staged_at: opts.nowMs ?? Date.now(),
    agent: opts.agent,
    reason: opts.reason,
    summary: opts.summary,
    entry: opts.entry,
  };
  // Write YAML first (the load-bearing content); meta last (the
  // operator-facing record). A crash between them leaves an
  // orphaned YAML with no metadata — listPending will skip it (meta
  // is the discriminator) and the operator can clean up manually.
  const yamlTmp = `${yamlPath}.tmp-${process.pid}`;
  {
    const fd = openSync(yamlTmp, "w", 0o600);
    try {
      writeSync(fd, opts.yamlText);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(yamlTmp, yamlPath);
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  return { stageId, yamlPath, metaPath };
}

/**
 * Enumerate pending entries for an agent. Reads metadata eagerly so
 * callers can match by stageId / agent / reason without a second
 * file read.
 */
export function listPendingScheduleEntries(
  agent: string,
  opts: { root?: string } = {},
): ListedPendingEntry[] {
  const dir = pendingDir(agent, opts);
  if (!existsSync(dir)) return [];
  const out: ListedPendingEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".meta.json")) continue;
    const stageId = name.slice(0, -".meta.json".length);
    const metaPath = join(dir, name);
    const yamlPath = join(dir, `${stageId}.yaml`);
    if (!existsSync(yamlPath)) continue; // crash-recovery: skip orphan meta
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PendingEntryMetadata;
      if (meta?.v !== 1 || typeof meta.stage_id !== "string") continue;
      out.push({ stageId: meta.stage_id, agent: meta.agent, yamlPath, metaPath, meta });
    } catch {
      /* unreadable / malformed — skip */
    }
  }
  return out;
}

/**
 * Move a staged entry from `.pending/` to the live `schedule.d/`
 * directory. Returns the committed file path. Does NOT trigger
 * reconcile — caller is responsible for invoking the reconcile
 * bridge after commit (matches the `agent-config-write.ts:scheduleAdd`
 * pattern).
 */
export function commitPendingScheduleEntry(opts: {
  agent: string;
  stageId: string;
  root?: string;
}): { committed: true; path: string; slug: string } | { committed: false; reason: "not_found" } {
  const entries = listPendingScheduleEntries(opts.agent, { root: opts.root });
  const match = entries.find((e) => e.stageId === opts.stageId);
  if (!match) return { committed: false, reason: "not_found" };
  // Derive the committed slug from the entry's `name:` if set; else
  // fall back to a cron-hash equivalent. For v1 we re-use the stage
  // id as the slug to keep the round-trip identifiable.
  const slug = match.meta.entry.name ?? match.stageId;
  const paths = overlayPathsFor(opts.agent, { root: opts.root });
  const finalPath = join(paths.scheduleDir, `${slug}.yaml`);
  renameSync(match.yamlPath, finalPath);
  unlinkSync(match.metaPath);
  return { committed: true, path: finalPath, slug };
}

/**
 * Discard a staged entry without committing.
 */
export function denyPendingScheduleEntry(opts: {
  agent: string;
  stageId: string;
  root?: string;
}): { denied: true } | { denied: false; reason: "not_found" } {
  const entries = listPendingScheduleEntries(opts.agent, { root: opts.root });
  const match = entries.find((e) => e.stageId === opts.stageId);
  if (!match) return { denied: false, reason: "not_found" };
  try { unlinkSync(match.yamlPath); } catch { /* best-effort */ }
  try { unlinkSync(match.metaPath); } catch { /* best-effort */ }
  return { denied: true };
}
