# Engineering Roadmap

Updated: 2026-06-20

## Product and operating constraints

- Keep a modular monolith; do not introduce microservices without measured need.
- Target up to 50 concurrent users and roughly 100 daily visitors initially.
- Preserve SQLite and native browser clients while they remain sufficient.
- Keep all proprietary questions, answers, research data, statistics, and user
  records outside the public repository.
- Do not depend on CAPTCHA or browser challenges for normal or abusive traffic.
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

The roadmap is not fully complete. The current pre-commit implementation has
closed or materially advanced the code-side P0 work:

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
- the automated suite covers these controls and the existing practice rules.

Remaining P0 release work requires operator or production access: relocate and
rotate synchronized credentials, add an outer access-control layer to the admin
hostname, deploy the current revision, and complete post-deployment smoke and
rollback checks. Signed annotated release tags and per-release evidence records
are also not yet in place.

P1 remains active: immutable migrations, broader API/security/backup/restore
coverage, incremental modularization, automated zero-downtime delivery,
scheduled backup/restore drills, and production observability are not complete.

## Upgrade triggers

PostgreSQL, Redis, multi-host deployment, or a paid acceleration network require
measured evidence: sustained SQLite lock contention, unacceptable recovery time,
multiple writers, recurring event-loop saturation, or inability to meet the
user-side deployment SLO within the approved budget.
