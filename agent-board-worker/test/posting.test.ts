import worker, { type Env } from "../src/index";
import { originQuotaHash } from "../src/auth";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testEnv: Env = {
  DB: env.DB,
  ENVIRONMENT: "development",
  EMERGENCY_WRITES_PAUSED: "false",
  EMERGENCY_EMAIL_PAUSED: "true",
  MESSAGE_RETENTION_DAYS: "90",
  API_KEY_HMAC_SECRET: "test-api-key-hmac-secret",
  IP_HASH_SECRET: "test-ip-hash-secret",
  CURSOR_SECRET: "test-cursor-secret"
};

const start = Date.UTC(2026, 9, 3, 12, 0, 29, 500);
let now: number;

async function createAgent(): Promise<string> {
  const response = await worker.fetch(new Request("https://board.example/api/register", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.8", "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Unlimited posting test", description: "" })
  }), testEnv, {} as ExecutionContext);
  expect(response.status).toBe(201);
  return (await response.json() as { api_key: string }).api_key;
}

function post(apiKey: string, key: string, message = "A distinct update.", runtime = testEnv): Promise<Response> {
  return worker.fetch(new Request("https://board.example/api/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ topic: "posting", message, idempotency_key: key })
  }), runtime, {} as ExecutionContext);
}

describe("unlimited authenticated posting", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM digest_messages"),
      env.DB.prepare("DELETE FROM digest_batches"),
      env.DB.prepare("DELETE FROM messages"),
      env.DB.prepare("DELETE FROM audit_events"),
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM quota_counters"),
      env.DB.prepare("INSERT OR REPLACE INTO board_state (state_key, value, updated_at) VALUES ('writes_paused', 'false', 0), ('capacity_paused', 'false', 0)")
    ]);
    now = start;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("accepts more than the former hourly limit without spacing new messages", async () => {
    const key = await createAgent();
    for (let i = 0; i < 31; i += 1) {
      const response = await post(key, `unlimited-immediate-${String(i).padStart(3, "0")}`);
      expect(response.status).toBe(201);
      expect(response.headers.get("retry-after")).toBeNull();
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(31);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM quota_counters WHERE scope LIKE 'posting-%'").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'post'").first("count")).toBe(31);
  });

  it("accepts all distinct concurrent messages from one agent", async () => {
    const key = await createAgent();
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => post(key, `unlimited-racing-${i}`)));
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ message_id: string }>));
    expect(new Set(bodies.map((r) => r.message_id)).size).toBe(10);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(10);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM quota_counters WHERE scope LIKE 'posting-%'").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'post'").first("count")).toBe(10);
  });

  it("returns the original message for a retry while conflicting reuse stays a 409", async () => {
    const key = await createAgent();
    const first = await post(key, "unlimited-idempotent");
    const retry = await post(key, "unlimited-idempotent");
    expect(retry.status).toBe(201);
    expect((await retry.json() as { message_id: string }).message_id).toBe((await first.json() as { message_id: string }).message_id);
    expect((await post(key, "unlimited-idempotent", "Changed payload.")).status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM quota_counters WHERE scope LIKE 'posting-%'").first("count")).toBe(0);
  });

  it("accepts new messages from agents that share a registration origin", async () => {
    const first = await createAgent();
    const second = await createAgent();
    expect((await post(first, "unlimited-agent-one")).status).toBe(201);
    expect((await post(second, "unlimited-agent-two")).status).toBe(201);
  });

  it("ignores exhausted legacy hourly and daily counters without changing them", async () => {
    const key = await createAgent();
    const first = await post(key, "unlimited-daily-seed");
    expect(first.status).toBe(201);
    const { agent_id } = await first.json() as { agent_id: string };
    const origin = await env.DB.prepare("SELECT ip_hash FROM agents WHERE agent_id = ?").bind(agent_id).first<string>("ip_hash");
    const originSubject = await originQuotaHash(testEnv.IP_HASH_SECRET!, origin!, now);
    const day = Math.floor(now / 1000 / 86400) * 86400;
    const hour = Math.floor(now / 1000 / 3600) * 3600;
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO quota_counters VALUES ('posting-key-hourly', ?, ?, 30, 30)").bind(agent_id, hour),
      env.DB.prepare("INSERT OR REPLACE INTO quota_counters VALUES ('posting-ip-hourly', ?, ?, 60, 60)").bind(originSubject, hour),
      env.DB.prepare("INSERT OR REPLACE INTO quota_counters VALUES ('posting-key-daily', ?, ?, 200, 200)").bind(agent_id, day),
      env.DB.prepare("INSERT OR REPLACE INTO quota_counters VALUES ('posting-ip-daily', ?, ?, 100, 100)").bind(originSubject, day),
      env.DB.prepare("INSERT OR REPLACE INTO quota_counters VALUES ('posting-global-daily', 'global', ?, 1000, 1000)").bind(day)
    ]);
    expect((await post(key, "unlimited-daily-ignored")).status).toBe(201);
    const counters = await env.DB.prepare("SELECT used FROM quota_counters WHERE scope LIKE 'posting-%' ORDER BY used").all<{ used: number }>();
    expect(counters.results.map((r) => r.used)).toEqual([30, 60, 100, 200, 1000]);
  });

  it.each(["pause", "revoke"])("keeps the %s control when state changes after preflight", async (control) => {
    const key = await createAgent();
    expect((await post(key, "unlimited-control-seed")).status).toBe(201);
    const runtime = { ...testEnv, DB: {
      prepare: env.DB.prepare.bind(env.DB),
      async batch(statements: D1PreparedStatement[]) {
        await env.DB.prepare(control === "pause"
          ? "UPDATE board_state SET value = 'true' WHERE state_key = 'writes_paused'"
          : "UPDATE agents SET revoked_at = 1").run();
        return env.DB.batch(statements);
      }
    } as D1Database };
    const rejected = await post(key, "unlimited-control-race", "Changed during preflight.", runtime);
    expect(rejected.status).toBe(control === "pause" ? 503 : 401);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: control === "pause" ? "writes_paused" : "unauthorized" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM messages").first("count")).toBe(1);
  });
});
