// Administrator passkey (WebAuthn / FIDO2) and recovery codes.
//
// Wraps @simplewebauthn/server with this app's storage: credentials, one-time recovery
// codes (HMAC-hashed at rest), and short-lived single-use ceremony challenges. attestation
// is "none" — a single self-enrolling administrator does not need attestation chains.

const crypto = require("node:crypto");
const webauthn = require("@simplewebauthn/server");

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function createWebauthn({ db, config, id, sha, hmac, nowIso, nowMs }) {
  const insertChallenge = db.prepare("INSERT INTO webauthn_challenges (id, purpose, admin_user_id, challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  const getChallenge = db.prepare("SELECT * FROM webauthn_challenges WHERE id = ?");
  const delChallenge = db.prepare("DELETE FROM webauthn_challenges WHERE id = ?");

  function storeChallenge(purpose, adminUserId, challenge) {
    const cid = id("wac");
    insertChallenge.run(cid, purpose, adminUserId || null, challenge, nowIso(), new Date(nowMs() + CHALLENGE_TTL_MS).toISOString());
    return cid;
  }

  // One-time: the row is deleted on first read regardless of validity.
  function consumeChallenge(challengeId, purpose) {
    const row = getChallenge.get(String(challengeId || ""));
    if (row) delChallenge.run(row.id);
    if (!row || row.purpose !== purpose || new Date(row.expires_at).getTime() < nowMs()) return null;
    return row;
  }

  const credsFor = (adminUserId) => db.prepare("SELECT * FROM webauthn_credentials WHERE admin_user_id = ?").all(adminUserId);
  const hasCredentials = () => db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials").get().n > 0;

  async function registrationOptions(admin) {
    const options = await webauthn.generateRegistrationOptions({
      rpName: config.webauthnRpName,
      rpID: config.webauthnRpId,
      userName: admin.username,
      userID: new TextEncoder().encode(admin.id),
      attestationType: "none",
      excludeCredentials: credsFor(admin.id).map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports || "[]") })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    return { options, challengeId: storeChallenge("register", admin.id, options.challenge) };
  }

  async function verifyRegistration(admin, challengeId, response, deviceLabel) {
    const ch = consumeChallenge(challengeId, "register");
    if (!ch || ch.admin_user_id !== admin.id) return { ok: false, error: "注册挑战已失效，请重试。" };
    let result;
    try {
      result = await webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.webauthnOrigins,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: false,
      });
    } catch { return { ok: false, error: "Passkey 验证失败。" }; }
    if (!result.verified || !result.registrationInfo) return { ok: false, error: "Passkey 验证未通过。" };
    const cred = result.registrationInfo.credential;
    try {
      db.prepare("INSERT INTO webauthn_credentials (id, admin_user_id, credential_id, public_key, counter, transports, device_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id("wacr"), admin.id, cred.id, b64url(cred.publicKey), cred.counter || 0, JSON.stringify(cred.transports || []), String(deviceLabel || "").slice(0, 60) || null, nowIso());
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return { ok: false, error: "该 Passkey 已经注册过。" };
      throw err;
    }
    return { ok: true };
  }

  async function authenticationOptions() {
    const all = db.prepare("SELECT credential_id, transports FROM webauthn_credentials").all();
    const options = await webauthn.generateAuthenticationOptions({
      rpID: config.webauthnRpId,
      userVerification: "preferred",
      allowCredentials: all.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports || "[]") })),
    });
    return { options, challengeId: storeChallenge("login", null, options.challenge) };
  }

  async function verifyAuthentication(challengeId, response) {
    const ch = consumeChallenge(challengeId, "login");
    if (!ch) return { ok: false };
    const row = db.prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?").get(String(response?.id || ""));
    if (!row) return { ok: false };
    let result;
    try {
      result = await webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: config.webauthnOrigins,
        expectedRPID: config.webauthnRpId,
        requireUserVerification: false,
        credential: { id: row.credential_id, publicKey: Buffer.from(row.public_key, "base64url"), counter: row.counter, transports: JSON.parse(row.transports || "[]") },
      });
    } catch { return { ok: false }; }
    if (!result.verified) return { ok: false };
    db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(result.authenticationInfo.newCounter, nowIso(), row.id);
    return { ok: true, adminUserId: row.admin_user_id };
  }

  // --- one-time recovery codes (break-glass when no passkey is available) ---
  const canonical = (code) => String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const recoveryHash = (code) => hmac(`recovery:${canonical(code)}`);

  function generateRecoveryCodes(adminUserId) {
    db.prepare("DELETE FROM admin_recovery_codes WHERE admin_user_id = ? AND used_at IS NULL").run(adminUserId);
    const insert = db.prepare("INSERT INTO admin_recovery_codes (id, admin_user_id, code_hash, created_at) VALUES (?, ?, ?, ?)");
    const codes = [];
    for (let i = 0; i < config.adminRecoveryCodeCount; i += 1) {
      const raw = crypto.randomBytes(8).toString("hex");
      const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
      codes.push(code);
      insert.run(id("rec"), adminUserId, recoveryHash(code), nowIso());
    }
    return codes;
  }

  function verifyRecoveryCode(adminUserId, code) {
    if (!canonical(code)) return false;
    const row = db.prepare("SELECT id FROM admin_recovery_codes WHERE admin_user_id = ? AND code_hash = ? AND used_at IS NULL").get(adminUserId, recoveryHash(code));
    if (!row) return false;
    db.prepare("UPDATE admin_recovery_codes SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
    return true;
  }

  const recoveryCodesRemaining = (adminUserId) => db.prepare("SELECT COUNT(*) AS n FROM admin_recovery_codes WHERE admin_user_id = ? AND used_at IS NULL").get(adminUserId).n;

  function pruneChallenges() {
    try { db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(nowIso()); } catch { /* best effort */ }
  }

  return {
    registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication,
    hasCredentials, credsFor, generateRecoveryCodes, verifyRecoveryCode, recoveryCodesRemaining, pruneChallenges,
  };
}

module.exports = { createWebauthn };
