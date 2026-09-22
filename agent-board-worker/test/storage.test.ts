import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { atomicBatch, consumeQuota } from "../src/db";

const now = 1_789_939_600;

async function resetStorage(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM digest_messages"),
    env.DB.prepare("DELETE FROM digest_batches"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("UPDATE board_state SET value = 'false', updated_at = ? WHERE state_key IN ('writes_paused', 'email_paused')").bind(now)
  ]);
}

async function insertAgent(agentId: string, revokedAt: number | null = null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO agents (agent_id, display_name, description, key_hash, key_prefix, ip_hash, created_at, revoked_at) VALUES (?, ?, '', ?, ?, ?, ?, ?)"
  ).bind(agentId, agentId, `hash-${agentId}`, "amb_live_test", "ip-hash", now, revokedAt).run();
}

describe("D1 storage guardrails", () => {
  beforeEach(resetStorage);

  it("records a migration once when migrations are applied twice", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agents', 'messages', 'quota_counters', 'digest_batches', 'digest_messages', 'audit_events', 'board_state') ORDER BY name"
    ).all<{ name: string }>();
    const migrations = await env.DB.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first<{ count: number }>();

    expect(tables.results.map(({ name }) => name)).toEqual([
      "agents", "audit_events", "board_state", "digest_batches", "digest_messages", "messages", "quota_counters"
    ]);
    expect(migrations?.count).toBe(3);
  });

  it("allows only the remaining quota capacity when calls race", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeQuota(env.DB, {
      scope: "registration-ip",
      subject: "ip-hash",
      windowStart: now,
      limit: 3
    })));
    const counter = await env.DB.prepare(
      "SELECT used FROM quota_counters WHERE scope = 'registration-ip' AND subject = 'ip-hash' AND window_start = ?"
    ).bind(now).first<{ used: number }>();

    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(counter?.used).toBe(3);
  });

  it("rolls back an entire D1 batch when a later statement fails", async () => {
    await expect(atomicBatch(env.DB, [
      env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('test', 'subject', ?, 1, 1)").bind(now),
      env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('test', 'subject', ?, 1, 1)").bind(now)
    ])).rejects.toThrow();

    const row = await env.DB.prepare(
      "SELECT used FROM quota_counters WHERE scope = 'test' AND subject = 'subject' AND window_start = ?"
    ).bind(now).first();
    expect(row).toBeNull();
  });

  it("blocks registration while writes are paused", async () => {
    await env.DB.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'writes_paused'").run();

    await expect(insertAgent("agt_paused")).rejects.toThrow(/writes_paused/);
  });

  it("blocks messages from revoked agents and duplicate idempotency keys", async () => {
    await insertAgent("agt_revoked", now);
    await expect(env.DB.prepare(
      "INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES ('msg_revoked', 'agt_revoked', 'introductions', 'hello', '{}', 'payload', 'idempotency-key-0001', ?, ?)"
    ).bind(now, now + 1).run()).rejects.toThrow(/agent_revoked/);

    await insertAgent("agt_active");
    const statement = env.DB.prepare(
      "INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES (?, 'agt_active', 'introductions', 'hello', '{}', 'payload', 'idempotency-key-0002', ?, ?)"
    );
    await statement.bind("msg_first", now, now + 1).run();
    await expect(statement.bind("msg_second", now + 1, now + 2).run()).rejects.toThrow();
  });
});
