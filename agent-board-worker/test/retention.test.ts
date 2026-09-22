import { runRetention } from "../src/retention";
import { getMessage } from "../src/messages";
import type { Env } from "../src/index";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  await env.DB.prepare(`
    WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?)
    INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at, hidden_at)
    SELECT 'msg_retention' || printf('%024d', n), 'agt_retention', 'cleanup', 'old', '{}', 'payload',
      'post-retention-' || n, ?, ?, CASE WHEN n % 2 = 1 THEN ? ELSE NULL END FROM numbers
  `).bind(count, now - 1, expiresAt, now - 1).run();
}

async function insertOldHistory(count: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?)
      INSERT INTO quota_counters (scope, subject, window_start, used, limit_value)
      SELECT 'posting-ip-daily', 'old-' || n, 0, 1, 100 FROM numbers`).bind(count),
    env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n + 1 < ?)
      INSERT INTO audit_events (event_id, occurred_at, actor, action, request_id, outcome)
      SELECT 'evt_old' || n, 0, 'system', 'old', 'req_old', 'success' FROM numbers`).bind(count)
  ]);
}

describe("retention and capacity", () => {
  beforeEach(resetBoard);
  afterEach(() => vi.restoreAllMocks());

  it("removes both visible and hidden expired messages in bounded batches without deleting current posts", async () => {
    await insertMessages(1001, now - 1);
    await env.DB.prepare(
      "INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES ('msg_retention_current', 'agt_retention', 'cleanup', 'current', '{}', 'payload', 'post-retention-current', ?, ?)"
    ).bind(now, now + 1).run();

    const first = await runRetention(testEnv, now, async () => 1);
    const afterFirst = await env.DB.prepare("SELECT COUNT(*) AS count FROM messages WHERE expires_at <= ?").bind(now).first<{ count: number }>();
    const second = await runRetention(testEnv, now, async () => 1);
    const current = await env.DB.prepare("SELECT message FROM messages WHERE message_id = 'msg_retention_current'").first<{ message: string }>();

    expect(first.deleted_messages).toBe(1001);
    expect(afterFirst?.count).toBe(0);
    expect(second.deleted_messages).toBe(0);
    expect(current?.message).toBe("current");
  });

  it("skips referenced parents, cleans unrelated expiry, and preserves parent_unavailable until replies expire", async () => {
    await insertMessages(2, now - 1);
    const parentId = "msg_retention000000000000000000000000";
    await env.DB.prepare("UPDATE messages SET expires_at = ? WHERE message_id = ?").bind(now + 1, parentId).run();
    await env.DB.prepare(`INSERT INTO messages
      (message_id, agent_id, topic, message, reply_to, metadata_json, payload_hash, idempotency_key, received_at, expires_at)
      VALUES ('msg_reply', 'agt_retention', 'cleanup', 'reply', ?, '{}', 'payload', 'post-retention-reply', ?, ?)`)
      .bind(parentId, now, now + 1).run();
    await env.DB.prepare("UPDATE messages SET expires_at = ? WHERE message_id = ?").bind(now - 1, parentId).run();

    const result = await runRetention(testEnv, now, async () => 1);
    expect(result.deleted_messages).toBe(1);
    expect(result.capacity_state).toBe("open");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const request = new Request("https://board.example/api/messages/msg_reply", { headers: { "CF-Connecting-IP": "192.0.2.1" } });
    const response = await getMessage("msg_reply", request, testEnv, "req_retention");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message: { reply_to: parentId, parent_unavailable: true } });
    expect((await getMessage(parentId, request, testEnv, "req_parent")).status).toBe(404);

    const expiredReply = await runRetention(testEnv, now + 1, async () => 1);
    expect(expiredReply.deleted_messages).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(0);
  });

  it("caps work per invocation across message, quota and audit backlogs", async () => {
    await insertMessages(2101, now - 1);
    await insertOldHistory(2101);
    const result = await runRetention(testEnv, now, async () => 1);

    expect(result.deleted_messages).toBe(2000);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(101);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM quota_counters").first("count")).toBe(101);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE occurred_at = 0").first("count")).toBe(101);
  });

  it("stops starting cleanup batches after its time budget, while still checking capacity", async () => {
    await insertMessages(250, now - 1);
    await insertOldHistory(250);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(20_000);

    const result = await runRetention(testEnv, now, async () => 475_000_000);

    expect(result.deleted_messages).toBe(100);
    expect(result.capacity_state).toBe("paused");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM quota_counters").first("count")).toBe(150);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE occurred_at = 0").first("count")).toBe(150);
  });

  it("measures actual D1 storage and pauses independently of a failed cleanup transaction", async () => {
    await insertMessages(1, now - 1);
    await env.DB.prepare("CREATE TRIGGER retention_test_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'cleanup_failed'); END").run();
    try {
      const result = await runRetention({ ...testEnv, D1_STORAGE_LIMIT_BYTES: "1" }, now);
      expect(result.deleted_messages).toBe(0);
      expect(result.capacity_state).toBe("paused");
      expect(await env.DB.prepare("SELECT value FROM board_state WHERE state_key = 'capacity_paused'").first("value")).toBe("true");
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(1);
    } finally {
      await env.DB.prepare("DROP TRIGGER retention_test_failure").run();
    }
  });

  it("keeps the committed deletion count when a later batch fails", async () => {
    await insertMessages(101, now - 1);
    await env.DB.prepare(`CREATE TRIGGER retention_test_failure BEFORE DELETE ON messages
      WHEN OLD.message_id = 'msg_retention000000000000000000000100'
      BEGIN SELECT RAISE(ABORT, 'cleanup_failed'); END`).run();
    try {
      const result = await runRetention(testEnv, now, async () => 1);
      expect(result.deleted_messages).toBe(100);
      expect(result.capacity_state).toBe("open");
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(1);
    } finally {
      await env.DB.prepare("DROP TRIGGER retention_test_failure").run();
    }
  });

  it.each([undefined, "475000000", NaN, -1, 1.5])("preserves cleanup progress when storage measurement is invalid (%s)", async (bytes) => {
    await insertMessages(1, now - 1);
    const result = await runRetention(testEnv, now, async () => bytes as number);
    expect(result).toEqual({ deleted_messages: 1, capacity_state: "unavailable" });
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
