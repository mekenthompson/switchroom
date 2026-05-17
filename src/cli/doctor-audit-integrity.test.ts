/**
 * doctor-audit-integrity — WS10-F4 (#1420). Pins the detection
 * contract: missing/empty/unchained-legacy → warn (actionable, not a
 * tamper signal), chained-valid → ok, chained-broken → fail.
 */

import { describe, it, expect } from "vitest";

import { runAuditIntegrityChecks } from "./doctor-audit-integrity.js";
import { chainRow, CHAIN_GENESIS, type ChainState } from "../util/audit-hashchain.js";

const HOME = "/h";
const VAULT = "/h/.switchroom/vault-audit.log";
const HOSTD = "/h/.switchroom/host-control-audit.log";

function chainedLog(rows: Record<string, unknown>[]): string {
  let st: ChainState = { seq: 0, lastHash: CHAIN_GENESIS };
  let t = "";
  for (const r of rows) {
    const { line, next } = chainRow(st, r);
    t += line;
    st = next;
  }
  return t;
}

/** A reader that serves `files[path]`; absent path → throw (ENOENT). */
function reader(files: Record<string, string>) {
  return (p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };
}

function run(files: Record<string, string>) {
  return runAuditIntegrityChecks({ homeDir: HOME, readFileSync: reader(files) });
}

describe("runAuditIntegrityChecks", () => {
  it("warns when a root audit log is missing", () => {
    const r = run({ [VAULT]: chainedLog([{ ts: "t", op: "get" }]) });
    const hostd = r.find((c) => c.name.includes("hostd audit log present"));
    expect(hostd?.status).toBe("warn");
  });

  it("warns when a log exists but is empty (F3 fail-open symptom)", () => {
    const r = run({ [VAULT]: "", [HOSTD]: chainedLog([{ ts: "t", op: "x" }]) });
    expect(
      r.find((c) => c.name.includes("vault-broker audit log non-empty"))?.status,
    ).toBe("warn");
  });

  it("warns (NOT fail) on a pre-#1433 legacy unchained log", () => {
    const legacy =
      JSON.stringify({ ts: "t", op: "get", caller: "c", pid: 1, result: "allowed" }) +
      "\n";
    const r = run({ [VAULT]: legacy, [HOSTD]: legacy });
    const c = r.find((x) => x.name.includes("vault-broker audit tamper-evidence"));
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/legacy log/);
  });

  it("ok when the chain verifies from genesis", () => {
    const good = chainedLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    const r = run({ [VAULT]: good, [HOSTD]: good });
    expect(
      r.filter((c) => c.name.includes("audit chain valid") && c.status === "ok"),
    ).toHaveLength(2);
  });

  it("FAILS when a chained log was tampered", () => {
    const good = chainedLog([
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
    ]);
    const lines = good.trim().split("\n");
    const row0 = JSON.parse(lines[0]);
    row0.key = "TAMPERED";
    lines[0] = JSON.stringify(row0);
    const tampered = lines.join("\n") + "\n";
    const r = run({ [VAULT]: tampered, [HOSTD]: chainedLog([{ ts: "t", op: "x" }]) });
    const broken = r.find((c) => c.name.includes("vault-broker audit chain BROKEN"));
    expect(broken?.status).toBe("fail");
    expect(broken?.detail).toMatch(/row 1/);
  });
});
