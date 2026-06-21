// Authenticated encryption-at-rest for small secrets (admin TOTP seed).
//
// AES-256-GCM with a key derived from the application secret via scrypt under a distinct
// label, so the at-rest key is cryptographically separate from the session-signing secret
// and needs no extra configuration. Stored form: "enc:v1:<iv>:<ciphertext>:<tag>" (base64).
// decrypt() passes legacy plaintext (and null) through unchanged so existing rows keep
// working until a one-time migration re-encrypts them.

const crypto = require("node:crypto");

function createSecretBox(masterSecret, label = "secret-box-v1") {
  const key = crypto.scryptSync(String(masterSecret || ""), `adaptive:${label}`, 32);

  function encrypt(plain) {
    if (plain == null || plain === "") return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return `enc:v1:${iv.toString("base64")}:${ciphertext.toString("base64")}:${cipher.getAuthTag().toString("base64")}`;
  }

  function decrypt(stored) {
    if (typeof stored !== "string" || !stored.startsWith("enc:v1:")) return stored;
    const [, , ivB64, ctB64, tagB64] = stored.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  }

  function isEncrypted(value) {
    return typeof value === "string" && value.startsWith("enc:v1:");
  }

  return { encrypt, decrypt, isEncrypted };
}

module.exports = { createSecretBox };
