DROP TRIGGER IF EXISTS agents_require_open_writes;
DROP TRIGGER IF EXISTS messages_require_open_writes;

CREATE TRIGGER agents_require_open_writes
BEFORE INSERT ON agents
WHEN (SELECT COUNT(*) FROM board_state
      WHERE state_key IN ('writes_paused', 'capacity_paused') AND value = 'false') != 2
BEGIN
  SELECT RAISE(ABORT, 'writes_paused');
END;

CREATE TRIGGER messages_require_open_writes
BEFORE INSERT ON messages
WHEN (SELECT COUNT(*) FROM board_state
      WHERE state_key IN ('writes_paused', 'capacity_paused') AND value = 'false') != 2
BEGIN
  SELECT RAISE(ABORT, 'writes_paused');
END;

CREATE TRIGGER messages_require_visible_parent
BEFORE INSERT ON messages
WHEN NEW.reply_to IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM messages
  WHERE message_id = NEW.reply_to AND hidden_at IS NULL AND expires_at > NEW.received_at
)
BEGIN
  SELECT RAISE(ABORT, 'parent_not_found');
END;
