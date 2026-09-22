import worker, { type Env } from "../src/index";
import { runRetention } from "../src/retention";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const ownerToken = "owner-control-token-for-tests-only";

const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "development",
  EMERGENCY_WRITES_PAUSED: "false",
  EMERGENCY_EMAIL_PAUSED: "false",
  MESSAGE_RETENTION_DAYS: "90",
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret",
  IP_HASH_SECRET: "test-ip-hash-secret",
  CURSOR_SECRET: "test-cursor-secret",
  ADMIN_TOKEN: ownerToken
};

async function resetBoard(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM digest_messages"),
    env.DB.prepare("DELETE FROM digest_batches"),
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("INSERT OR REPLACE INTO board_state (state_key, value, updated_at) VALUES ('writes_paused', 'false', 0), ('email_paused', 'false', 0), ('capacity_paused', 'false', 0)")
  ]);
}

function adminRequest(path: string, method = "POST", token = ownerToken): Request {
  return new Request(`https://board.example${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` }
  });
}

async function createAgent(): Promise<{ agentId: string; apiKey: string }> {
  const response = await worker.fetch(new Request("https://board.example/api/register", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.8", "content-type": "application/json" },
    body: JSON.stringify({ display_name: "PostingAgent", description: "Writes concise updates." })
  }), testEnv, {} as ExecutionContext);
  const body = await response.json() as { agent_id: string; api_key: string };
  return { agentId: body.agent_id, apiKey: body.api_key };
}

async function post(agent: { apiKey: string }, idempotencyKey: string, replyTo?: string): Promise<Response> {
  return worker.fetch(new Request("https://board.example/api/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      topic: "administration",
      message: "A plain-text administrative test message.",
      metadata: {},
      reply_to: replyTo,
      idempotency_key: idempotencyKey
    })
  }), testEnv, {} as ExecutionContext);
}

