import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { createJobLock } = require("../src/jobs.js");
const { runMigrations, DEFAULT_MIGRATIONS_DIR } = require("../src/migrations.js");

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
  const db = new DatabaseSync(path.join(dir, "app.sqlite"));
  runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
  return { db, dir };
}

test("only one of two overlapping instances holds the background lock", () => {
  const { db, dir } = freshDb();
  try {
    let now = 1000;
    const clock = () => now;
    const a = createJobLock(db, { instanceId: "a", nowMs: clock, ttlMs: 90000 });
    const b = createJobLock(db, { instanceId: "b", nowMs: clock, ttlMs: 90000 });

    assert.equal(a.acquire("background"), true, "first acquirer wins");
    assert.equal(b.acquire("background"), false, "a live lock cannot be stolen");
    assert.equal(a.acquire("background"), true, "holder renews freely");
    assert.equal(b.acquire("background"), false, "still blocked while a is fresh");

    // a goes silent past the TTL -> b may take over the stale lock.
    now += 100000;
    assert.equal(b.acquire("background"), true, "stale lock is taken over");
    assert.equal(a.acquire("background"), false, "old holder is now blocked");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a lone instance always leads across heartbeats", () => {
  const { db, dir } = freshDb();
  try {
    let now = 1;
    const solo = createJobLock(db, { instanceId: "solo", nowMs: () => now, ttlMs: 90000 });
    for (let i = 0; i < 5; i += 1) {
      now += 30000;
      assert.equal(solo.acquire("background"), true);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("locks are independent per name", () => {
  const { db, dir } = freshDb();
  try {
    const now = () => 1000;
    const a = createJobLock(db, { instanceId: "a", nowMs: now });
    const b = createJobLock(db, { instanceId: "b", nowMs: now });
    assert.equal(a.acquire("sweep"), true);
    assert.equal(b.acquire("cluster"), true, "a different lock name is unaffected");
    assert.equal(b.acquire("sweep"), false, "but the held name is still exclusive");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
