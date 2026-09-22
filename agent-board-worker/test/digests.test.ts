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
    await runDigest(testEnv, scheduledAt + 15 * 60 * 1000, successfulDelivery(calls));
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

  it("spaces every retry by 15 minutes, including across interval and UTC day boundaries", async () => {
    await insertMessage();
    const start = Math.ceil(scheduledAt / 86_400_000) * 86_400_000 - 1;
    const calls: Request[] = [];
    const fail = async (request: Request) => { calls.push(request); return new Response(null, { status: 503 }); };
    await runDigest(testEnv, start, fail);
    await runDigest(testEnv, start + 1, fail);
    await runDigest(testEnv, start + 899_999, fail);
    expect(calls).toHaveLength(1);
    await runDigest(testEnv, start + 900_000, fail);
    expect(calls).toHaveLength(2);
  });

  it("applies global spacing to a different batch after a successful send", async () => {
    await insertMessage();
    const calls: Request[] = [];
    const start = Math.floor(scheduledAt / 900_000) * 900_000 + 899_999;
    await runDigest(testEnv, start, successfulDelivery(calls));
    await insertMessage("msg_second", "Second batch");
    await Promise.all([
      runDigest(testEnv, start + 1, successfulDelivery(calls)),
      runDigest(testEnv, start + 1, successfulDelivery(calls))
    ]);
    expect(calls).toHaveLength(1);
    await runDigest(testEnv, start + 900_000, successfulDelivery(calls));
    expect(calls).toHaveLength(2);
  });

  it("retries byte-identical content after source, membership and origin changes", async () => {
    await insertMessage();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, async (request) => { calls.push(request); return new Response(null, { status: 503 }); });
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET message = 'changed', hidden_at = ?").bind(scheduledAt),
      env.DB.prepare("UPDATE agents SET display_name = 'Changed Agent'"),
      env.DB.prepare("DELETE FROM digest_messages")
    ]);
    await runDigest({ ...testEnv, PUBLIC_API_ORIGIN: "https://changed.example" }, scheduledAt + 900_000, successfulDelivery(calls));
    expect(calls).toHaveLength(2);
    expect(await calls[1]!.text()).toBe(await calls[0]!.text());
    expect(calls[1]!.headers.get("idempotency-key")).toBe(calls[0]!.headers.get("idempotency-key"));
  });

  it("stops pending 5xx retries at exactly 24 hours", async () => {
    await insertMessage();
    await runDigest(testEnv, scheduledAt, async () => new Response(null, { status: 503 }));
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt + 86_400_000, successfulDelivery(calls));
    expect(calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first()).toMatchObject({ state: "needs_review", attempt_count: 1 });
  });

  it.each(["pending", "leased"])("bounds %s retries to five attempts", async (state) => {
    await insertMessage();
    const calls: Request[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await runDigest(testEnv, scheduledAt + attempt * 900_000, async (request) => {
        calls.push(request);
        if (state === "leased") throw new Error("ambiguous timeout");
        return new Response(null, { status: 503 });
      });
    }
    expect(calls).toHaveLength(5);
    expect(await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first()).toMatchObject({ state: "needs_review", attempt_count: 5 });
  });

  it("leaves every unrepresented message in backlog and delivers it later", async () => {
    for (let index = 0; index < 3; index += 1) await insertMessage(`msg_overflow${index}`, "x".repeat(10_000));
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const body = await calls[0]!.clone().json() as { subject: string; text: string };
    const membership = await env.DB.prepare("SELECT message_id FROM digest_messages").all<{ message_id: string }>();
    expect(membership.results).toHaveLength(1);
    expect(body.subject).toBe("Agent Message Board: 1 new post");
    for (const member of membership.results) expect(body.text).toContain(`/api/messages/${member.message_id}`);
    await runDigest(testEnv, scheduledAt + 900_000, successfulDelivery(calls));
    await runDigest(testEnv, scheduledAt + 1_800_000, successfulDelivery(calls));
    expect(calls).toHaveLength(3);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_messages").first<{ count: number }>())?.count).toBe(3);
  });

  it.each(["hide", "expire"])("revalidates %s before batch membership commits", async (change) => {
    await insertMessage();
    let changed = false;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!changed) {
          changed = true;
          await target.prepare(change === "hide" ? "UPDATE messages SET hidden_at = ?" : "UPDATE messages SET expires_at = ?").bind(scheduledAt).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const calls: Request[] = [];
    await runDigest({ ...testEnv, DB: db }, scheduledAt, successfulDelivery(calls));
    expect(changed).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_messages").first<{ count: number }>())?.count).toBe(0);
  });

  it("rechecks pause atomically after the initial pause read", async () => {
    await insertMessage();
    let paused = false;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!paused) {
          paused = true;
          await target.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'email_paused'").run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const calls: Request[] = [];
    await runDigest({ ...testEnv, DB: db }, scheduledAt, successfulDelivery(calls));
    expect(paused).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COALESCE(SUM(attempt_count), 0) AS count FROM digest_batches").first<{ count: number }>())?.count).toBe(0);
  });

  it("persists the exact request bytes and their hash on the first attempt", async () => {
    await insertMessage();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt, successfulDelivery(calls));
    const bytes = await calls[0]!.text();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes))),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await env.DB.prepare("SELECT payload_json, payload_hash FROM digest_batches").first())
      .toEqual({ payload_json: bytes, payload_hash: hash });
  });

  it.each(["payload_json = NULL", "payload_hash = 'corrupted'", "payload_json = 'changed bytes'"])("does not retry an unverifiable stored payload: %s", async (mutation) => {
    await insertMessage();
    await runDigest(testEnv, scheduledAt, async () => new Response(null, { status: 503 }));
    await env.DB.prepare(`UPDATE digest_batches SET ${mutation}`).run();
    const before = await env.DB.prepare("SELECT payload_json, payload_hash FROM digest_batches").first();
    const calls: Request[] = [];
    await runDigest(testEnv, scheduledAt + 900_000, successfulDelivery(calls));
    expect(calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first()).toEqual({ state: "needs_review", attempt_count: 1 });
    expect(await env.DB.prepare("SELECT payload_json, payload_hash FROM digest_batches").first()).toEqual(before);
  });

  it.each(["hide", "expire", "pause"])("revalidates %s at the first lease after formatting", async (change) => {
    await insertMessage();
    let transactions = 0;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (++transactions === 2) {
          if (change === "pause") await target.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'email_paused'").run();
          else await target.prepare(change === "hide" ? "UPDATE messages SET hidden_at = ?" : "UPDATE messages SET expires_at = ?").bind(scheduledAt).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const calls: Request[] = [];
    await runDigest({ ...testEnv, DB: db }, scheduledAt, successfulDelivery(calls));
    expect(transactions).toBe(2);
    expect(calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state, attempt_count, payload_json FROM digest_batches").first())
      .toEqual({ state: "pending", attempt_count: 0, payload_json: null });
  });

  it("does not call the provider when email is paused after the batch lease", async () => {
    await insertMessage();
    let transactions = 0;
    const db = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (++transactions === 2) {
          await target.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'email_paused'").run();
        }
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const calls: Request[] = [];

    await runDigest({ ...testEnv, DB: db }, scheduledAt, successfulDelivery(calls));

    expect(transactions).toBeGreaterThanOrEqual(2);
    expect(calls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT state, attempt_count FROM digest_batches").first())
      .toEqual({ state: "leased", attempt_count: 1 });
  });

  it.each([0, 89])("atomically reserves only one of two distinct batches with %i daily attempts used", async (used) => {
    for (const id of ["one", "two"]) {
      await insertMessage(`msg_${id}`);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO digest_batches (batch_id, interval_start, state, payload_hash, created_at) VALUES (?, ?, 'pending', 'unleased', ?)")
          .bind(`dgb_${id}`, id === "one" ? scheduledAt - 900_000 : scheduledAt, scheduledAt - 1),
        env.DB.prepare("INSERT INTO digest_messages (batch_id, message_id) VALUES (?, ?)").bind(`dgb_${id}`, `msg_${id}`)
      ]);
    }
    await env.DB.prepare("INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('email-global-daily', 'global', ?, ?, 90)")
      .bind(Math.floor(scheduledAt / 86_400_000) * 86_400, used).run();
    const calls: Request[] = [];
    // Give each scheduler a different already-observed candidate, retaining real
    // D1 execution for the competing reservation transactions.
    const forBatch = (id: string) => new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return (query: string) => target.prepare(query.includes("FROM digest_batches b")
        ? query.replace("FROM digest_batches b", `FROM (SELECT * FROM digest_batches WHERE batch_id = 'dgb_${id}') b`)
        : query);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await Promise.all(["one", "two"].map((id) => runDigest({ ...testEnv, DB: forBatch(id) }, scheduledAt, successfulDelivery(calls))));
    expect(calls).toHaveLength(1);
    expect((await env.DB.prepare("SELECT SUM(attempt_count) AS count FROM digest_batches").first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT used FROM quota_counters WHERE scope = 'email-global-daily'").first<{ used: number }>())?.used).toBe(used + 1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'digest_attempt'").first<{ count: number }>())?.count).toBe(1);
  });
});
