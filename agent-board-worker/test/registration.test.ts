import worker, { type Env } from "../src/index";
import { authenticateAgent } from "../src/auth";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "development",
  EMERGENCY_WRITES_PAUSED: "false",
  EMERGENCY_EMAIL_PAUSED: "true",
  MESSAGE_RETENTION_DAYS: "90",
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret",
  IP_HASH_SECRET: "test-ip-hash-secret"
};

async function resetBoard(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM agents"),
    env.DB.prepare("DELETE FROM quota_counters"),
    env.DB.prepare("UPDATE board_state SET value = 'false' WHERE state_key = 'writes_paused'")
  ]);
}

function registrationRequest(body: unknown, address = "203.0.113.8"): Request {
  return new Request("https://board.example/api/register", {
    method: "POST",
    headers: {
      "cf-connecting-ip": address,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("agent registration", () => {
  beforeEach(resetBoard);

  it("creates a unique one-time key for a valid registration", async () => {
    const response = await worker.fetch(registrationRequest({
      display_name: "ResearchAgent-7",
      description: "Independent research and synthesis agent"
    }), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = await response.json() as Record<string, string>;
    const secondResponse = await worker.fetch(registrationRequest({
      display_name: "ResearchAgent-8",
      description: "Independent research and synthesis agent"
    }, "203.0.113.9"), testEnv, {} as ExecutionContext);
    const second = await secondResponse.json() as Record<string, string>;

    expect(first).toMatchObject({
      agent_id: expect.stringMatching(/^agt_/),
      api_key: expect.stringMatching(/^amb_live_/),
      created_at: expect.any(String),
      posting_status: "open",
      request_id: expect.any(String)
    });
    expect(first.api_key).not.toBe(second.api_key);
    expect(first.agent_id).not.toBe(second.agent_id);
  });

  it("does not disclose stored credential or IP hashes", async () => {
    const response = await worker.fetch(registrationRequest({
      display_name: "PrivacyAgent",
      description: ""
    }), testEnv, {} as ExecutionContext);
    const body = await response.json() as Record<string, string>;
    const stored = await env.DB.prepare(
      "SELECT key_hash, ip_hash FROM agents WHERE agent_id = ?"
    ).bind(body.agent_id).first<{ key_hash: string; ip_hash: string }>();

    expect(stored).toBeTruthy();
    expect(stored?.key_hash).not.toBe(body.api_key);
    expect(stored?.ip_hash).not.toBe("203.0.113.8");
    expect(JSON.stringify(body)).not.toContain(stored?.key_hash ?? "");
    expect(JSON.stringify(body)).not.toContain(stored?.ip_hash ?? "");
  });

  it("authenticates an issued key until that agent is revoked", async () => {
    const registration = await worker.fetch(registrationRequest({
      display_name: "RevocableAgent",
      description: ""
    }), testEnv, {} as ExecutionContext);
    const issued = await registration.json() as { agent_id: string; api_key: string };

    await expect(authenticateAgent(env.DB, testEnv.API_KEY_HMAC_SECRET!, issued.api_key)).resolves.toMatchObject({
      agentId: issued.agent_id
    });
    await env.DB.prepare("UPDATE agents SET revoked_at = 1 WHERE agent_id = ?").bind(issued.agent_id).run();
    await expect(authenticateAgent(env.DB, testEnv.API_KEY_HMAC_SECRET!, issued.api_key)).resolves.toBeNull();
  });

  it("rejects unknown registration fields without storing an agent", async () => {
    const response = await worker.fetch(registrationRequest({
      display_name: "StrictAgent",
      description: "",
      ignored: true
    }), testEnv, {} as ExecutionContext);
    const agents = await env.DB.prepare("SELECT COUNT(*) AS count FROM agents").first<{ count: number }>();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(agents?.count).toBe(0);
  });

  it("counts Unicode code points rather than UTF-16 units", async () => {
    const valid = await worker.fetch(registrationRequest({
      display_name: "😀".repeat(80),
      description: ""
    }), testEnv, {} as ExecutionContext);
    const invalid = await worker.fetch(registrationRequest({
      display_name: "😀".repeat(81),
      description: ""
    }, "203.0.113.9"), testEnv, {} as ExecutionContext);

    expect(valid.status).toBe(201);
    expect(invalid.status).toBe(400);
  });

  it("aggregates IPv4 spellings into the same registration burst quota", async () => {
    const first = await worker.fetch(registrationRequest({ display_name: "One", description: "" }, "203.0.113.8"), testEnv, {} as ExecutionContext);
    const second = await worker.fetch(registrationRequest({ display_name: "Two", description: "" }, "203.0.113.008"), testEnv, {} as ExecutionContext);
    const third = await worker.fetch(registrationRequest({ display_name: "Three", description: "" }, "203.0.113.8"), testEnv, {} as ExecutionContext);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
    await expect(third.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
  });

  it("does not let concurrent registrations overshoot one IP burst quota", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, (_, index) => worker.fetch(registrationRequest({
      display_name: `Concurrent ${index}`,
      description: ""
    }), testEnv, {} as ExecutionContext)));
    const counter = await env.DB.prepare(
      "SELECT used FROM quota_counters WHERE scope = 'registration-ip-burst'"
    ).first<{ used: number }>();

    expect(responses.filter((response) => response.status === 201)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(8);
    expect(counter?.used).toBe(2);
  });

  it("enforces the global daily registration quota atomically", async () => {
    for (let index = 0; index < 50; index += 1) {
      const response = await worker.fetch(registrationRequest({
        display_name: `Agent ${index}`,
        description: ""
      }, `2001:db8::${index + 1}`), testEnv, {} as ExecutionContext);
      expect(response.status).toBe(201);
    }

    const limited = await worker.fetch(registrationRequest({
      display_name: "Agent 50",
      description: ""
    }, "2001:db8::99"), testEnv, {} as ExecutionContext);
    const global = await env.DB.prepare(
      "SELECT used FROM quota_counters WHERE scope = 'registration-global-daily'"
    ).first<{ used: number }>();

    expect(limited.status).toBe(429);
    expect(global?.used).toBe(50);
  });

  it("refuses registration when the database pause switch is on", async () => {
    await env.DB.prepare("UPDATE board_state SET value = 'true' WHERE state_key = 'writes_paused'").run();

    const response = await worker.fetch(registrationRequest({ display_name: "Paused", description: "" }), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("900");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "writes_paused" } });
  });

  it("fails closed without a trusted Cloudflare client address", async () => {
    const response = await worker.fetch(new Request("https://board.example/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "No IP", description: "" })
    }), testEnv, {} as ExecutionContext);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("fails closed when storage is unavailable", async () => {
    const unavailableEnv: Env = {
      ...testEnv,
      DB: { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database
    };

    const response = await worker.fetch(registrationRequest({ display_name: "No storage", description: "" }), unavailableEnv, {} as ExecutionContext);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "service_unavailable" } });
  });
});
