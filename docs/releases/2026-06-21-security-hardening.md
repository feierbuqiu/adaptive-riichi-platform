# Production release evidence - 2026-06-21 (security hardening + refactor)

Follows the P1-completion release. Addresses an audit finding (admin TOTP secret
stored in plaintext) and continues the ENG-002 / ENG-005 incremental tail, plus a
small performance refinement.

## Artifact identity

- Code commit: `c4d630f`
- Signed tag: `release-2026-06-21-security-hardening`
- Production image ID:
  `sha256:3bb8a13b82e00382b49cae5779d8081c7aa88ab34a2f243eaa37bd87c428426d`
- Rollback image ID:
  `sha256:4d51947d02aab70a7ab1ca7827885ef453b4f9d21a99dee752d721dc0bc4da39`

## Changes

- **Admin TOTP secret encrypted at rest** (`src/secrets.js`, AES-256-GCM keyed from
  the app secret via scrypt under a distinct label). New admins seed encrypted; a
  legacy plaintext secret is re-encrypted on first successful login. The migration is
  **rollback-safe** by design: `decrypt()` still accepts plaintext, so the row only
  moves to the encrypted form after the new code is confirmed serving.
- **ENG-002**: extracted HTTP response/cookie/body helpers into `src/http.js`.
- **ENG-005**: `errorBody({error, code, requestId})` envelope on the centralized auth
  errors, additive and backward compatible.
- **Performance**: in-memory cache of small static-file buffers in `serveFile`,
  removing synchronous filesystem syscalls from the event loop on repeat requests.

## Pre-deployment evidence

- `npm run check`, `npm run migrate:check`: passed.
- `npm test`: 38 passed, 0 failed (up from 32), adding secret-box round-trip / tamper
  / key-isolation and error-envelope tests. The existing admin-login integration test
  (full password + TOTP) passes against the encrypt-on-seed / decrypt-on-verify path.

## Deployment and verification

- Pre-deploy backup taken (`quick_check = ok`); previous image tagged `prev-w2`.
- Deployed via the zero-downtime path (Caddy drain + retry); new container healthy,
  on-box smoke `failed: 0`.
- After the deploy was confirmed stable, a one-time pass encrypted the existing
  plaintext admin TOTP secret. Verified in place: **1/1 admin secrets are now
  encrypted and decrypt back to a valid base32 seed**, so admin login is unaffected.
- External: `https://test.feierbuqiu.uk/practice` `200`, `X-Request-Id` present.

## Explicitly unchanged

- IP/fingerprint data is intentionally retained (owner needs it for geolocation,
  including IPv6) — no change to IP storage.
- No credential rotation, OneDrive change, or Cloudflare interstitial.
