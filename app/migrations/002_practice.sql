-- 002_practice.sql — canonical practice-domain schema. Owned by src/practice.js.
-- Every statement is idempotent (IF NOT EXISTS) so applying this baseline to an
-- existing production database is a safe no-op that only records the migration.
-- Already-applied migrations are immutable; add a new numbered migration to change it.

CREATE TABLE IF NOT EXISTS practice_banks (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  display_name TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE IF NOT EXISTS practice_questions (
  bank_id TEXT NOT NULL,
  bank_version TEXT NOT NULL,
  source_number INTEGER NOT NULL,
  render_json TEXT NOT NULL,
  answer_action TEXT NOT NULL,
  answer_tile TEXT NOT NULL,
  answer_riichi INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bank_id, bank_version, source_number)
);
CREATE TABLE IF NOT EXISTS practice_rounds (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  bank_version TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  analysis_eligible INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  order_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (identity_id, bank_id, bank_version, round_number)
);
CREATE TABLE IF NOT EXISTS practice_assignments (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  source_number INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  cohort_seed_item INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'assigned',
  assigned_at TEXT NOT NULL,
  ready_at TEXT,
  first_shown_at TEXT,
  answered_at TEXT,
  advanced_at TEXT,
  UNIQUE (round_id, source_number),
  UNIQUE (round_id, sequence)
);
CREATE TABLE IF NOT EXISTS practice_responses (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  bank_id TEXT NOT NULL,
  bank_version TEXT NOT NULL,
  source_number INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  selected_action TEXT NOT NULL,
  selected_tile TEXT NOT NULL,
  selected_riichi INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  analysis_eligible INTEGER NOT NULL,
  client_submission_id TEXT,
  session_id TEXT,
  fingerprint_id TEXT,
  assigned_at TEXT NOT NULL,
  ready_at TEXT,
  first_shown_at TEXT,
  first_interaction_at TEXT,
  submitted_at TEXT NOT NULL,
  server_wall_time_ms INTEGER NOT NULL,
  server_ready_to_submit_ms INTEGER,
  client_elapsed_time_ms INTEGER NOT NULL DEFAULT 0,
  client_ready_to_submit_ms INTEGER NOT NULL DEFAULT 0,
  client_visible_time_ms INTEGER NOT NULL DEFAULT 0,
  client_focused_time_ms INTEGER NOT NULL DEFAULT 0,
  client_active_thinking_time_ms INTEGER NOT NULL DEFAULT 0,
  client_load_time_ms INTEGER NOT NULL DEFAULT 0,
  hidden_count INTEGER NOT NULL DEFAULT 0,
  blur_count INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  timing_json TEXT,
  device_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_sessions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  round_id TEXT,
  bank_id TEXT NOT NULL,
  bank_version TEXT NOT NULL,
  fingerprint_id TEXT,
  device_hash TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  client_json TEXT
);
CREATE TABLE IF NOT EXISTS practice_activity (
  assignment_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  session_id TEXT,
  ready_at TEXT,
  first_shown_at TEXT,
  first_interaction_at TEXT,
  visible_time_ms INTEGER NOT NULL DEFAULT 0,
  focused_time_ms INTEGER NOT NULL DEFAULT 0,
  active_thinking_time_ms INTEGER NOT NULL DEFAULT 0,
  load_time_ms INTEGER NOT NULL DEFAULT 0,
  hidden_count INTEGER NOT NULL DEFAULT 0,
  blur_count INTEGER NOT NULL DEFAULT 0,
  resume_count INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  timing_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_practice_rounds_identity ON practice_rounds(identity_id, bank_id, bank_version, round_number);
CREATE INDEX IF NOT EXISTS idx_practice_assignments_round ON practice_assignments(round_id, sequence);
CREATE INDEX IF NOT EXISTS idx_practice_responses_identity ON practice_responses(identity_id, bank_id, bank_version);
CREATE INDEX IF NOT EXISTS idx_practice_responses_bank ON practice_responses(bank_id, bank_version, source_number);
CREATE INDEX IF NOT EXISTS idx_practice_sessions_identity ON practice_sessions(identity_id, started_at);
