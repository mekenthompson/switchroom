/**
 * Unit tests for `checkApprovalAclByAgent` — Phase 2b agent-name ACL.
 */

import { describe, it, expect } from "vitest";
import { checkApprovalAclByAgent } from "./acl.js";

describe("checkApprovalAclByAgent (Phase 2b)", () => {
  it("allows when claim matches listener agent", () => {
    expect(checkApprovalAclByAgent("alice", "alice").allow).toBe(true);
  });

  it("denies cross-agent claim — alice listener cannot serve bob requests", () => {
    const r = checkApprovalAclByAgent("alice", "bob");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/mismatch.*alice.*bob/);
  });

  it("denies all 6 (i,j i!=j) pairs across alice/bob/carol", () => {
    const agents = ["alice", "bob", "carol"];
    for (const i of agents) {
      for (const j of agents) {
        if (i === j) {
          expect(checkApprovalAclByAgent(i, j).allow).toBe(true);
        } else {
          expect(checkApprovalAclByAgent(i, j).allow).toBe(false);
        }
      }
    }
  });

  it("denies an empty listener agent (fail-closed)", () => {
    const r = checkApprovalAclByAgent("", "alice");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/no bound agent identity/);
  });

  it("denies an empty claim", () => {
    const r = checkApprovalAclByAgent("alice", "");
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toMatch(/no agent_unit/);
  });

  it("is case-sensitive — Alice != alice", () => {
    expect(checkApprovalAclByAgent("alice", "Alice").allow).toBe(false);
  });
});
