-- 001_core.sql — canonical core schema for the adaptive test / admin / anti-abuse
-- domain. Owned by src/server.js. Every statement is idempotent (IF NOT EXISTS) so
-- applying this baseline to an existing production database is a safe no-op that only
-- records the migration in schema_migrations. Already-applied migrations are immutable;
-- add a new numbered migration to change the schema.

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  source TEXT,
  image_path TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  a REAL NOT NULL,
  b REAL NOT NULL,
  p REAL,
  rit REAL,
  stage TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  excluded INTEGER NOT NULL DEFAULT 0,
  n INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS question_options (
  question_id TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (question_id, option_index)
);
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  used_attempts INTEGER NOT NULL DEFAULT 0,
  active_attempt_id TEXT,
  first_attempt_id TEXT,
  sample_status TEXT NOT NULL DEFAULT 'not_started',
  sample_selected_index INTEGER,
  nickname TEXT,
  nickname_review_failures INTEGER NOT NULL DEFAULT 0,
  nickname_review_locked INTEGER NOT NULL DEFAULT 0,
  nickname_review_status TEXT,
  nickname_reviewed_at TEXT,
  nickname_review_request_id TEXT,
  nickname_review_label TEXT,
  nickname_review_suggestion TEXT,
  device_hash TEXT,
  link_cluster_id TEXT,
  last_fingerprint_id TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  excluded_from_board INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  status TEXT NOT NULL,
  theta REAL NOT NULL DEFAULT 0,
  se REAL NOT NULL DEFAULT 1,
  raw_ability_index INTEGER,
  reported_ability_index INTEGER,
  raw_ability_ci_low INTEGER,
  raw_ability_ci_high INTEGER,
  reported_ability_ci_low INTEGER,
  reported_ability_ci_high INTEGER,
  correct_count INTEGER NOT NULL DEFAULT 0,
  answer_count INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  below_reportable_threshold INTEGER NOT NULL DEFAULT 0,
  total_budget_seconds INTEGER NOT NULL DEFAULT 1750,
  active_elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  current_timed_item_id TEXT,
  formal_started_at TEXT,
  last_active_tick_at TEXT,
  last_resumed_at TEXT,
  abandoned_at TEXT,
  stop_reason TEXT,
  finalized_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS attempt_items (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  selected_index INTEGER,
  response_type TEXT NOT NULL,
  correct INTEGER NOT NULL,
  theta_before REAL NOT NULL,
  theta_after REAL,
  se_before REAL NOT NULL,
  se_after REAL,
  assigned_at TEXT NOT NULL,
  ready_at TEXT,
  shown_at TEXT,
  expires_at TEXT,
  answered_at TEXT,
  response_time_ms INTEGER,
  load_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  session_hash TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS item_exposure_daily (
  day TEXT NOT NULL,
  question_id TEXT NOT NULL,
  shown_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, question_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fingerprints (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  attempt_id TEXT,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL,
  ip_hash TEXT,
  ip_prefix_hash TEXT,
  ip_prefix TEXT,
  ua_raw TEXT,
  ua_browser TEXT,
  ua_os TEXT,
  ua_device TEXT,
  ua_mobile INTEGER,
  accept_language TEXT,
  uach_platform TEXT,
  uach_mobile TEXT,
  uach_model TEXT,
  timezone TEXT,
  languages TEXT,
  screen_w INTEGER,
  screen_h INTEGER,
  dpr REAL,
  viewport_w INTEGER,
  viewport_h INTEGER,
  platform TEXT,
  hardware_concurrency INTEGER,
  device_memory REAL,
  touch INTEGER,
  color_depth INTEGER,
  color_scheme TEXT,
  webgl_vendor TEXT,
  webgl_renderer TEXT,
  webgl_hash TEXT,
  signal_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_clusters (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  auto_enforced INTEGER NOT NULL DEFAULT 0,
  member_count INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_cluster_members (
  cluster_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  evidence_json TEXT,
  auto_enforced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, identity_id)
);
CREATE TABLE IF NOT EXISTS identity_cluster_edges (
  id TEXT PRIMARY KEY,
  cluster_id TEXT,
  identity_a TEXT NOT NULL,
  identity_b TEXT NOT NULL,
  score REAL NOT NULL,
  confidence_level TEXT NOT NULL,
  auto_enforced INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cluster_overrides (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  identity_a TEXT NOT NULL,
  identity_b TEXT NOT NULL,
  admin_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  cluster_id TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_identity ON attempts(identity_id);
CREATE INDEX IF NOT EXISTS idx_attempt_items_attempt ON attempt_items(attempt_id);
CREATE INDEX IF NOT EXISTS idx_identities_device ON identities(device_hash);
CREATE INDEX IF NOT EXISTS idx_identities_cluster ON identities(link_cluster_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_identity ON fingerprints(identity_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_attempt ON fingerprints(attempt_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_ipprefix ON fingerprints(ip_prefix_hash);
CREATE INDEX IF NOT EXISTS idx_cluster_members_identity ON identity_cluster_members(identity_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON identity_cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_edges_cluster ON identity_cluster_edges(cluster_id);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
