import crypto from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomBase32(chars = 32) {
  let out = "";
  for (let i = 0; i < chars; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

const adminUser = process.argv[2] || "admin";
const totpSecret = randomBase32();

console.log(`# Paste these into adaptive-test-app/.env on the server.`);
console.log(`NODE_ENV=production`);
console.log(`PORT=3000`);
console.log(`PUBLIC_ORIGIN=https://example.com`);
console.log(`ADMIN_ORIGIN=https://admin.example.com`);
console.log(`SOURCE_ROOT=/opt/adaptive-test-source`);
console.log(`DB_PATH=/var/lib/adaptive-test/app.sqlite`);
console.log(`ACCESS_CODE_PEPPER=${randomHex(32)}`);
console.log(`SESSION_SECRET=${randomHex(32)}`);
console.log(`ADMIN_USERNAME=${adminUser}`);
console.log(`ADMIN_PASSWORD=replace-with-a-long-unique-password`);
console.log(`ADMIN_TOTP_SECRET=${totpSecret}`);
console.log();
console.log(`# Add this TOTP secret to an authenticator app before first production login:`);
console.log(`otpauth://totp/AdaptiveTest:${encodeURIComponent(adminUser)}?secret=${totpSecret}&issuer=AdaptiveTest`);
