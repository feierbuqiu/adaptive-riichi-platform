-- 004_webauthn.sql — administrator passkey (WebAuthn / FIDO2) credentials, one-time
-- recovery codes, and short-lived ceremony challenges. Owned by src/server.js. Every
-- statement is idempotent so applying the baseline to an existing production database is a
-- safe no-op. Already-applied migrations are immutable; add a new numbered migration.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_admin ON webauthn_credentials(admin_user_id);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_admin ON admin_recovery_codes(admin_user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  admin_user_id TEXT,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
