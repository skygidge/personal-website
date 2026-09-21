import { runRetention } from "../src/retention";
import type { Env } from "../src/index";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const now = 1_790_000_000_000;
const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "development",
  EMERGENCY_WRITES_PAUSED: "false",
  EMERGENCY_EMAIL_PAUSED: "false",
  MESSAGE_RETENTION_DAYS: "90",
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret",
  IP_HASH_SECRET: "test-ip-hash-secret",
  CURSOR_SECRET: "test-cursor-secret",
  D1_STORAGE_LIMIT_BYTES: "500000000"
};

async function resetBoard(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM digest_messages"),
    env.DB.prepare("DELETE FROM digest_batches"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("UPDATE board_state SET value = 'false' WHERE state_key IN ('writes_paused', 'email_paused', 'capacity_paused')")
  ]);
}

async function insertMessages(count: number, expiresAt: number): Promise<void> {
  await env.DB.prepare("INSERT INTO agents (agent_id, display_name, description, key_hash, key_prefix, ip_hash, created_at) VALUES ('agt_retention', 'Retention Agent', '', 'retention-key', 'amb_live_', 'retention-ip', ?)").bind(now).run();
  for (let index = 0; index < count; index += 1) {
    await env.DB.prepare(
      "INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at, hidden_at) VALUES (?, 'agt_retention', 'cleanup', 'old', '{}', 'payload', ?, ?, ?, ?)"
    ).bind(`msg_retention${String(index).padStart(24, "0")}`, `post-retention-${index}`, now - 1, expiresAt, index % 2 ? now - 1 : null).run();
  }
}

describe("retention and capacity", () => {
  beforeEach(resetBoard);

  it("removes both visible and hidden expired messages in bounded batches without deleting current posts", async () => {
    await insertMessages(101, now - 1);
    await env.DB.prepare(
      "INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES ('msg_retention_current', 'agt_retention', 'cleanup', 'current', '{}', 'payload', 'post-retention-current', ?, ?)"
    ).bind(now, now + 1).run();

    const first = await runRetention(testEnv, now, async () => 1);
    const afterFirst = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE expires_at <= ?").bind(now).first<{ count: number }>();
    const second = await runRetention(testEnv, now, async () => 1);
    const current = await env.DB.prepare("SELECT message FROM messages WHERE message_id = 'msg_retention_current'").first<{ message: string }>();

    expect(first.deleted_messages).toBe(100);
    expect(afterFirst?.count).toBe(1);
    expect(second.deleted_messages).toBe(1);
    expect(current?.message).toBe("current");
  });

  it("removes only aged IP quota rows", async () => {
    const sevenDaysSeconds = 7 * 24 * 60 * 60;
    const currentDaySeconds = Math.floor(now / 1000 / (24 * 60 * 60)) * 24 * 60 * 60;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('posting-ip-daily', 'old', ?, 1, 100)").bind(currentDaySeconds - sevenDaysSeconds - 1),
      env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('posting-ip-daily', 'current', ?, 1, 100)").bind(currentDaySeconds - sevenDaysSeconds),
      env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('posting-key-daily', 'keep', ?, 1, 100)").bind(currentDaySeconds - sevenDaysSeconds - 1)
    ]);

    await runRetention(testEnv, now, async () => 1);
    const rows = await env.DB.prepare("SELECT subject FROM quota_counters ORDER BY subject").all<{ subject: string }>();

    expect(rows.results).toEqual([{ subject: "current" }, { subject: "keep" }]);
  });

  it("keeps audit history for 90 days and removes older records", async () => {
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, actor, action, request_id, outcome) VALUES ('evt_old', ?, 'system', 'old', 'req_old', 'success')").bind(now - ninetyDays - 1),
      env.DB.prepare("INSERT INTO audit_events (event_id, occurred_at, actor, action, request_id, outcome) VALUES ('evt_current', ?, 'system', 'current', 'req_current', 'success')").bind(now - ninetyDays)
    ]);

    await runRetention(testEnv, now, async () => 1);
    const rows = await env.DB.prepare("SELECT event_id FROM audit_events WHERE event_id IN ('evt_old', 'evt_current') ORDER BY event_id").all<{ event_id: string }>();

    expect(rows.results).toEqual([{ event_id: "evt_current" }]);
  });

  it("pauses writes at 95 percent storage and never attempts a paid fallback", async () => {
    const threshold = 500_000_000 * 0.95;
    const result = await runRetention(testEnv, now, async () => threshold);
    const paused = await env.DB.prepare("SELECT value FROM board_state WHERE state_key = 'capacity_paused'").first<{ value: string }>();

    expect(result.capacity_state).toBe("paused");
    expect(paused?.value).toBe("true");
  });

  it("reports the 70 and 85 percent storage thresholds before pausing writes", async () => {
    const warning = await runRetention(testEnv, now, async () => 500_000_000 * 0.7);
    const high = await runRetention(testEnv, now, async () => 500_000_000 * 0.85);
    const paused = await env.DB.prepare("SELECT value FROM board_state WHERE state_key = 'capacity_paused'").first<{ value: string }>();

    expect(warning.capacity_state).toBe("warning");
    expect(high.capacity_state).toBe("high");
    expect(paused?.value).toBe("false");
  });

  it("persists D1's post-cleanup storage measurement for private status", async () => {
    const result = await runRetention(testEnv, now);
    const stored = await env.DB.prepare("SELECT value FROM board_state WHERE state_key = 'capacity_bytes'").first<{ value: string }>();

    expect(result.capacity_state).toBe("open");
    expect(Number(stored?.value)).toBeGreaterThan(0);
  });
});
