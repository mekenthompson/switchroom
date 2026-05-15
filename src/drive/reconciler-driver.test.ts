/**
 * Tests for the reconciler driver loop — RFC E §4.4 follow-up.
 */

import { describe, expect, it } from "vitest";

import type {
  DriveFileMetadata,
  LastSeenSnapshot,
  ReconcilerVerdict,
} from "./reconciler.js";
import type { RecoveryAuditRow } from "./recovery.js";
import {
  type DriveGrant,
  type ReconcilerDriverDeps,
  runReconcilerTick,
} from "./reconciler-driver.js";

interface TickHarness {
  audit: RecoveryAuditRow[];
  nudges: Array<{ agent_unit: string; text: string }>;
  saves: Array<{ scope: string; verdict: ReconcilerVerdict; snapshot: LastSeenSnapshot }>;
  logs: string[];
}

function harness(): TickHarness {
  return { audit: [], nudges: [], saves: [], logs: [] };
}

function depsFor(args: {
  grants: DriveGrant[];
  fetched: Map<string, DriveFileMetadata | null | Error>;
  audit?: RecoveryAuditRow[];
  nudges?: Array<{ agent_unit: string; text: string }>;
  saves?: Array<{ scope: string; verdict: ReconcilerVerdict; snapshot: LastSeenSnapshot }>;
  logs?: string[];
  failSave?: Set<string>;
  failAudit?: Set<string>;
  failNudge?: Set<string>;
  /** Allow tests to override the iterable shape (e.g. async generator). */
  iterable?: () => AsyncIterable<DriveGrant> | Iterable<DriveGrant>;
}): ReconcilerDriverDeps {
  return {
    listDriveGrants: args.iterable ?? (() => args.grants),
    fetchDriveMeta: async (g) => {
      const r = args.fetched.get(g.scope);
      if (r instanceof Error) throw r;
      return r ?? null;
    },
    saveVerdict: async ({ grant, verdict, snapshot }) => {
      if (args.failSave?.has(grant.scope)) throw new Error("save failed");
      args.saves?.push({ scope: grant.scope, verdict, snapshot });
    },
    writeAuditRow: async (row) => {
      if (args.failAudit?.has(row.scope)) throw new Error("audit failed");
      args.audit?.push(row);
    },
    postChatNudge: async (n) => {
      if (args.failNudge?.has(n.agent_unit)) throw new Error("nudge failed");
      args.nudges?.push(n);
    },
    log: args.logs ? (m) => args.logs!.push(m) : undefined,
  };
}

const presentMeta: DriveFileMetadata = {
  id: "D1",
  name: "Q3 Strategy Notes",
  modifiedTime: "2026-05-15T01:00:00Z",
};

function grant(overrides: Partial<DriveGrant> = {}): DriveGrant {
  return {
    agent_unit: "klanker",
    scope: "doc:gdrive:D1",
    action: "read",
    last_verdict: null,
    last_seen: null,
    ...overrides,
  };
}

describe("runReconcilerTick — happy paths", () => {
  it("scans grants, fetches meta, saves the fresh verdict (no recovery on first tick)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [grant({ last_verdict: null })],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r).toEqual({ scanned: 1, skipped: 0, recoveries: 0, errors: 0 });
    expect(h.saves[0]?.verdict.state).toBe("present");
    expect(h.audit).toEqual([]);
    expect(h.nudges).toEqual([]);
  });

  it("fires recovery on missing→present transition", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "missing", reason: "trashed" },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.event).toBe("recover");
    expect(h.audit[0]?.scope).toBe("doc:gdrive:D1");
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]?.text).toContain("Q3 Strategy Notes");
    expect(h.nudges[0]?.text).toContain("pick up where I left off");
    expect(h.saves[0]?.verdict.state).toBe("present");
  });

  it("does NOT fire recovery on present→present (no transition)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "present", meta: presentMeta },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(0);
    expect(h.audit).toEqual([]);
  });

  it("does NOT fire recovery on present→missing (that's the loss event)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "present", meta: presentMeta },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", null]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(0);
    expect(h.saves[0]?.verdict.state).toBe("missing");
  });

  it("fires recovery on missing→conflict (restored but evolved)", async () => {
    const h = harness();
    const evolved: DriveFileMetadata = {
      ...presentMeta,
      modifiedTime: "2026-05-16T00:00:00Z",
    };
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "missing", reason: "trashed" },
          last_seen: {
            modifiedTime: "2026-05-10T00:00:00Z",
            contentHash: "h1",
          },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", evolved]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
    expect(h.saves[0]?.verdict.state).toBe("conflict");
  });
});

