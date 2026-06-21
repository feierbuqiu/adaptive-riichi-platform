// Cryptographic primitives (ENG-002 extraction from server.js).
//
// createCrypto(secret) binds the application secret into hmac so call sites stay
// `hmac(value)`; the remaining helpers are pure. Password hashing uses scrypt with a
// per-hash random salt; comparisons are constant-time.

const crypto = require("node:crypto");

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const derived = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function createCrypto(secret) {
  const hmac = (value, key = secret) => crypto.createHmac("sha256", key).update(String(value)).digest("hex");
  return { hmac, sha, safeEqualHex, hashPassword, verifyPassword, id };
}

module.exports = { createCrypto, sha, safeEqualHex, hashPassword, verifyPassword, id };
