ALTER TABLE digest_batches ADD COLUMN payload_json TEXT;

CREATE INDEX digest_batches_last_attempt_idx ON digest_batches(last_attempt_at);
