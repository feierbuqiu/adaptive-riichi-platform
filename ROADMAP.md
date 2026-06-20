# Engineering Roadmap

Updated: 2026-06-20

## Product and operating constraints

- Keep a modular monolith; do not introduce microservices without measured need.
- Target up to 50 concurrent users and roughly 100 daily visitors initially.
- Preserve SQLite and native browser clients while they remain sufficient.
- Keep all proprietary questions, answers, research data, statistics, and user
  records outside the public repository.
- Do not depend on CAPTCHA or browser challenges for normal or abusive traffic.
- Do not enable Cloudflare Challenge, Turnstile, Access login pages, or any
  browser-interstitial verification on user or administrator paths; mainland
  China reachability takes priority over that control.
- Keep the current credentials and OneDrive layout unchanged unless the owner
  explicitly reopens credential rotation or storage migration. Treat this as
  an accepted operational risk, not an unfinished release task.
- Do not use a mainland-China deployment or CDN product that requires ICP filing.
- Keep optional acceleration and monitoring spend within CNY 0-20 per month.
- Real-user monitoring must be same-origin, asynchronous, failure-tolerant, and
  must never block page loading or answer submission.
- User-facing deployments must progress toward zero interruption and zero lost
  committed answers. Administrator availability during maintenance is not an SLO.

## P0 - Safe iteration and abuse resistance

### Repository and release integrity

- Maintain a public-source allowlist and automated secret/artifact checks.
- Require SSH-signed commits and annotated tags.
- Record commit, image digest, database backup, migration version, smoke-test
  result, and rollback command for every production release.

### Rate limiting and identity creation

- Replace spoofable device-header-only keys with trusted client IP/prefix,
  identity, endpoint, and global layers.
- Add expiry cleanup and a hard capacity bound to in-memory limiter state.
- Limit anonymous identity creation without hard-blocking carrier-grade NAT users.
- Return bounded `429` responses; do not introduce CAPTCHA.

### Expensive computation

- Remove full identity clustering from public request paths.
- Coalesce rebuild requests into a bounded background job.
- Generate candidate pairs before similarity comparisons and enforce time,
  batch, retry, and concurrency limits.

### Runtime containment

- Add CPU, memory, and PID limits, bounded Docker logs, health checks, and HTTP
  timeouts.
- Move toward a read-only container root filesystem with explicit writable data
  and temporary mounts.
- Add spreadsheet-formula neutralization to every CSV export.

### Administrator protection without challenges

- Keep the administrator hostname isolated from public user paths.
- Retain password, TOTP, strict CSRF checks, audit logs, and `__Host-` cookies.
- Bound login attempts by source and account with server-side `429` responses;
  do not fall back to browser challenges or CAPTCHA.

## P1 - High-frequency delivery

### Tests and migrations

- Add API, authorization, CSRF, IDOR, malformed-input, rate-limit, migration,
  backup, and restore tests.
- Replace implicit startup schema changes with ordered immutable migrations.

### Modularization

- Extract configuration, HTTP responses, validation, cookies, authentication,
  rate limiting, repositories, domain modules, and jobs incrementally.
- Preserve behavior and add regression coverage before moving each responsibility.

### User-side zero-downtime deployment

- Build and verify the new image before touching the active application.
- Use backward-compatible expand/contract database migrations.
- Run old and new application revisions concurrently during a controlled switch.
- Drain in-flight requests from the old revision and preserve server-side sessions.
- Prevent duplicate singleton jobs while two revisions overlap.
- Automatically roll back when readiness or user-flow smoke tests fail.

### Observability and mainland performance

- Collect same-origin Web Vitals and failure-stage telemetry after rendering.
- Swallow monitoring failures and support `sendBeacon`, keepalive `fetch`, and a
  no-telemetry fallback.
- Report latency and errors by coarse region, carrier, browser family, and CDN POP
  without storing complete IP addresses or authentication material.
- Evaluate only no-ICP, low-cost Hong Kong or international routing options.

## Status snapshot - 2026-06-20

