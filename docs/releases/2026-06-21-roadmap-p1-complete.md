# Production release evidence - 2026-06-21 (roadmap P1 completion)

Completes the two remaining P1 items: production observability (OPS-005) and
zero-downtime delivery (OPS-003).

## Artifact identity

- Code commit: `052ec00` (`feat: production observability, request ids, and
  background-job leader lock`)
- Signed tag: `release-2026-06-21-roadmap-p1-complete`
- Production image ID:
  `sha256:4d51947d02aab70a7ab1ca7827885ef453b4f9d21a99dee752d721dc0bc4da39`
- Rollback image ID:
  `sha256:e6a1f3764259b170e89f912bb6d2b0739e975b682a786fc9dec4d53a6146ec6b`
- Schema migrations applied: `001_core.sql`, `002_practice.sql`,
  `003_observability.sql` (003 recorded `2026-06-20T15:21:51Z`, server clock)

## Pre-deployment evidence

- `npm run check`, `npm run migrate:check`: passed.
- `npm test`: 32 passed, 0 failed (up from 25), adding leader-election, log
  redaction/route-templating, and the `/api/rum` endpoint.
- Pre-deploy backup taken (`PRAGMA quick_check = ok`); previous image tagged
  `prev-w1` as the rollback point.

## Production observability (OPS-005)

- `X-Request-Id` present on responses (verified `req_d2bb21e40a6e08dcbc`).
- Structured, redacted access logs flowing, e.g.
  `{"t":"access","id":"req_…","m":"POST","route":"/api/rum","status":204,"ms":5,"cc":"AU"}`
  — coarse route shape, status, latency, country; no cookies, tokens, or full IP.
- Same-origin RUM beacon `POST /api/rum` returns `204` and stores an event
  (`rum_events` count increased); telemetry is anonymous, rate-limited, bounded, and
  never errors the client.
- Resource/error monitor `adaptive-monitor.timer` active (every 5 minutes); first
  sample `level=OK`, app healthy, 0 restarts, mem 33%, disk 34%, 0 HTTP 5xx.

## Zero-downtime delivery (OPS-003)

- Background-job leader lock live: `job_locks` shows a single `background` holder, so
  overlapping revisions never duplicate the sweeper or cluster rebuild;
  `PRAGMA busy_timeout=5000` covers brief write contention.
- The reverse proxy drains and retries across a container swap
  (`lb_try_duration 10s`, `lb_try_interval 250ms`; Caddy config validated and
  reloaded atomically).
- **Measured during a live app-container recreate: 130/130 probe requests returned
  `200`, zero lost** — the user-side "zero lost committed answers" objective on a
  single host that cannot run two full app replicas (1 GB RAM).
- Build-before-switch, expand/contract migrations, and smoke-gated automatic
  rollback remain in force.

## Post-deployment evidence

- Running image `sha256:4d51947d…`, container health `healthy`.
- On-box smoke test: `failed: 0` across all user/admin boundary checks and the tile
  asset checks.
- Migration ledger on production: `001`, `002`, `003` applied.

## Explicitly unchanged

- No API key, token, password, TOTP secret, or SSH key was rotated.
- OneDrive organization-account settings and synchronization were not changed.
- No Cloudflare Challenge, Turnstile, Access interstitial, or other human
  verification was enabled.
