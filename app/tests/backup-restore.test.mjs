import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { runMigrations, listMigrationFiles, DEFAULT_MIGRATIONS_DIR } = require("../src/migrations.js");
const EXPECTED_MIGRATIONS = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const APP_ROOT = path.resolve(".");

function run(script, args, env) {
  return spawnSync(process.execPath, [path.join("scripts", script), ...args], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("backup-db produces an integral copy that restore-check can verify end to end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-"));
  const dbPath = path.join(dir, "app.sqlite");
  const backupPath = path.join(dir, "backup.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    db.prepare("INSERT INTO audit_logs (id, actor_type, action, created_at) VALUES ('a1', 'admin', 'seed', '2026-06-20T00:00:00Z')").run();
    db.close();

    const backup = run("backup-db.mjs", [backupPath], { DB_PATH: dbPath });
    assert.equal(backup.status, 0, `backup-db failed: ${backup.stderr}`);
    const backupReport = JSON.parse(backup.stdout.trim());
    assert.equal(backupReport.integrity, "ok");
    assert.ok(fs.existsSync(backupPath));

    const restore = run("restore-check.mjs", [backupPath], {});
    assert.equal(restore.status, 0, `restore-check failed: ${restore.stderr}`);
    const restoreReport = JSON.parse(restore.stdout.trim());
    assert.equal(restoreReport.integrity, "ok");
    assert.deepEqual(restoreReport.migrations, EXPECTED_MIGRATIONS);
    assert.equal(restoreReport.counts.audit_logs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup-db refuses to overwrite an existing destination", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-overwrite-"));
  const dbPath = path.join(dir, "app.sqlite");
  const backupPath = path.join(dir, "backup.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
    db.close();
    fs.writeFileSync(backupPath, "preexisting");
    const backup = run("backup-db.mjs", [backupPath], { DB_PATH: dbPath });
    assert.notEqual(backup.status, 0, "must refuse to clobber an existing backup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore-check fails on a corrupt backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-corrupt-"));
  const corrupt = path.join(dir, "corrupt.sqlite");
  try {
    fs.writeFileSync(corrupt, "this is not a valid sqlite database file");
    const restore = run("restore-check.mjs", [corrupt], {});
    assert.notEqual(restore.status, 0, "restore-check must reject a non-database file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