The roadmap is not fully complete. The current release has closed the P0 work
required for the present single-host deployment:

- the public repository has an allowlist, ignored runtime artifacts, and an
  SSH-signed baseline commit;
- rate limiting now has global, endpoint, trusted-client-IP, and authenticated
  identity layers, bounded state, expiry cleanup, and a dedicated anonymous
  identity-creation limit;
- identity clustering is no longer rebuilt in public request paths, uses
  indexed candidate generation instead of a full Cartesian comparison, and has
  time, pair-count, retry, and single-run bounds;
- CSV exports neutralize spreadsheet formulas;
- private liveness/readiness checks, HTTP timeouts, container resource limits,
  bounded logs, a read-only application root, and an explicit temporary mount
  are represented in the public deployment template and passed an isolated
  Docker image smoke test;
- administrator login now adds account-bound failure limits, uniform failure
  responses, bounded inputs, login audit events, and production `__Host-`
  session cookies without introducing a browser challenge;
- the automated suite covers these controls and the existing practice rules;
- release `release-2026-06-20-e3af346` is signed and GitHub-verified, the
  content-addressed image is deployed, the database and previous source/image
  have rollback points, and post-deployment user/admin route checks passed;
- the production application container now enforces the tested read-only root,
  temporary mount, dropped capabilities, PID limit, and no-new-privileges
  boundary.

Credential rotation, OneDrive relocation, and Cloudflare browser-interstitial
access control are explicitly out of scope by owner decision. They are accepted
operational constraints rather than open release blockers. The current release
evidence is recorded in `docs/releases/2026-06-20-e3af346.md`.

P1 is now partially delivered; see the dated progress section below. Automated
zero-downtime delivery (expand/contract overlap with drain and auto-rollback) and
production observability remain the main open P1 items.

## P1 progress - 2026-06-20

The following P1 work is implemented, tested, and deployed to the single production
host (release `release-2026-06-20-roadmap-p1`, content-addressed image
`sha256:e6a1f376…`):

- **Continuous integration.** `.github/workflows/ci.yml` runs the syntax check, a
  fresh-database migration check, and the full test suite on every push and pull
  request, plus a public-tree guard that fails if any secret, key, database,
  backup, or private-bank file is ever tracked.
- **Ordered immutable migrations.** Schema is created and recorded through
  `migrations/001_core.sql` and `migrations/002_practice.sql` via a checksum-guarded
  runner with a `schema_migrations` ledger. Applying the baseline to the existing
  production database was an idempotent no-op that preserved all data; a modified
  applied migration is rejected. `scripts/migrate.mjs` provides apply/status/check.
- **Expanded test matrix.** Coverage grew from 15 to 25 automated tests, adding
  migration idempotency/baseline/immutability, backup-and-restore round trips, and
  HTTP integration tests for per-identity CSRF, identity isolation, and oversized
  input resilience.
- **Scheduled backups and a verified restore drill.** A nightly systemd timer runs
  a consistent SQLite backup followed by an automated restore-and-integrity check
  (`scripts/restore-check.mjs`), with bounded retention. The drill has run
  successfully against live production data.
- **Incremental modularization.** Runtime configuration was extracted into
  `src/config.js` behind the full test suite; further extraction of repositories,
  domain modules, and jobs remains sequenced for later increments.
- **Release tooling.** `scripts/smoke-test.mjs` codifies the externally observable
  security boundaries and gates the deploy.

Open P1 items: automated zero-downtime delivery (build-before-switch, overlapping
revisions with request drain, automatic rollback on smoke failure — the current
deploy is single-container recreate with health-gated rollback) and production
observability (structured request telemetry, same-origin Web Vitals, and resource
alerting). The release evidence is recorded in
`docs/releases/2026-06-20-roadmap-p1.md`.

## Upgrade triggers

PostgreSQL, Redis, multi-host deployment, or a paid acceleration network require
measured evidence: sustained SQLite lock contention, unacceptable recovery time,
multiple writers, recurring event-loop saturation, or inability to meet the
user-side deployment SLO within the approved budget.
