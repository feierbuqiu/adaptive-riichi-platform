// TOTP (RFC 6238) verification for administrator login (ENG-002 extraction).
// Accepts a ±1 step window and compares codes in constant time. A missing secret only
// passes outside production, to keep local development friction-free.

const crypto = require("node:crypto");
const { IS_PROD } = require("./config");

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function verifyTotp(secret, token) {
  if (!secret) return !IS_PROD;
  if (!/^\d{6}$/.test(String(token || ""))) return false;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30000);
  for (const offset of [-1, 0, 1]) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(step + offset));
    const h = crypto.createHmac("sha1", key).update(buf).digest();
    const pos = h[h.length - 1] & 0xf;
    const code = ((h.readUInt32BE(pos) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(String(token)))) return true;
  }
  return false;
}

module.exports = { base32Decode, verifyTotp };