describe("runReconcilerTick — multi-grant + failure isolation", () => {
  it("walks multiple grants and counts per-category outcomes", async () => {
    const h = harness();
    const grants: DriveGrant[] = [
      grant({ scope: "doc:gdrive:D1" }),
      grant({
        scope: "doc:gdrive:D2",
        last_verdict: { state: "missing", reason: "not_found" },
      }),
      grant({ scope: "doc:gdrive:D3" }),
    ];
    const deps = depsFor({
      grants,
      fetched: new Map<string, DriveFileMetadata | null>([
        ["doc:gdrive:D1", { id: "D1", name: "doc1" }],
        ["doc:gdrive:D2", { id: "D2", name: "doc2 (un-trashed)" }],
        ["doc:gdrive:D3", null],
      ]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r).toEqual({ scanned: 3, skipped: 0, recoveries: 1, errors: 0 });
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]?.scope).toBe("doc:gdrive:D2");
  });

  it("fetch failure on one grant doesn't stop the rest of the tick", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({ scope: "doc:gdrive:D1" }),
        grant({ scope: "doc:gdrive:D2" }),
      ],
      fetched: new Map<string, DriveFileMetadata | null | Error>([
        ["doc:gdrive:D1", new Error("network blip")],
        ["doc:gdrive:D2", presentMeta],
      ]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.scanned).toBe(2);
    expect(r.errors).toBe(1);
    expect(h.saves.map((s) => s.scope)).toEqual(["doc:gdrive:D2"]);
  });

  it("audit-write failure still attempts the nudge (UX > strict audit)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "missing", reason: "trashed" },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
      failAudit: new Set(["doc:gdrive:D1"]),
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
    expect(r.errors).toBe(1);
    expect(h.audit).toEqual([]); // audit failed
    expect(h.nudges).toHaveLength(1); // but nudge fired
  });

  it("nudge failure leaves the audit row in place (audit is source-of-truth)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "missing", reason: "trashed" },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
      failNudge: new Set(["klanker"]),
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
    expect(h.audit).toHaveLength(1);
    expect(h.nudges).toEqual([]);
  });

  it("save-verdict failure surfaces in error count but doesn't block tick progress", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({ scope: "doc:gdrive:D1" }),
        grant({ scope: "doc:gdrive:D2" }),
      ],
      fetched: new Map<string, DriveFileMetadata | null>([
        ["doc:gdrive:D1", presentMeta],
        ["doc:gdrive:D2", presentMeta],
      ]),
      ...h,
      failSave: new Set(["doc:gdrive:D1"]),
    });
    const r = await runReconcilerTick(deps);
    expect(r.scanned).toBe(2);
    expect(r.errors).toBe(1);
    expect(h.saves.map((s) => s.scope)).toEqual(["doc:gdrive:D2"]);
  });
});

describe("runReconcilerTick — defense in depth", () => {
  it("skips grants whose scope doesn't parse as Drive", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [grant({ scope: "secret:OPENAI_API_KEY" })],
      fetched: new Map(),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r).toEqual({ scanned: 1, skipped: 1, recoveries: 0, errors: 0 });
    expect(h.saves).toEqual([]);
  });

  it("preserves prior last_seen on transient missing (doesn't reset the baseline)", async () => {
    const h = harness();
    const priorSnapshot: LastSeenSnapshot = {
      modifiedTime: "2026-05-10T00:00:00Z",
      contentHash: "h1",
    };
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "present", meta: presentMeta },
          last_seen: priorSnapshot,
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", null]]),
      ...h,
    });
    await runReconcilerTick(deps);
    // present→missing — verdict updates but snapshot persists so a
    // recovered doc gets compared against the OLD snapshot, not the
    // empty one a fresh-missing would have written.
    expect(h.saves[0]?.verdict.state).toBe("missing");
    // Snapshot field MUST equal the prior tick's snapshot, not be
    // blanked. This is the load-bearing claim of the transient-miss
    // path.
    expect(h.saves[0]?.snapshot).toEqual(priorSnapshot);
  });

  it("writes an empty snapshot {} on first-ever observation if Drive returns missing", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [grant({ last_verdict: null, last_seen: null })],
      fetched: new Map([["doc:gdrive:D1", null]]),
      ...h,
    });
    await runReconcilerTick(deps);
    expect(h.saves[0]?.snapshot).toEqual({});
    expect(h.saves[0]?.verdict.state).toBe("missing");
    expect(h.audit).toEqual([]); // no prior verdict → no recovery
  });

  it("writes the fresh remote snapshot on present", async () => {
    const h = harness();
    const meta: DriveFileMetadata = {
      id: "D1",
      name: "Q3",
      modifiedTime: "2026-05-15T01:00:00Z",
      mimeType: "application/vnd.google-apps.document",
      contentHash: "hABC",
    };
    const deps = depsFor({
      grants: [grant()],
      fetched: new Map([["doc:gdrive:D1", meta]]),
      ...h,
    });
    await runReconcilerTick(deps);
    expect(h.saves[0]?.snapshot).toEqual({
      modifiedTime: "2026-05-15T01:00:00Z",
      contentHash: "hABC",
      mimeType: "application/vnd.google-apps.document",
    });
  });

  it("missing→present after a transient miss recovers cleanly (snapshot preserved)", async () => {
    // Two ticks: present → missing (transient) → present (back).
    // The recovery on tick 2 fires because last_verdict was missing.
    const h = harness();
    const drift: DriveGrant = grant({
      last_verdict: { state: "missing", reason: "not_found" },
      last_seen: { modifiedTime: presentMeta.modifiedTime, contentHash: undefined },
    });
    const deps = depsFor({
      grants: [drift],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
  });
});

