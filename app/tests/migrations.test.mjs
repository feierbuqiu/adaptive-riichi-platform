import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { runMigrations, listMigrationFiles, checksum, DEFAULT_MIGRATIONS_DIR } = require("../src/migrations.js");

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));
  const dbPath = path.join(dir, "app.sqlite");
  const db = new DatabaseSync(dbPath);
  return { db, dir, dbPath };
}

test("fresh apply builds the full schema and records an ordered ledger", () => {
  const { db, dir } = freshDb();
  try {
    const result = runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    assert.deepEqual(result.applied, ["001_core.sql", "002_practice.sql"]);
    assert.deepEqual(result.ledger, ["001_core.sql", "002_practice.sql"]);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const table of ["identities", "attempts", "audit_logs", "fingerprints", "practice_responses", "practice_rounds", "schema_migrations"]) {
      assert.ok(tables.has(table), `expected table ${table}`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-applying migrations is idempotent and changes nothing", () => {
  const { db, dir } = freshDb();
  try {
    runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    const second = runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.ledger, ["001_core.sql", "002_practice.sql"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("baseline against an existing table preserves data and only records the ledger", () => {
  const { db, dir } = freshDb();
  try {
    // Simulate the existing production database: the table already exists with data
    // before the migration baseline is ever recorded.
    db.exec(`CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
      target_type TEXT, target_id TEXT, details_json TEXT, created_at TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO audit_logs (id, actor_type, action, created_at) VALUES ('a1', 'admin', 'seed', '2026-06-20T00:00:00Z')").run();
    const result = runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    assert.deepEqual(result.applied, ["001_core.sql", "002_practice.sql"]);
    const preserved = db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n;
    assert.equal(preserved, 1, "existing rows must survive the idempotent baseline");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an applied migration that is later modified is rejected (immutability)", () => {
  const { db, dir, dbPath } = freshDb();
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-mut-"));
  try {
    fs.writeFileSync(path.join(migDir, "001_x.sql"), "CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY);\n");
    const first = runMigrations(db, { dir: migDir });
    assert.deepEqual(first.applied, ["001_x.sql"]);
    db.close();
    fs.writeFileSync(path.join(migDir, "001_x.sql"), "CREATE TABLE IF NOT EXISTS x (id TEXT PRIMARY KEY, extra TEXT);\n");
    const reopened = new DatabaseSync(dbPath);
    assert.throws(() => runMigrations(reopened, { dir: migDir }), /checksum drift/i);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(migDir, { recursive: true, force: true });
  }
});

test("id filter applies only the requested migration so modules can own their own", () => {
  const { db, dir } = freshDb();
  const migDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-filter-"));
  try {
    fs.writeFileSync(path.join(migDir, "001_a.sql"), "CREATE TABLE IF NOT EXISTS a (id TEXT PRIMARY KEY);\n");
    fs.writeFileSync(path.join(migDir, "002_b.sql"), "CREATE TABLE IF NOT EXISTS b (id TEXT PRIMARY KEY);\n");
    const onlyA = runMigrations(db, { dir: migDir, ids: ["001_a.sql"] });
    assert.deepEqual(onlyA.applied, ["001_a.sql"]);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    assert.ok(tables.has("a"));
    assert.ok(!tables.has("b"), "filtered-out migration must not run");
    const onlyB = runMigrations(db, { dir: migDir, ids: ["002_b.sql"] });
    assert.deepEqual(onlyB.applied, ["002_b.sql"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(migDir, { recursive: true, force: true });
  }
});

test("migration files are well-formed and newline-normalized checksums are stable", () => {
  const files = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
  assert.deepEqual(files, ["001_core.sql", "002_practice.sql"]);
  for (const name of files) {
    const content = fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, name), "utf8");
    assert.equal(checksum(content), checksum(content.replace(/\n/g, "\r\n")), "checksum must ignore line-ending differences");
  }
});
