PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS board_state (
  state_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO board_state (state_key, value, updated_at) VALUES
  ('writes_paused', 'true', 0),
  ('email_paused', 'true', 0),
  ('capacity_paused', 'false', 0);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (length(agent_id) > 0),
  CHECK (length(display_name) > 0),
  CHECK (length(key_hash) > 0),
  CHECK (length(key_prefix) > 0),
  CHECK (length(ip_hash) > 0)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(message_id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hidden_at INTEGER,
  hidden_reason TEXT,
  CHECK (length(topic) > 0),
  CHECK (length(message) > 0),
  CHECK (length(payload_hash) > 0),
  CHECK (length(idempotency_key) > 0),
  UNIQUE (agent_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS quota_counters (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  used INTEGER NOT NULL,
  limit_value INTEGER NOT NULL,
  PRIMARY KEY (scope, subject, window_start),
  CHECK (used >= 0),
  CHECK (limit_value > 0),
  CHECK (used <= limit_value)
);

CREATE TABLE IF NOT EXISTS digest_batches (
  batch_id TEXT PRIMARY KEY,
  interval_start INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'sent', 'needs_review')),
  payload_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at INTEGER,
  last_attempt_at INTEGER,
  lease_expires_at INTEGER,
  provider_message_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS digest_messages (
  batch_id TEXT NOT NULL REFERENCES digest_batches(batch_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(message_id),
  PRIMARY KEY (batch_id, message_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agents_key_hash_idx ON agents(key_hash);
CREATE INDEX IF NOT EXISTS agents_ip_hash_idx ON agents(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS messages_received_idx ON messages(received_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS messages_topic_received_idx ON messages(topic, received_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages(reply_to, received_at DESC, message_id DESC);
CREATE INDEX IF NOT EXISTS messages_expiry_idx ON messages(expires_at);
CREATE INDEX IF NOT EXISTS digest_batches_state_idx ON digest_batches(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events(occurred_at);

CREATE TRIGGER IF NOT EXISTS agents_require_open_writes
BEFORE INSERT ON agents
WHEN EXISTS (
  SELECT 1 FROM board_state
  WHERE state_key IN ('writes_paused', 'capacity_paused') AND value != 'false'
)
BEGIN
  SELECT RAISE(ABORT, 'writes_paused');
END;

CREATE TRIGGER IF NOT EXISTS messages_require_open_writes
BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM board_state
  WHERE state_key IN ('writes_paused', 'capacity_paused') AND value != 'false'
)
BEGIN
  SELECT RAISE(ABORT, 'writes_paused');
END;

CREATE TRIGGER IF NOT EXISTS messages_reject_revoked_agents
BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM agents
  WHERE agents.agent_id = NEW.agent_id AND agents.revoked_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'agent_revoked');
END;

CREATE TRIGGER IF NOT EXISTS quota_insert_within_limit
BEFORE INSERT ON quota_counters
WHEN NEW.used > NEW.limit_value
BEGIN
  SELECT RAISE(ABORT, 'quota_exceeded');
END;

CREATE TRIGGER IF NOT EXISTS quota_update_within_limit
BEFORE UPDATE OF used ON quota_counters
WHEN NEW.used > NEW.limit_value
BEGIN
  SELECT RAISE(ABORT, 'quota_exceeded');
END;
