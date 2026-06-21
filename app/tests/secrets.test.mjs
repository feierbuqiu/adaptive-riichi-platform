import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createSecretBox } = require("../src/secrets.js");

test("encrypt/decrypt round-trips and produces distinct ciphertexts", () => {
  const box = createSecretBox("master-secret-at-least-32-characters", "admin-totp");
  const c1 = box.encrypt("JBSWY3DPEHPK3PXP");
  const c2 = box.encrypt("JBSWY3DPEHPK3PXP");
  assert.match(c1, /^enc:v1:/);
  assert.notEqual(c1, c2, "a random IV yields distinct ciphertexts for the same plaintext");
  assert.equal(box.decrypt(c1), "JBSWY3DPEHPK3PXP");
  assert.equal(box.decrypt(c2), "JBSWY3DPEHPK3PXP");
  assert.equal(box.isEncrypted(c1), true);
});

test("legacy plaintext and null pass through unchanged", () => {
  const box = createSecretBox("master", "admin-totp");
  assert.equal(box.decrypt("PLAINTEXTSECRET"), "PLAINTEXTSECRET");
  assert.equal(box.isEncrypted("PLAINTEXTSECRET"), false);
  assert.equal(box.decrypt(null), null);
  assert.equal(box.encrypt(null), null);
  assert.equal(box.encrypt(""), "");
});

test("a different secret or label cannot decrypt", () => {
  const a = createSecretBox("master-a", "admin-totp");
  const ct = a.encrypt("secret");
  assert.throws(() => createSecretBox("master-b", "admin-totp").decrypt(ct));
  assert.throws(() => createSecretBox("master-a", "other-purpose").decrypt(ct));
});

test("tampered ciphertext is rejected by the GCM auth tag", () => {
  const box = createSecretBox("master", "admin-totp");
  const parts = box.encrypt("secret").split(":");
  const raw = Buffer.from(parts[3], "base64");
  raw[0] ^= 0xff;
  parts[3] = raw.toString("base64");
  assert.throws(() => box.decrypt(parts.join(":")));
});
