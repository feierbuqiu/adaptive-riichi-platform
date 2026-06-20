-- 003_observability.sql — OPS-005 real-user telemetry + OPS-003 background-job leader
-- lock. Owned by src/server.js. Every statement is idempotent so applying the baseline to
-- an existing production database is a safe no-op. Already-applied migrations are
-- immutable; add a new numbered migration to change the schema.

-- Cooperative single-leader election for background jobs, so overlapping application
-- revisions during a zero-downtime deploy do not run duplicate singleton jobs.
CREATE TABLE IF NOT EXISTS job_locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

-- Same-origin Web Vitals / failure-stage telemetry. Stores coarse dimensions only — no
-- full IP address and no authentication material.
CREATE TABLE IF NOT EXISTS rum_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  page TEXT,
  nav_type TEXT,
  failure_stage TEXT,
  ttfb_ms INTEGER,
  load_ms INTEGER,
  lcp_ms INTEGER,
  inp_ms INTEGER,
  cls_x1000 INTEGER,
  ua_browser TEXT,
  ua_os TEXT,
  ua_device TEXT,
  region TEXT,
  cdn_pop TEXT
);
CREATE INDEX IF NOT EXISTS idx_rum_events_created ON rum_events(created_at);
