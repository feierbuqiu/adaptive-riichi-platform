import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const source = process.env.DB_PATH || "/var/lib/adaptive-test/app.sqlite";
const destination = process.argv[2];

if (!destination) {
  console.error("Usage: node scripts/backup-db.mjs <destination.sqlite>");
  process.exit(2);
}

if (fs.existsSync(destination)) {
  console.error(`Refusing to overwrite existing backup: ${destination}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
const sourceDb = new DatabaseSync(source);
const sqliteDestination = destination.replaceAll("'", "''");
sourceDb.exec(`VACUUM INTO '${sqliteDestination}'`);
sourceDb.close();
fs.chmodSync(destination, 0o600);

const backupDb = new DatabaseSync(destination, { readOnly: true });
const check = backupDb.prepare("PRAGMA quick_check").get();
backupDb.close();

if (check.quick_check !== "ok") {
  console.error(`Backup integrity check failed: ${JSON.stringify(check)}`);
  process.exit(1);
}

console.log(JSON.stringify({ source, destination, integrity: "ok", bytes: fs.statSync(destination).size }));