describe("runReconcilerTick — operator logging", () => {
  it("logs per-grant outcomes + a final summary line", async () => {
    const logs: string[] = [];
    const deps = depsFor({
      grants: [
        grant({
          last_verdict: { state: "missing", reason: "trashed" },
        }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      audit: [],
      nudges: [],
      saves: [],
      logs,
    });
    await runReconcilerTick(deps);
    expect(logs.some((l) => l.includes("recovered"))).toBe(true);
    expect(logs.some((l) => l.includes("done"))).toBe(true);
  });

  it("works with no log sink configured (silent mode)", async () => {
    const deps = depsFor({
      grants: [grant()],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
    });
    const r = await runReconcilerTick(deps);
    expect(r.scanned).toBe(1);
  });
});

describe("runReconcilerTick — iterator shapes + edge cases", () => {
  it("handles an empty grant list (no side-effects, scanned: 0)", async () => {
    const h = harness();
    const deps = depsFor({ grants: [], fetched: new Map(), ...h });
    const r = await runReconcilerTick(deps);
    expect(r).toEqual({ scanned: 0, skipped: 0, recoveries: 0, errors: 0 });
    expect(h.audit).toEqual([]);
    expect(h.saves).toEqual([]);
  });

  it("works with an async generator source", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      iterable: async function* () {
        yield grant({ scope: "doc:gdrive:D1" });
        yield grant({
          scope: "doc:gdrive:D2",
          last_verdict: { state: "missing", reason: "trashed" },
        });
      },
      ...h,
    });
    const deps2: ReconcilerDriverDeps = {
      ...deps,
      fetchDriveMeta: async (g) => {
        if (g.scope === "doc:gdrive:D1") return presentMeta;
        if (g.scope === "doc:gdrive:D2") return { id: "D2", name: "restored" };
        return null;
      },
    };
    const r = await runReconcilerTick(deps2);
    expect(r.scanned).toBe(2);
    expect(r.recoveries).toBe(1);
    expect(h.saves.map((s) => s.scope)).toEqual([
      "doc:gdrive:D1",
      "doc:gdrive:D2",
    ]);
  });

  it("handles folder scopes (parseDriveScope accepts the folder shape)", async () => {
    const h = harness();
    const folderMeta: DriveFileMetadata = {
      id: "F1",
      name: "Work folder",
      mimeType: "application/vnd.google-apps.folder",
    };
    const deps = depsFor({
      grants: [
        grant({
          scope: "doc:gdrive:folder/F1/**",
          last_verdict: { state: "missing", reason: "trashed" },
        }),
      ],
      fetched: new Map([["doc:gdrive:folder/F1/**", folderMeta]]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.skipped).toBe(0);
    expect(r.recoveries).toBe(1);
    expect(h.nudges[0]?.text).toContain("Work folder");
  });

  it("save-fail on a recovered grant: audit + nudge still fire (duplicate is acceptable next tick)", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [
        grant({ last_verdict: { state: "missing", reason: "trashed" } }),
      ],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      failSave: new Set(["doc:gdrive:D1"]),
      ...h,
    });
    const r = await runReconcilerTick(deps);
    expect(r.recoveries).toBe(1);
    expect(r.errors).toBe(1);
    expect(h.audit).toHaveLength(1);
    expect(h.nudges).toHaveLength(1);
    // Save failed → next tick's `last_verdict` is still "missing" →
    // recovery re-fires. Acceptable per RFC §4.4: better a duplicate
    // nudge than a silent swallow.
    expect(h.saves).toEqual([]);
  });

  it("logs + returns a partial summary when the iterator source throws mid-enumeration", async () => {
    const h = harness();
    const deps = depsFor({
      grants: [],
      fetched: new Map([["doc:gdrive:D1", presentMeta]]),
      iterable: async function* () {
        yield grant({ scope: "doc:gdrive:D1" });
        throw new Error("source-table connection dropped");
      },
      ...h,
    });
    const deps2: ReconcilerDriverDeps = {
      ...deps,
      fetchDriveMeta: async () => presentMeta,
    };
    const r = await runReconcilerTick(deps2);
    expect(r.scanned).toBe(1); // counted the one we got before the throw
    expect(r.errors).toBe(1);
    expect(h.saves).toHaveLength(1); // first grant processed cleanly
    // Tick still returns a summary instead of dying silently.
    expect(h.logs.some((l) => l.includes("iterator-source"))).toBe(true);
    expect(h.logs.some((l) => l.includes("done"))).toBe(true);
  });
});
