/**
 * Tests for recovery wiring helpers — RFC E §4.4.
 */

import { describe, expect, it } from "vitest";

import type { RecoveryEvent } from "./reconciler.js";
import {
  buildRecoveryArtifacts,
  buildRecoveryAuditRow,
  buildRecoveryDigestLine,
  buildRecoveryNudge,
} from "./recovery.js";

function event(overrides: Partial<RecoveryEvent> = {}): RecoveryEvent {
  return {
    recovered: true,
    fromReason: "trashed",
    toState: "present",
    meta: {
      id: "DOC1",
      name: "Q3 Strategy Notes",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: "2026-05-14T12:00:00Z",
    },
    ...overrides,
  } satisfies RecoveryEvent;
}

describe("buildRecoveryAuditRow", () => {
  it("emits an event=recover row with the right scope + action + context", () => {
    const row = buildRecoveryAuditRow({
      event: event(),
      agent_unit: "klanker",
      scope: "doc:gdrive:DOC1",
      action: "read",
    });
    expect(row.event).toBe("recover");
    expect(row.agent_unit).toBe("klanker");
    expect(row.scope).toBe("doc:gdrive:DOC1");
    expect(row.action).toBe("read");
    const ctx = JSON.parse(row.context);
    expect(ctx).toEqual({
      from_reason: "trashed",
      to_state: "present",
      meta: {
        id: "DOC1",
        name: "Q3 Strategy Notes",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-05-14T12:00:00Z",
      },
    });
  });

  it("preserves missing→conflict transitions in to_state", () => {
    const row = buildRecoveryAuditRow({
      event: event({ toState: "conflict" }),
      agent_unit: "klanker",
      scope: "doc:gdrive:DOC1",
      action: "read",
    });
    expect(JSON.parse(row.context).to_state).toBe("conflict");
  });

  it("preserves not_found vs trashed in from_reason", () => {
    const row = buildRecoveryAuditRow({
      event: event({ fromReason: "not_found" }),
      agent_unit: "klanker",
      scope: "doc:gdrive:DOC1",
      action: "read",
    });
    expect(JSON.parse(row.context).from_reason).toBe("not_found");
  });

  it("normalises missing meta fields to null in the context", () => {
    const row = buildRecoveryAuditRow({
      event: event({
        meta: { id: "DOC1" },
      }),
      agent_unit: "klanker",
      scope: "doc:gdrive:DOC1",
      action: "read",
    });
    const ctx = JSON.parse(row.context);
    expect(ctx.meta).toEqual({
      id: "DOC1",
      name: null,
      mimeType: null,
      modifiedTime: null,
    });
  });
});

describe("buildRecoveryDigestLine", () => {
  it("matches the RFC §4.4 wording", () => {
    expect(buildRecoveryDigestLine(event())).toBe("↻ 'Q3 Strategy Notes' is back");
  });

  it("falls back to the file id when name is missing", () => {
    expect(
      buildRecoveryDigestLine(event({ meta: { id: "DOC42" } })),
    ).toBe("↻ 'DOC42' is back");
  });
});

describe("buildRecoveryNudge", () => {
  it("matches the RFC §4.4 wording verbatim", () => {
    expect(buildRecoveryNudge(event())).toBe(
      "↻ 'Q3 Strategy Notes' is back — let me know if you want me to pick up where I left off.",
    );
  });

  it("falls back to the file id when name is missing", () => {
    expect(
      buildRecoveryNudge(event({ meta: { id: "DOC42" } })),
    ).toContain("'DOC42'");
  });
});

describe("buildRecoveryArtifacts", () => {
  it("bundles all three artifacts from one call", () => {
    const artifacts = buildRecoveryArtifacts({
      event: event(),
      agent_unit: "klanker",
      scope: "doc:gdrive:DOC1",
      action: "read",
    });
    expect(artifacts.auditRow.event).toBe("recover");
    expect(artifacts.digestLine).toContain("Q3 Strategy Notes");
    expect(artifacts.nudge).toContain("Q3 Strategy Notes");
    expect(artifacts.nudge).toContain("pick up where I left off");
  });
});
