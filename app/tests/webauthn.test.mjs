import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { createWebauthn } = require("../src/webauthn.js");
const { runMigrations, DEFAULT_MIGRATIONS_DIR } = require("../src/migrations.js");

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webauthn-test-"));
  const db = new DatabaseSync(path.join(dir, "app.sqlite"));
  runMigrations(db, { dir: DEFAULT_MIGRATIONS_DIR });
  const w = createWebauthn({
    db,
    config: { webauthnRpId: "localhost", webauthnRpName: "Test", webauthnOrigins: ["http://localhost"], adminRecoveryCodeCount: 10 },
    id: (p) => `${p}_${crypto.randomBytes(6).toString("hex")}`,
    sha: (v) => crypto.createHash("sha256").update(String(v)).digest("hex"),
    hmac: (v) => crypto.createHmac("sha256", "test-key").update(String(v)).digest("hex"),
    nowIso: () => new Date(1000).toISOString(),
    nowMs: () => 1000,
  });
  return { w, db, dir };
}

test("recovery codes are one-time, format-insensitive, and re-generation invalidates the old set", () => {
  const { w, db, dir } = service();
  try {
    assert.equal(w.hasCredentials(), false);
    const codes = w.generateRecoveryCodes("adm_1");
    assert.equal(codes.length, 10);
    for (const c of codes) assert.match(c, /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    assert.equal(w.recoveryCodesRemaining("adm_1"), 10);

    assert.equal(w.verifyRecoveryCode("adm_1", codes[0]), true);
    assert.equal(w.recoveryCodesRemaining("adm_1"), 9);
    assert.equal(w.verifyRecoveryCode("adm_1", codes[0]), false, "a used code cannot be reused");
    assert.equal(w.verifyRecoveryCode("adm_1", "0000-0000-0000-0000"), false, "an unknown code is rejected");
    // case- and separator-insensitive
    assert.equal(w.verifyRecoveryCode("adm_1", codes[1].toUpperCase().replace(/-/g, "")), true);
    assert.equal(w.recoveryCodesRemaining("adm_1"), 8);
    // a code scoped to another admin must not work
    assert.equal(w.verifyRecoveryCode("adm_other", codes[2]), false);

    const reissued = w.generateRecoveryCodes("adm_1");
    assert.equal(w.recoveryCodesRemaining("adm_1"), 10);
    assert.equal(w.verifyRecoveryCode("adm_1", codes[2]), false, "old unused codes are invalidated on reissue");
    assert.equal(w.verifyRecoveryCode("adm_1", reissued[0]), true);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("registration and authentication options generate and store a one-time challenge", async () => {
  const { w, db, dir } = service();
  try {
    const reg = await w.registrationOptions({ id: "adm_1", username: "admin" });
    assert.equal(typeof reg.options.challenge, "string");
    assert.ok(reg.challengeId);
    const auth = await w.authenticationOptions();
    assert.equal(typeof auth.options.challenge, "string");
    assert.ok(auth.challengeId);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM webauthn_challenges").get().n;
    assert.equal(stored, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
