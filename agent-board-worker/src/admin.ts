import { bearerToken } from "./auth";
import type { Env } from "./index";
import { capacityReport } from "./retention";

type AdminError = {
  status: number;
  code: string;
  message: string;
};

function headers(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
}

function errorResponse(requestId: string, error: AdminError): Response {
  return Response.json({ error: { code: error.code, message: error.message }, request_id: requestId }, { status: error.status, headers: headers() });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hasOwnerAccess(request: Request, env: Env): Promise<boolean> {
  const supplied = bearerToken(request.headers.get("authorization")) ?? "";
  const expected = env.ADMIN_TOKEN ?? "";
  const [suppliedDigest, expectedDigest] = await Promise.all([digest(supplied), digest(expected)]);
  let difference = suppliedDigest.byteLength ^ expectedDigest.byteLength;
  for (let index = 0; index < Math.min(suppliedDigest.byteLength, expectedDigest.byteLength); index += 1) {
    difference |= suppliedDigest[index]! ^ expectedDigest[index]!;
  }
  return Boolean(supplied && expected && difference === 0);
}

function auditStatement(db: D1Database, timestamp: number, action: string, targetType: string | null, targetId: string | null, requestId: string, outcome: "success" | "not_found") {
  return db.prepare(
    "INSERT INTO audit_events (event_id, occurred_at, actor, action, target_type, target_id, request_id, outcome) VALUES (?, ?, 'owner', ?, ?, ?, ?, ?)"
  ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, timestamp, action, targetType, targetId, requestId, outcome);
}

async function setBoardState(env: Env, requestId: string, stateKey: "writes_paused" | "email_paused", value: "true" | "false", action: string): Promise<Response> {
  const timestamp = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE board_state SET value = ?, updated_at = ? WHERE state_key = ?").bind(value, timestamp, stateKey),
      auditStatement(env.DB, timestamp, action, "board_state", stateKey, requestId, "success")
    ]);
    return Response.json({ state: stateKey, value: value === "true" ? "paused" : "open", request_id: requestId }, { headers: headers() });
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Administrative control is unavailable." });
  }
}

async function revokeAgent(env: Env, requestId: string, agentId: string): Promise<Response> {
  const timestamp = Date.now();
  try {
    const existing = await env.DB.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").bind(agentId).first<{ agent_id: string }>();
    const outcome = existing ? "success" : "not_found";
    await env.DB.batch([
      ...(existing ? [env.DB.prepare("UPDATE agents SET revoked_at = COALESCE(revoked_at, ?) WHERE agent_id = ?").bind(timestamp, agentId)] : []),
      auditStatement(env.DB, timestamp, "revoke_agent", "agent", agentId, requestId, outcome)
    ]);
    return existing
      ? Response.json({ agent_id: agentId, revoked: true, request_id: requestId }, { headers: headers() })
      : errorResponse(requestId, { status: 404, code: "not_found", message: "Agent not found." });
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Administrative control is unavailable." });
  }
}

async function hideMessage(env: Env, requestId: string, messageId: string): Promise<Response> {
  const timestamp = Date.now();
  try {
    const existing = await env.DB.prepare("SELECT message_id FROM messages WHERE message_id = ? AND hidden_at IS NULL").bind(messageId).first<{ message_id: string }>();
    const outcome = existing ? "success" : "not_found";
    await env.DB.batch([
      ...(existing ? [env.DB.prepare(
        "DELETE FROM digest_messages WHERE message_id = ? AND batch_id IN (SELECT batch_id FROM digest_batches WHERE state = 'pending')"
      ).bind(messageId)] : []),
      ...(existing ? [env.DB.prepare("UPDATE messages SET hidden_at = ?, hidden_reason = 'owner' WHERE message_id = ? AND hidden_at IS NULL").bind(timestamp, messageId)] : []),
      auditStatement(env.DB, timestamp, "hide_message", "message", messageId, requestId, outcome)
    ]);
    return existing
      ? Response.json({ message_id: messageId, hidden: true, request_id: requestId }, { headers: headers() })
      : errorResponse(requestId, { status: 404, code: "not_found", message: "Message not found." });
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Administrative control is unavailable." });
  }
}

async function privateStatus(env: Env, requestId: string): Promise<Response> {
  try {
    const [states, quota, digests] = await Promise.all([
      env.DB.prepare("SELECT state_key, value FROM board_state").all<{ state_key: string; value: string }>(),
      env.DB.prepare("SELECT COALESCE(SUM(used), 0) AS used FROM quota_counters").first<{ used: number }>(),
      env.DB.prepare("SELECT state, COUNT(*) AS count FROM digest_batches GROUP BY state").all<{ state: string; count: number }>(),
    ]);
    const switches = new Map(states.results.map((state) => [state.state_key, state.value !== "false"]));
    const capacityPaused = switches.get("capacity_paused") || false;
    const capacity = capacityReport(env, states.results.find((state) => state.state_key === "capacity_bytes")?.value);
    return Response.json({
      writes_paused: switches.get("writes_paused") || capacityPaused,
      email_paused: switches.get("email_paused") || false,
      capacity: { ...capacity, state: capacityPaused ? "paused" : capacity.state },
      quota_events: quota?.used ?? 0,
      digest_batches: Object.fromEntries(digests.results.map((batch) => [batch.state, batch.count])),
      provider: env.RESEND_API_KEY && env.RESEND_TRACKING_DISABLED === "true" ? "ready" : "not_configured",
      request_id: requestId
    }, { headers: headers() });
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Administrative status is unavailable." });
  }
}

export async function handleAdmin(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!await hasOwnerAccess(request, env)) {
    return errorResponse(requestId, { status: 401, code: "unauthorized", message: "Owner authorization is required." });
  }

  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/admin/pause-writes") return setBoardState(env, requestId, "writes_paused", "true", "pause_writes");
  if (request.method === "POST" && path === "/admin/resume-writes") return setBoardState(env, requestId, "writes_paused", "false", "resume_writes");
  if (request.method === "POST" && path === "/admin/pause-email") return setBoardState(env, requestId, "email_paused", "true", "pause_email");
  if (request.method === "POST" && path === "/admin/resume-email") return setBoardState(env, requestId, "email_paused", "false", "resume_email");
  if (request.method === "GET" && path === "/admin/status") return privateStatus(env, requestId);

  const revoke = path.match(/^\/admin\/agents\/(agt_[a-z0-9]+)\/revoke$/u);
  if (request.method === "POST" && revoke) return revokeAgent(env, requestId, revoke[1]!);
  const hide = path.match(/^\/admin\/messages\/(msg_[a-z0-9]+)\/hide$/u);
  if (request.method === "POST" && hide) return hideMessage(env, requestId, hide[1]!);

  return errorResponse(requestId, { status: 404, code: "not_found", message: "Administrative route not found." });
}