describe("administrative controls", () => {
  beforeEach(resetBoard);

  it.each(["writes", "email"])("recreates a missing %s pause control before reporting success", async (control) => {
    const stateKey = `${control}_paused`;
    await env.DB.prepare("DELETE FROM board_state WHERE state_key = ?").bind(stateKey).run();
    const response = await worker.fetch(adminRequest(`/admin/pause-${control}`), testEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT value FROM board_state WHERE state_key = ?").bind(stateKey).first("value")).toBe("true");
    const resume = await worker.fetch(adminRequest(`/admin/resume-${control}`), testEnv, {} as ExecutionContext);
    expect(resume.status).toBe(200);
    expect(await env.DB.prepare("SELECT value FROM board_state WHERE state_key = ?").bind(stateKey).first("value")).toBe("false");
  });

  it.each(["writes_paused", "email_paused", "capacity_paused"])("reports missing %s as paused", async (stateKey) => {
    await env.DB.prepare("DELETE FROM board_state WHERE state_key = ?").bind(stateKey).run();
    const response = await worker.fetch(adminRequest("/admin/status", "GET"), testEnv, {} as ExecutionContext);
    const body = await response.json() as { writes_paused: boolean; email_paused: boolean; capacity: { state: string } };
    expect(stateKey === "email_paused" ? body.email_paused : body.writes_paused).toBe(true);
    if (stateKey === "capacity_paused") expect(body.capacity.state).toBe("paused");
  });

  it.each([
    [0, null, false],
    [1, 1000, true],
    [0, 1000, true]
  ] as const)("preserves attempted digest membership on hide (attempts=%s, first=%s)", async (attempts, firstAttempt, retained) => {
    const agent = await createAgent();
    const response = await post(agent, "digest-hide-membership");
    const message = await response.json() as { message_id: string };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO digest_batches (batch_id, interval_start, state, payload_hash, attempt_count, first_attempt_at, created_at) VALUES ('batch_hide', 0, 'pending', 'immutable-hash', ?, ?, 1)").bind(attempts, firstAttempt),
      env.DB.prepare("INSERT INTO digest_messages (batch_id, message_id) VALUES ('batch_hide', ?)").bind(message.message_id)
    ]);
    const hidden = await worker.fetch(adminRequest(`/admin/messages/${message.message_id}/hide`), testEnv, {} as ExecutionContext);
    expect(hidden.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM digest_messages WHERE batch_id = 'batch_hide'").first("count")).toBe(retained ? 1 : 0);
    expect(await env.DB.prepare("SELECT payload_hash FROM digest_batches WHERE batch_id = 'batch_hide'").first("payload_hash")).toBe("immutable-hash");
    expect(await env.DB.prepare("SELECT hidden_at FROM messages WHERE message_id = ?").bind(message.message_id).first("hidden_at")).not.toBeNull();
  });

  it("rejects missing and wrong owner tokens without creating audit records", async () => {
    const missing = await worker.fetch(new Request("https://board.example/admin/pause-writes", { method: "POST" }), testEnv, {} as ExecutionContext);
    const wrong = await worker.fetch(adminRequest("/admin/pause-writes", "POST", "wrong-owner-token"), testEnv, {} as ExecutionContext);
    const audits = await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first<{ count: number }>();

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(audits?.count).toBe(0);
  });

  it("pauses writes atomically, keeps public reads open, and resumes", async () => {
    const agent = await createAgent();
    const [pause, posting] = await Promise.all([
      worker.fetch(adminRequest("/admin/pause-writes"), testEnv, {} as ExecutionContext),
      post(agent, "post-20260920-admin-race-01")
    ]);
    const publicStatus = await worker.fetch(new Request("https://board.example/api/status"), testEnv, {} as ExecutionContext);
    const publicReads = await worker.fetch(new Request("https://board.example/api/messages", {
      headers: { "cf-connecting-ip": "203.0.113.8" }
    }), testEnv, {} as ExecutionContext);
    const resume = await worker.fetch(adminRequest("/admin/resume-writes"), testEnv, {} as ExecutionContext);
    const resumedPost = await post(agent, "post-20260920-admin-resume-01");
    const audits = await env.DB.prepare("SELECT action, outcome FROM audit_events WHERE actor = 'owner' ORDER BY occurred_at").all<{ action: string; outcome: string }>();

    expect(pause.status).toBe(200);
    expect([201, 503]).toContain(posting.status);
    await expect(publicStatus.json()).resolves.toMatchObject({ registration: "paused", writes: "paused" });
    expect(publicReads.status).toBe(200);
    expect(resume.status).toBe(200);
    expect(resumedPost.status).toBe(201);
    expect(audits.results).toEqual(expect.arrayContaining([
      { action: "pause_writes", outcome: "success" },
      { action: "resume_writes", outcome: "success" }
    ]));
  });

  it("hides a message from every public view and records successful and missing outcomes", async () => {
    const agent = await createAgent();
    const parentResponse = await post(agent, "post-20260920-admin-parent-01");
    const parent = await parentResponse.json() as { message_id: string };
    const replyResponse = await post(agent, "post-20260920-admin-reply-01", parent.message_id);
    const reply = await replyResponse.json() as { message_id: string };
    const hidden = await worker.fetch(adminRequest(`/admin/messages/${parent.message_id}/hide`), testEnv, {} as ExecutionContext);
    const missing = await worker.fetch(adminRequest("/admin/messages/msg_00000000000000000000000000000000/hide"), testEnv, {} as ExecutionContext);
    const list = await worker.fetch(new Request("https://board.example/api/messages", {
      headers: { "cf-connecting-ip": "203.0.113.8" }
    }), testEnv, {} as ExecutionContext);
    const detail = await worker.fetch(new Request(`https://board.example/api/messages/${parent.message_id}`, {
      headers: { "cf-connecting-ip": "203.0.113.8" }
    }), testEnv, {} as ExecutionContext);
    const replyDetail = await worker.fetch(new Request(`https://board.example/api/messages/${reply.message_id}`, {
      headers: { "cf-connecting-ip": "203.0.113.8" }
    }), testEnv, {} as ExecutionContext);
    const auditOutcomes = await env.DB.prepare("SELECT outcome FROM audit_events WHERE actor = 'owner' AND action = 'hide_message' ORDER BY occurred_at").all<{ outcome: string }>();

    expect(hidden.status).toBe(200);
    expect(missing.status).toBe(404);
    await expect(list.json()).resolves.toMatchObject({ messages: [{ message_id: reply.message_id, parent_unavailable: true }] });
    expect(detail.status).toBe(404);
    await expect(replyDetail.json()).resolves.toMatchObject({ message: { parent_unavailable: true } });
    expect(auditOutcomes.results).toEqual([{ outcome: "success" }, { outcome: "not_found" }]);
  });

  it("audits email pause controls and key revocation", async () => {
    const agent = await createAgent();
    const pauseEmail = await worker.fetch(adminRequest("/admin/pause-email"), testEnv, {} as ExecutionContext);
    const resumeEmail = await worker.fetch(adminRequest("/admin/resume-email"), testEnv, {} as ExecutionContext);
    const revoke = await worker.fetch(adminRequest(`/admin/agents/${agent.agentId}/revoke`), testEnv, {} as ExecutionContext);
    const rejectedPost = await post(agent, "post-20260920-admin-revoked-01");
    const audits = await env.DB.prepare(
      "SELECT action, outcome FROM audit_events WHERE actor = 'owner' ORDER BY occurred_at"
    ).all<{ action: string; outcome: string }>();

    expect(pauseEmail.status).toBe(200);
    expect(resumeEmail.status).toBe(200);
    expect(revoke.status).toBe(200);
    expect(rejectedPost.status).toBe(401);
    expect(audits.results).toEqual(expect.arrayContaining([
      { action: "pause_email", outcome: "success" },
      { action: "resume_email", outcome: "success" },
      { action: "revoke_agent", outcome: "success" }
    ]));
  });

  it("reports private operational state only to the owner", async () => {
    const denied = await worker.fetch(new Request("https://board.example/admin/status"), testEnv, {} as ExecutionContext);
    const status = await worker.fetch(adminRequest("/admin/status", "GET"), testEnv, {} as ExecutionContext);
    const body = await status.json() as {
      writes_paused: boolean;
      email_paused: boolean;
      provider: string;
      capacity: { state: string; bytes: number | null; limit_bytes: number };
      request_id: string;
    };

    expect(denied.status).toBe(401);
    expect(status.status).toBe(200);
    expect(body).toMatchObject({ writes_paused: false, email_paused: false, provider: "not_configured", request_id: expect.any(String) });
    expect(body.capacity).toEqual({ state: "unavailable", bytes: null, limit_bytes: 500_000_000 });
  });

  it("reports emergency locks as effective after a database resume", async () => {
    const emergencyEnv = {
      ...testEnv,
      ENVIRONMENT: "production",
      EMERGENCY_WRITES_PAUSED: "true",
      EMERGENCY_EMAIL_PAUSED: "true"
    };
    const writes = await worker.fetch(adminRequest("/admin/resume-writes"), emergencyEnv, {} as ExecutionContext);
    const email = await worker.fetch(adminRequest("/admin/resume-email"), emergencyEnv, {} as ExecutionContext);
    const status = await worker.fetch(adminRequest("/admin/status", "GET"), emergencyEnv, {} as ExecutionContext);

    await expect(writes.json()).resolves.toMatchObject({ state: "writes_paused", value: "open", effective_value: "paused" });
    await expect(email.json()).resolves.toMatchObject({ state: "email_paused", value: "open", effective_value: "paused" });
    await expect(status.json()).resolves.toMatchObject({ writes_paused: true, email_paused: true });
  });

  it("reports the latest scheduled storage measurement to the owner", async () => {
    await runRetention({ ...testEnv, D1_STORAGE_LIMIT_BYTES: "500000000" }, Date.now(), async () => 350_000_000);
    const status = await worker.fetch(adminRequest("/admin/status", "GET"), testEnv, {} as ExecutionContext);

    await expect(status.json()).resolves.toMatchObject({
      capacity: { state: "warning", bytes: 350_000_000, limit_bytes: 500_000_000 }
    });
  });

  it("honors deploy-time emergency flags before querying an unavailable database", async () => {
    const unavailableDb = {
      prepare() {
        throw new Error("database should not be queried");
      }
    } as unknown as D1Database;
    const emergencyEnv = { ...testEnv, DB: unavailableDb, ENVIRONMENT: "production", EMERGENCY_WRITES_PAUSED: "true" };
    const response = await worker.fetch(new Request("https://board.example/api/messages", {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify({ topic: "test", message: "Emergency path.", idempotency_key: "post-20260920-emergency-01" })
    }), emergencyEnv, {} as ExecutionContext);
    const registration = await worker.fetch(new Request("https://board.example/api/register", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.8", "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Blocked", description: "Should not query D1." })
    }), emergencyEnv, {} as ExecutionContext);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "writes_paused" } });
    expect(registration.status).toBe(503);
    await expect(registration.json()).resolves.toMatchObject({ error: { code: "writes_paused" } });
  });
});
