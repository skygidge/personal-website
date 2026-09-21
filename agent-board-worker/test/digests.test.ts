import { runDigest } from "../src/digests";
import worker, { type Env } from "../src/index";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const scheduledAt = 1_790_000_000_000;
const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "development",
  EMERGENCY_WRITES_PAUSED: "false",
  EMERGENCY_EMAIL_PAUSED: "false",
  MESSAGE_RETENTION_DAYS: "90",
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret",
  IP_HASH_SECRET: "test-ip-hash-secret",
  CURSOR_SECRET: "test-cursor-secret",
  ADMIN_TOKEN: "owner-control-token-for-tests-only",
  RESEND_API_KEY: "re_test",
  RESEND_TRACKING_DISABLED: "true",
  PUBLIC_API_ORIGIN: "https://board.example"
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

async function insertMessage(messageId = "msg_digest00000000000000000000000001", text = "A board message for the digest."): Promise<void> {
  const agentId = `agt_${messageId.slice(4)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO agents (agent_id, display_name, description, key_hash, key_prefix, ip_hash, created_at) VALUES (?, 'Digest Agent', '', ?, 'amb_live_', 'digest-ip', ?)").bind(agentId, `digest-key-${messageId}`, scheduledAt - 1),
    env.DB.prepare("INSERT INTO messages (message_id, agent_id, topic, message, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES (?, ?, 'research', ?, '{}', 'payload', ?, ?, ?)")
      .bind(messageId, agentId, text, `post-${messageId}`, scheduledAt - 1, scheduledAt + 90 * 24 * 60 * 60 * 1000)
  ]);
}

function successfulDelivery(calls: Request[]): (request: Request) => Promise<Response> {
  return async (request) => {
    calls.push(request);
    return Response.json({ id: "email_123" }, { status: 200 });
  };
}

describe("digest delivery", () => {
  beforeEach(resetBoard);

  it("does not send or create a batch when no visible posts are pending", async () => {
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const batches = await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_batches").first<{ count: number }>();

    expect(calls).toHaveLength(0);
    expect(batches?.count).toBe(0);
  });

  it("creates one exact batch and sends one fixed plain-text digest with Resend idempotency", async () => {
    await insertMessage();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const batch = await env.DB.prepare("SELECT state, provider_message_id, payload_hash FROM digest_batches").first<{ state: string; provider_message_id: string; payload_hash: string }>();
    const membership = await env.DB.prepare("SELECT message_id FROM digest_messages").all<{ message_id: string }>();
    const request = calls[0]!;
    const body = await request.json() as { from: string; to: string[]; subject: string; text: string };

    expect(calls).toHaveLength(1);
    expect(request.headers.get("idempotency-key")).toMatch(/^agent-board\/dgb_/);
    expect(body).toMatchObject({
      from: "Agent Message Board <board@skythomasgidge.com>",
      to: ["sgidge@gmail.com"],
      subject: "Agent Message Board: 1 new post"
    });
    expect(body.text).toContain("UNTRUSTED BOARD CONTENT");
    expect(body.text).toContain("A board message for the digest.");
    expect(body.text).toContain("https://board.example/api/messages/msg_digest00000000000000000000000001");
    expect(batch).toMatchObject({ state: "sent", provider_message_id: "email_123", payload_hash: expect.any(String) });
    expect(membership.results).toEqual([{ message_id: "msg_digest00000000000000000000000001" }]);
  });

  it("keeps a busy interval within the fixed digest text ceiling", async () => {
    await insertMessage("msg_digest00000000000000000000000011", "😀".repeat(5_000));
    await insertMessage("msg_digest00000000000000000000000012", "😀".repeat(5_000));
    await insertMessage("msg_digest00000000000000000000000013", "😀".repeat(5_000));
    const calls: Request[] = [];

    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));

    const body = await calls[0]?.json() as { text: string };
    expect(calls).toHaveLength(1);
    expect(new TextEncoder().encode(body.text).byteLength).toBeLessThanOrEqual(10_000);
  });

  it("does not begin a new send while normal email pause or the emergency flag is active", async () => {
    await insertMessage();
    await env.DB.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'email_paused'").run();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const unavailableDb = { prepare() { throw new Error("database should not be queried"); } } as unknown as D1Database;
    await runDigest({ ...testEnv, DB: unavailableDb, ENVIRONMENT: "production", EMERGENCY_EMAIL_PAUSED: "true" }, scheduledAt, successfulDelivery(calls));

    expect(calls).toHaveLength(0);
  });

  it("retries an ambiguous delivery with the same payload and key within 24 hours, then stops", async () => {
    await insertMessage();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, async (request) => {
      calls.push(request);
      throw new Error("network timeout after provider acceptance");
    });
    await runDigest(testEnv, scheduledAt + 6 * 60 * 1000, successfulDelivery(calls));
    const firstKey = calls[0]!.headers.get("idempotency-key");
    const secondKey = calls[1]!.headers.get("idempotency-key");
    const batch = await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first<{ state: string; attempt_count: number }>();

    expect(calls).toHaveLength(2);
    expect(secondKey).toBe(firstKey);
    expect(batch).toMatchObject({ state: "sent", attempt_count: 2 });
  });

  it("marks an ambiguous delivery for review after the 24-hour idempotency window", async () => {
    await insertMessage();
    await runDigest(testEnv, scheduledAt, async () => { throw new Error("network timeout"); });
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt + 24 * 60 * 60 * 1000 + 6 * 60 * 1000, successfulDelivery(calls));
    const batch = await env.DB.prepare("SELECT state FROM digest_batches").first<{ state: string }>();

    expect(calls).toHaveLength(0);
    expect(batch?.state).toBe("needs_review");
  });

  it("does not exceed the daily outbound-attempt cap", async () => {
    await insertMessage();
    await env.DB.prepare(
      "INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('email-global-daily', 'global', ?, 90, 90)"
    ).bind(Math.floor(scheduledAt / (24 * 60 * 60 * 1000)) * 24 * 60 * 60).run();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const batch = await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first<{ state: string; attempt_count: number }>();

    expect(calls).toHaveLength(0);
    expect(batch).toMatchObject({ state: "pending", attempt_count: 0 });
  });

  it("sends only once when two scheduler runs overlap", async () => {
    await insertMessage();
    const calls: Request[] = [];
    await Promise.all([
      runDigest(testEnv, scheduledAt, successfulDelivery(calls)),
      runDigest(testEnv, scheduledAt, successfulDelivery(calls))
    ]);

    expect(calls).toHaveLength(1);
    const sent = await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_batches WHERE state = 'sent'").first<{ count: number }>();
    expect(sent?.count).toBe(1);
  });

  it("removes a hidden post from an unleased digest batch", async () => {
    const messageId = "msg_digest00000000000000000000000002";
    await insertMessage(messageId, "This post should not reach an unleased digest.");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO digest_batches (batch_id, interval_start, state, payload_hash, created_at) VALUES ('dgb_pending', ?, 'pending', 'hash', ?)").bind(scheduledAt, scheduledAt),
      env.DB.prepare("INSERT INTO digest_messages (batch_id, message_id) VALUES ('dgb_pending', ?)").bind(messageId)
    ]);
    const hidden = await worker.fetch(new Request(`https://board.example/admin/messages/${messageId}/hide`, {
      method: "POST",
      headers: { authorization: "Bearer owner-control-token-for-tests-only" }
    }), testEnv, {} as ExecutionContext);
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const membership = await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_messages WHERE batch_id = 'dgb_pending'").first<{ count: number }>();

    expect(hidden.status).toBe(200);
    expect(membership?.count).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
