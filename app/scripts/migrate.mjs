// Database migration CLI (ENG-003 / release pipeline).
//
//   node scripts/migrate.mjs            apply pending migrations to DB_PATH
//   node scripts/migrate.mjs --status   print the applied-migration ledger of DB_PATH
//   node scripts/migrate.mjs --check    build a throwaway database, apply all migrations,
//                                       prove a second apply is idempotent, and confirm the
//                                       core tables exist (used by CI; touches no real data)

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { runMigrations, listMigrationFiles } = require("../src/migrations.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");
const DEFAULT_DB = path.join(HERE, "..", "data", "app.sqlite");
const mode = process.argv[2] || "--apply";

function applyTo(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  try {
    return runMigrations(db, { dir: MIGRATIONS_DIR });
  } finally {
    db.close();
  }
}

if (mode === "--check") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-check-"));
  const dbPath = path.join(tmp, "check.sqlite");
  try {
    const expected = listMigrationFiles(MIGRATIONS_DIR);
    const first = applyTo(dbPath);
    if (first.applied.length !== expected.length) {
      throw new Error(`fresh apply ran ${first.applied.length} of ${expected.length} migrations`);
    }
    const second = applyTo(dbPath);
    if (second.applied.length !== 0) {
      throw new Error(`second apply was not idempotent: re-applied ${second.applied.join(", ")}`);
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    db.close();
    for (const table of ["identities", "attempts", "audit_logs", "fingerprints", "practice_responses", "schema_migrations"]) {
      if (!tables.has(table)) throw new Error(`expected table missing after migration: ${table}`);
    }
    console.log(JSON.stringify({ mode: "check", migrations: expected, idempotent: true, ok: true }));
  } catch (err) {
    console.error(`migrate --check failed: ${err.message}`);
    process.exit(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (mode === "--status") {
  const dbPath = process.env.DB_PATH || DEFAULT_DB;
  if (!fs.existsSync(dbPath)) {
    console.log(JSON.stringify({ mode: "status", dbPath, applied: [], note: "database does not exist yet" }));
  } else {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let applied = [];
    try {
      applied = db.prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id").all();
    } catch {
      applied = [];
    }
    db.close();
    console.log(JSON.stringify({ mode: "status", dbPath, applied }));
  }
} else {
  const dbPath = process.env.DB_PATH || DEFAULT_DB;
  const result = applyTo(dbPath);
  console.log(JSON.stringify({ mode: "apply", dbPath, applied: result.applied, ledger: result.ledger }));
}
