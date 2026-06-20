// Backup restore drill (OPS-004).
//
//   node scripts/restore-check.mjs <backup.sqlite>
//
// Copies a backup into a throwaway location, opens it read-only, runs a full
// integrity_check, lists the recorded migration ledger, and samples row counts. This
// proves a backup is not merely produced but actually restorable. Exits non-zero if the
// backup is missing or fails its integrity check.

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const backup = process.argv[2];
if (!backup) {
  console.error("Usage: node scripts/restore-check.mjs <backup.sqlite>");
  process.exit(2);
}
if (!fs.existsSync(backup)) {
  console.error(`Backup not found: ${backup}`);
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-"));
const restored = path.join(tmp, "restored.sqlite");
try {
  fs.copyFileSync(backup, restored);
  const db = new DatabaseSync(restored, { readOnly: true });
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  let migrations = [];
  try {
    migrations = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((row) => row.id);
  } catch {
    migrations = [];
  }
  const counts = {};
  for (const table of ["identities", "attempts", "practice_responses", "audit_logs"]) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[table] = null;
    }
  }
  db.close();
  if (integrity !== "ok") {
    console.error(`Restore integrity check failed: ${JSON.stringify(integrity)}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ backup, integrity: "ok", migrations, counts, bytes: fs.statSync(backup).size }));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
