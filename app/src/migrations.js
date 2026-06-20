// Ordered, immutable database migrations with a recorded ledger (ENG-003).
//
// Every migration is a numbered `NNN_name.sql` file under app/migrations/. They are
// applied in filename order and recorded in the `schema_migrations` table. Applied
// migrations are immutable: if a file's content changes after it was applied, the
// runner refuses to continue (checksum drift) — add a new numbered migration instead.
//
// All current baseline migrations use `IF NOT EXISTS`, so applying them to an existing
// production database is a safe no-op that only records the ledger rows. Checksums are
// computed over newline-normalized content so they are identical on Windows, Linux, and
// inside the container image.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function checksum(text) {
  return crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

function listMigrationFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /^\d{3,}_.*\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function ensureLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

// Apply pending migrations. `options.ids` restricts the run to specific files so each
// module can own its own migration(s) (server -> 001, practice -> 002) while sharing one
// ledger. Returns the files applied this call plus the full ordered ledger.
function runMigrations(db, options = {}) {
  const dir = options.dir || DEFAULT_MIGRATIONS_DIR;
  const only = options.ids ? new Set(options.ids) : null;
  const nowIso = typeof options.nowIso === "function" ? options.nowIso : () => new Date().toISOString();
  ensureLedger(db);
  const appliedById = new Map(
    db.prepare("SELECT id, checksum FROM schema_migrations").all().map((row) => [row.id, row.checksum]),
  );
  const insert = db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)");
  const applied = [];
  for (const name of listMigrationFiles(dir)) {
    if (only && !only.has(name)) continue;
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    const sum = checksum(sql);
    const prior = appliedById.get(name);
    if (prior != null) {
      if (prior !== sum && !options.allowChecksumDrift) {
        throw new Error(`Migration ${name} changed after being applied (checksum drift). Applied migrations are immutable; add a new numbered migration instead.`);
      }
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      insert.run(name, sum, nowIso());
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* the failing statement already aborted the transaction */ }
      throw new Error(`Migration ${name} failed: ${err.message}`);
    }
    applied.push(name);
  }
  const ledger = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((row) => row.id);
  return { applied, ledger, current: ledger.length ? ledger[ledger.length - 1] : null };
}

module.exports = { runMigrations, listMigrationFiles, checksum, ensureLedger, DEFAULT_MIGRATIONS_DIR };
