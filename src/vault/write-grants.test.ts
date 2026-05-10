/**
 * Tests for write-grant capability (issue #969 P1b).
 *
 * Covers the new `write_allow` column, `mintGrant`'s write_allow parameter,
 * `validateGrantForWrite`, prefix-glob matching, and the schema migration's
 * idempotent ALTER on an existing DB without the column.
 */

import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import {
  migrateGrantsSchema,
  mintGrant,
  validateGrant,
  validateGrantForWrite,
  listGrants,
  keyMatchesPatterns,
} from "./grants.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

describe("keyMatchesPatterns", () => {
  it("matches a literal key", () => {
    expect(keyMatchesPatterns(["foo"], "foo")).toBe(true);
    expect(keyMatchesPatterns(["foo"], "bar")).toBe(false);
  });

  it("does not match a partial literal", () => {
    expect(keyMatchesPatterns(["foo"], "foobar")).toBe(false);
    expect(keyMatchesPatterns(["foobar"], "foo")).toBe(false);
  });

  it("matches a prefix glob (trailing *)", () => {
    expect(keyMatchesPatterns(["OPENAI_*"], "OPENAI_API_KEY")).toBe(true);
    expect(keyMatchesPatterns(["OPENAI_*"], "OPENAI_")).toBe(true);
    expect(keyMatchesPatterns(["OPENAI_*"], "OPENAI")).toBe(false);
    expect(keyMatchesPatterns(["OPENAI_*"], "ANTHROPIC_KEY")).toBe(false);
  });

  it("matches across multiple patterns", () => {
    expect(keyMatchesPatterns(["A", "B_*", "C"], "B_X")).toBe(true);
    expect(keyMatchesPatterns(["A", "B_*", "C"], "D")).toBe(false);
  });

  it("returns false on empty patterns", () => {
    expect(keyMatchesPatterns([], "anything")).toBe(false);
  });

  it("treats lone '*' as match-anything", () => {
    expect(keyMatchesPatterns(["*"], "anything")).toBe(true);
  });
});

describe("migrateGrantsSchema — write_allow column", () => {
  it("adds write_allow to a fresh DB", () => {
    const db = makeDb();
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(vault_grants)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("write_allow");
  });

  it("idempotently adds write_allow to an old DB that lacks it", () => {
    const db = new Database(":memory:");
    // Simulate an old DB created before P1b: create the table WITHOUT
    // write_allow, then run the migration and expect it to backfill.
    db.run(`
      CREATE TABLE vault_grants (
        id          TEXT    PRIMARY KEY,
        secret_hash TEXT    NOT NULL,
        agent_slug  TEXT    NOT NULL,
        key_allow   TEXT    NOT NULL,
        expires_at  INTEGER,
        revoked_at  INTEGER,
        created_at  INTEGER NOT NULL,
        description TEXT
      )
    `);
    // Insert a legacy row so we can verify it survives migration with
    // a default `[]` in the new column.
    db.run(
      `INSERT INTO vault_grants (id, secret_hash, agent_slug, key_allow, expires_at, created_at, description)
       VALUES ('vg_legacy', 'hash', 'agent1', '["legacy_key"]', NULL, 1000, NULL)`,
    );

    migrateGrantsSchema(db);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(vault_grants)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("write_allow");

    // Legacy row's write_allow defaults to '[]'.
    const row = db
      .query<{ write_allow: string }, []>(
        "SELECT write_allow FROM vault_grants WHERE id = 'vg_legacy'",
      )
      .get();
    expect(row?.write_allow).toBe("[]");

    // Running migration again is a no-op.
    expect(() => migrateGrantsSchema(db)).not.toThrow();
  });
});

describe("mintGrant + write_allow round-trip", () => {
  it("mints a grant with empty write_allow by default (back-compat)", async () => {
    const db = makeDb();
    const mint = await mintGrant(db, "agent1", ["read_key"], null);
    const grants = listGrants(db);
    expect(grants).toHaveLength(1);
    expect(grants[0].key_allow).toEqual(["read_key"]);
    expect(grants[0].write_allow).toEqual([]);
    expect(mint.token).toMatch(/^vg_[0-9a-f]{6}\./);
  });

  it("persists write_allow when passed", async () => {
    const db = makeDb();
    await mintGrant(db, "agent1", ["r1"], null, "desc", ["w1", "PREFIX_*"]);
    const grants = listGrants(db);
    expect(grants[0].write_allow).toEqual(["w1", "PREFIX_*"]);
  });

  it("supports write-only grants (empty key_allow)", async () => {
    const db = makeDb();
    await mintGrant(db, "agent1", [], null, undefined, ["only_writable"]);
    const grants = listGrants(db);
    expect(grants[0].key_allow).toEqual([]);
    expect(grants[0].write_allow).toEqual(["only_writable"]);
  });
});

describe("validateGrantForWrite", () => {
  it("accepts a valid write-grant for an exact key match", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "agent1", [], null, undefined, ["my_key"]);
    const result = await validateGrantForWrite(db, token, "my_key");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.write_allow).toEqual(["my_key"]);
    }
  });

  it("accepts a valid write-grant for a prefix-glob match", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "agent1", [], null, undefined, ["OPENAI_*"]);
    const result = await validateGrantForWrite(db, token, "OPENAI_API_KEY_PROD");
    expect(result.ok).toBe(true);
  });

  it("rejects with grant-write-not-allowed when key does not match", async () => {
    const db = makeDb();
    const { token } = await mintGrant(db, "agent1", ["read_only_key"], null, undefined, []);
    const result = await validateGrantForWrite(db, token, "read_only_key");
    expect(result).toEqual({ ok: false, reason: "grant-write-not-allowed" });
  });

  it("does NOT grant write just because read is allowed (capability separation)", async () => {
    // A grant with key_allow=['k1'] and write_allow=[] must not authorize
    // writes to k1. Read and write are independent capabilities.
    const db = makeDb();
    const { token } = await mintGrant(db, "agent1", ["k1"], null);
    const readOk = await validateGrant(db, token, "k1");
    expect(readOk.ok).toBe(true);
    const writeDeny = await validateGrantForWrite(db, token, "k1");
    expect(writeDeny).toEqual({ ok: false, reason: "grant-write-not-allowed" });
  });

  it("rejects expired write-grants", async () => {
    const db = makeDb();
    // Mint then manually backdate to expired.
    const { token, id } = await mintGrant(db, "agent1", [], null, undefined, ["k"]);
    db.run("UPDATE vault_grants SET expires_at = 1 WHERE id = ?", [id]);
    const result = await validateGrantForWrite(db, token, "k");
    expect(result).toEqual({ ok: false, reason: "grant-expired" });
  });

  it("rejects revoked write-grants", async () => {
    const db = makeDb();
    const { token, id } = await mintGrant(db, "agent1", [], null, undefined, ["k"]);
    db.run("UPDATE vault_grants SET revoked_at = 2 WHERE id = ?", [id]);
    const result = await validateGrantForWrite(db, token, "k");
    expect(result).toEqual({ ok: false, reason: "grant-revoked" });
  });

  it("rejects malformed tokens with grant-invalid", async () => {
    const db = makeDb();
    const r1 = await validateGrantForWrite(db, "not-a-token", "k");
    expect(r1).toEqual({ ok: false, reason: "grant-invalid" });
    const r2 = await validateGrantForWrite(db, "vg_unknown.deadbeef", "k");
    expect(r2).toEqual({ ok: false, reason: "grant-invalid" });
  });
});
