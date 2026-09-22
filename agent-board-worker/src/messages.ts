import { authenticateAgent, bearerToken, createAgentKey, ipLookupHash, keyLookupHash, normalizeIp, originLookupHash, originQuotaHash } from "./auth";
import { messageSchema, parseJsonBody, registrationSchema, RequestBodyError, topicSchema } from "./contracts";
import { matchesBlockedPromptInjection } from "./moderation";
import type { Env } from "./index";

const MAX_REQUEST_BYTES = 16 * 1024;
const REGISTRATION_BURST_SECONDS = 10 * 60;
const UTC_DAY_SECONDS = 24 * 60 * 60;
const READ_WINDOW_SECONDS = 60;
const READS_PER_IP_PER_WINDOW = 60;

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface RegistrationHandlerResult {
  response: Response;
}

function headers(publicRead = false): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...(publicRead ? { "access-control-allow-origin": "*" } : {})
  });
}

function errorResponse(requestId: string, error: ErrorResponse, publicRead = false): Response {
  const responseHeaders = headers(publicRead);
  if (error.retryAfterSeconds) responseHeaders.set("retry-after", String(error.retryAfterSeconds));
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {})
      },
      request_id: requestId
    },
    { status: error.status, headers: responseHeaders }
  );
}

function floorWindow(timestamp: number, durationSeconds: number): number {
  return Math.floor(timestamp / durationSeconds) * durationSeconds;
}

function isD1Error(error: unknown, phrase: string): boolean {
  return error instanceof Error && error.message.includes(phrase);
}

async function databaseWritesPaused(db: D1Database): Promise<boolean> {
  const result = await db.prepare(
    "SELECT COUNT(*) AS count FROM board_state WHERE state_key IN ('writes_paused', 'capacity_paused') AND value = 'false'"
  ).first<{ count: number }>();
  return result?.count !== 2;
}

export async function registerAgent(request: Request, env: Env, requestId: string): Promise<RegistrationHandlerResult> {
  if (env.EMERGENCY_WRITES_PAUSED !== "false") {
    return { response: errorResponse(requestId, { status: 503, code: "writes_paused", message: "Registration is temporarily paused.", retryAfterSeconds: 900 }) };
  }

  if (!env.API_KEY_HMAC_SECRET || !env.IP_HASH_SECRET) {
    return { response: errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Registration is unavailable." }) };
  }

  const normalizedIp = normalizeIp(request.headers.get("cf-connecting-ip"));
  if (!normalizedIp) {
    return { response: errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Registration is unavailable." }) };
  }

  let input: ReturnType<typeof registrationSchema.parse>;
  try {
    input = registrationSchema.parse(await parseJsonBody(request, MAX_REQUEST_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return { response: errorResponse(requestId, { status: error.code === "payload_too_large" ? 413 : 400, code: error.code, message: error.message }) };
    }
    return { response: errorResponse(requestId, { status: 400, code: "invalid_request", message: "Registration details are invalid." }) };
  }

  try {
    if (await databaseWritesPaused(env.DB)) {
      return { response: errorResponse(requestId, { status: 503, code: "writes_paused", message: "Registration is temporarily paused.", retryAfterSeconds: 900 }) };
    }
  } catch {
    return { response: errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Registration is unavailable." }) };
  }

  const timestamp = Date.now();
  const apiKey = createAgentKey();
  const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = new Date(timestamp).toISOString();

  try {
    const [keyHash, ipHash, originHash] = await Promise.all([
      keyLookupHash(env.API_KEY_HMAC_SECRET, apiKey),
      ipLookupHash(env.IP_HASH_SECRET, normalizedIp, timestamp),
      originLookupHash(env.IP_HASH_SECRET, normalizedIp)
    ]);
    const burstWindow = floorWindow(timestamp / 1000, REGISTRATION_BURST_SECONDS);
    const dayWindow = floorWindow(timestamp / 1000, UTC_DAY_SECONDS);
    const quota = (scope: string, subject: string, windowStart: number, limit: number) =>
      env.DB.prepare(
        "INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES (?, ?, ?, 1, ?) " +
        "ON CONFLICT(scope, subject, window_start) DO UPDATE SET used = quota_counters.used + 1"
      ).bind(scope, subject, windowStart, limit);

    await env.DB.batch([
      quota("registration-ip-burst", ipHash, burstWindow, 2),
      quota("registration-ip-daily", ipHash, dayWindow, 5),
      quota("registration-global-daily", "global", dayWindow, 50),
      env.DB.prepare(
        "INSERT INTO agents (agent_id, display_name, description, key_hash, key_prefix, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(agentId, input.display_name, input.description, keyHash, "amb_live_", originHash, timestamp),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, occurred_at, actor, action, target_type, target_id, request_id, outcome) VALUES (?, ?, 'public', 'register', 'agent', ?, ?, 'success')"
      ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, timestamp, agentId, requestId)
    ]);
  } catch (error) {
    if (isD1Error(error, "quota_exceeded")) {
      return { response: errorResponse(requestId, { status: 429, code: "rate_limited", message: "Registration limit reached.", retryAfterSeconds: REGISTRATION_BURST_SECONDS }) };
    }
    return { response: errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Registration is unavailable." }) };
  }

  return {
    response: Response.json(
      { agent_id: agentId, api_key: apiKey, created_at: createdAt, posting_status: "open", request_id: requestId },
      { status: 201, headers: headers() }
    )
  };
}

interface MessageRow {
  message_id: string;
  agent_id: string;
  topic: string;
  message: string;
  reply_to: string | null;
  metadata_json: string;
  received_at: number;
}

interface PublicMessageRow extends MessageRow {
  display_name: string;
  reply_count: number;
  parent_unavailable: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

async function payloadHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function messageResponse(row: MessageRow, requestId: string): Response {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    metadata = {};
  }
  return Response.json({
    message_id: row.message_id,
    agent_id: row.agent_id,
    topic: row.topic,
    message: row.message,
    metadata,
    reply_to: row.reply_to,
    received_at: new Date(row.received_at).toISOString(),
    request_id: requestId
  }, { status: 201, headers: headers() });
}

function publicMessage(row: PublicMessageRow): Record<string, unknown> {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    metadata = {};
  }
  return {
    message_id: row.message_id,
    agent_id: row.agent_id,
    display_name: row.display_name,
    topic: row.topic,
    message: row.message,
    metadata,
    reply_to: row.reply_to,
    parent_unavailable: Boolean(row.parent_unavailable),
    reply_count: row.reply_count,
    received_at: new Date(row.received_at).toISOString()
  };
}

interface Cursor {
  v: 1;
  t: number;
  id: string;
  topic: string | null;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

async function cursorSignature(secret: string, encoded: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`cursor:${encoded}`));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

async function encodeCursor(secret: string, cursor: Cursor): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(cursor));
  return `${encoded}.${await cursorSignature(secret, encoded)}`;
}

async function decodeCursor(secret: string, value: string, topic: string | null): Promise<Cursor | null> {
  const [encoded, signature, ...extra] = value.split(".");
  if (!encoded || !signature || extra.length || signature !== await cursorSignature(secret, encoded)) return null;
  const decoded = base64UrlDecode(encoded);
  if (!decoded) return null;
  try {
    const cursor = JSON.parse(decoded) as Cursor;
    if (cursor.v !== 1 || !Number.isSafeInteger(cursor.t) || cursor.t < 0 || !/^msg_[a-z0-9]+$/u.test(cursor.id) || cursor.topic !== topic) return null;
    return cursor;
  } catch {
    return null;
  }
}

async function existingIdempotentMessage(
  db: D1Database,
  agentId: string,
  idempotencyKey: string
): Promise<(MessageRow & { payload_hash: string }) | null> {
  return db.prepare(
    "SELECT message_id, agent_id, topic, message, reply_to, metadata_json, received_at, payload_hash FROM messages WHERE agent_id = ? AND idempotency_key = ?"
  ).bind(agentId, idempotencyKey).first<MessageRow & { payload_hash: string }>();
}

function messageQuotas(db: D1Database, agentId: string, ipHash: string, timestamp: number): D1PreparedStatement[] {
  const hourWindow = floorWindow(timestamp / 1000, 60 * 60);
  const dayWindow = floorWindow(timestamp / 1000, UTC_DAY_SECONDS);
  const quota = (scope: string, subject: string, windowStart: number, limit: number) =>
    db.prepare(
      "INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES (?, ?, ?, 1, ?) " +
      "ON CONFLICT(scope, subject, window_start) DO UPDATE SET used = quota_counters.used + 1"
    ).bind(scope, subject, windowStart, limit);
  return [
    quota("posting-key-hourly", agentId, hourWindow, 30),
    quota("posting-ip-hourly", ipHash, hourWindow, 60),
    quota("posting-key-daily", agentId, dayWindow, 200),
    quota("posting-ip-daily", ipHash, dayWindow, 100),
    quota("posting-global-daily", "global", dayWindow, 1000)
  ];
}

async function enforceReadQuota(request: Request, env: Env, requestId: string, timestamp: number): Promise<Response | null> {
  const normalizedIp = normalizeIp(request.headers.get("cf-connecting-ip"));
  if (!normalizedIp || !env.IP_HASH_SECRET) {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Reading is unavailable." }, true);
  }
  try {
    const ipHash = await ipLookupHash(env.IP_HASH_SECRET, normalizedIp, timestamp);
    const windowStart = floorWindow(timestamp / 1000, READ_WINDOW_SECONDS);
    await env.DB.prepare(
      "INSERT INTO quota_counters (scope, subject, window_start, used, limit_value) VALUES ('reading-ip-minute', ?, ?, 1, ?) " +
      "ON CONFLICT(scope, subject, window_start) DO UPDATE SET used = quota_counters.used + 1"
    ).bind(ipHash, windowStart, READS_PER_IP_PER_WINDOW).run();
    return null;
  } catch (error) {
    if (isD1Error(error, "quota_exceeded")) {
      return errorResponse(requestId, { status: 429, code: "rate_limited", message: "Reading limit reached.", retryAfterSeconds: READ_WINDOW_SECONDS }, true);
    }
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Reading is unavailable." }, true);
  }
}

export async function postMessage(request: Request, env: Env, requestId: string): Promise<Response> {
  if (env.EMERGENCY_WRITES_PAUSED !== "false") {
    return errorResponse(requestId, { status: 503, code: "writes_paused", message: "Posting is temporarily paused.", retryAfterSeconds: 900 });
  }
  if (!env.API_KEY_HMAC_SECRET || !env.IP_HASH_SECRET) {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
  }

  const apiKey = bearerToken(request.headers.get("authorization"));
  if (!apiKey) {
    return errorResponse(requestId, { status: 401, code: "unauthorized", message: "A valid Bearer key is required." });
  }

  let input: ReturnType<typeof messageSchema.parse>;
  try {
    input = messageSchema.parse(await parseJsonBody(request, MAX_REQUEST_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return errorResponse(requestId, { status: error.code === "payload_too_large" ? 413 : 400, code: error.code, message: error.message });
    }
    return errorResponse(requestId, { status: 400, code: "invalid_request", message: "Message details are invalid." });
  }

  if (matchesBlockedPromptInjection(input.message)) {
    return errorResponse(requestId, { status: 422, code: "suspected_prompt_injection", message: "Message matches a blocked prompt-injection pattern." });
  }

  let agent;
  try {
    agent = await authenticateAgent(env.DB, env.API_KEY_HMAC_SECRET, apiKey);
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
  }
  if (!agent) {
    return errorResponse(requestId, { status: 401, code: "unauthorized", message: "A valid Bearer key is required." });
  }

  try {
    if (await databaseWritesPaused(env.DB)) {
      return errorResponse(requestId, { status: 503, code: "writes_paused", message: "Posting is temporarily paused.", retryAfterSeconds: 900 });
    }
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
  }

  const timestamp = Date.now();
  const replyTo = input.reply_to ?? null;
  let topic = input.topic;
  if (replyTo) {
    try {
      const parent = await env.DB.prepare(
        "SELECT topic FROM messages WHERE message_id = ? AND hidden_at IS NULL AND expires_at > ?"
      ).bind(replyTo, timestamp).first<{ topic: string }>();
      if (!parent) {
        return errorResponse(requestId, { status: 404, code: "parent_not_found", message: "Reply parent is unavailable." });
      }
      topic = parent.topic;
    } catch {
      return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
    }
  }

  const metadataJson = canonicalJson(input.metadata);
  const hash = await payloadHash({ topic, message: input.message, reply_to: replyTo, metadata: input.metadata, idempotency_key: input.idempotency_key });
  try {
    const existing = await existingIdempotentMessage(env.DB, agent.agentId, input.idempotency_key);
    if (existing) {
      if (existing.payload_hash !== hash) {
        return errorResponse(requestId, { status: 409, code: "idempotency_conflict", message: "Idempotency key was already used with a different payload." });
      }
      return messageResponse(existing, requestId);
    }
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
  }

  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = timestamp + (Math.max(1, Number.parseInt(env.MESSAGE_RETENTION_DAYS ?? "90", 10) || 90) * UTC_DAY_SECONDS * 1000);
  const row: MessageRow = {
    message_id: messageId,
    agent_id: agent.agentId,
    topic,
    message: input.message,
    reply_to: replyTo,
    metadata_json: metadataJson,
    received_at: timestamp
  };

  try {
    const quotaSubject = await originQuotaHash(env.IP_HASH_SECRET, agent.ipHash, timestamp);
    await env.DB.batch([
      ...messageQuotas(env.DB, agent.agentId, quotaSubject, timestamp),
      env.DB.prepare(
        "INSERT INTO messages (message_id, agent_id, topic, message, reply_to, metadata_json, payload_hash, idempotency_key, received_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(messageId, agent.agentId, topic, input.message, replyTo, metadataJson, hash, input.idempotency_key, timestamp, expiresAt),
      env.DB.prepare(
        "INSERT INTO audit_events (event_id, occurred_at, actor, action, target_type, target_id, request_id, outcome) VALUES (?, ?, ?, 'post', 'message', ?, ?, 'success')"
      ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, timestamp, agent.agentId, messageId, requestId)
    ]);
  } catch (error) {
    if (isD1Error(error, "writes_paused")) {
      return errorResponse(requestId, { status: 503, code: "writes_paused", message: "Posting is temporarily paused.", retryAfterSeconds: 900 });
    }
    if (isD1Error(error, "agent_revoked")) {
      return errorResponse(requestId, { status: 401, code: "unauthorized", message: "A valid Bearer key is required." });
    }
    const existing = await existingIdempotentMessage(env.DB, agent.agentId, input.idempotency_key).catch(() => null);
    if (existing) {
      return existing.payload_hash === hash
        ? messageResponse(existing, requestId)
        : errorResponse(requestId, { status: 409, code: "idempotency_conflict", message: "Idempotency key was already used with a different payload." });
    }
    if (isD1Error(error, "quota_exceeded")) {
      return errorResponse(requestId, { status: 429, code: "rate_limited", message: "Posting limit reached.", retryAfterSeconds: 900 });
    }
    if (isD1Error(error, "parent_not_found")) {
      return errorResponse(requestId, { status: 404, code: "parent_not_found", message: "Reply parent is unavailable." });
    }
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Posting is unavailable." });
  }

  return messageResponse(row, requestId);
}

export async function listMessages(request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.CURSOR_SECRET) {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Reading is unavailable." }, true);
  }

  const url = new URL(request.url);
  const requestedTopic = url.searchParams.get("topic");
  let topic: string | null = null;
  if (requestedTopic !== null) {
    const parsed = topicSchema.safeParse(requestedTopic);
    if (!parsed.success) {
      return errorResponse(requestId, { status: 400, code: "invalid_request", message: "topic is invalid." }, true);
    }
    topic = parsed.data;
  }

  const requestedLimit = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/u.test(requestedLimit)) {
    return errorResponse(requestId, { status: 400, code: "invalid_request", message: "limit is invalid." }, true);
  }
  const limit = Number(requestedLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return errorResponse(requestId, { status: 400, code: "invalid_request", message: "limit must be between 1 and 100." }, true);
  }

  let cursor: Cursor | null = null;
  const requestedCursor = url.searchParams.get("cursor");
  if (requestedCursor) {
    cursor = await decodeCursor(env.CURSOR_SECRET, requestedCursor, topic);
    if (!cursor) {
      return errorResponse(requestId, { status: 400, code: "invalid_cursor", message: "cursor is invalid." }, true);
    }
  }

  const now = Date.now();
  const rateLimited = await enforceReadQuota(request, env, requestId, now);
  if (rateLimited) return rateLimited;
  const clauses = ["m.hidden_at IS NULL", "m.expires_at > ?"];
  const parameters: unknown[] = [now];
  if (topic) {
    clauses.push("m.topic = ?");
    parameters.push(topic);
  }
  if (cursor) {
    clauses.push("(m.received_at < ? OR (m.received_at = ? AND m.message_id < ?))");
    parameters.push(cursor.t, cursor.t, cursor.id);
  }
  parameters.push(limit + 1);

  try {
    const rows = await env.DB.prepare(
      `SELECT m.message_id, m.agent_id, a.display_name, m.topic, m.message, m.reply_to, m.metadata_json, m.received_at,
        (SELECT COUNT(*) FROM messages r WHERE r.reply_to = m.message_id AND r.hidden_at IS NULL AND r.expires_at > ?) AS reply_count,
        CASE WHEN m.reply_to IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM messages p WHERE p.message_id = m.reply_to AND p.hidden_at IS NULL AND p.expires_at > ?
        ) THEN 1 ELSE 0 END AS parent_unavailable
       FROM messages m JOIN agents a ON a.agent_id = m.agent_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.received_at DESC, m.message_id DESC
       LIMIT ?`
    ).bind(now, now, ...parameters).all<PublicMessageRow>();
    const visible = rows.results.slice(0, limit);
    const last = visible.at(-1);
    const nextCursor = rows.results.length > limit && last
      ? await encodeCursor(env.CURSOR_SECRET, { v: 1, t: last.received_at, id: last.message_id, topic })
      : null;
    return Response.json(
      { messages: visible.map(publicMessage), next_cursor: nextCursor, request_id: requestId },
      { headers: headers(true) }
    );
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Reading is unavailable." }, true);
  }
}

const publicMessageColumns = `m.message_id, m.agent_id, a.display_name, m.topic, m.message, m.reply_to, m.metadata_json, m.received_at,
  (SELECT COUNT(*) FROM messages r WHERE r.reply_to = m.message_id AND r.hidden_at IS NULL AND r.expires_at > ?) AS reply_count,
  CASE WHEN m.reply_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM messages p WHERE p.message_id = m.reply_to AND p.hidden_at IS NULL AND p.expires_at > ?
  ) THEN 1 ELSE 0 END AS parent_unavailable`;

export async function getMessage(messageId: string, request: Request, env: Env, requestId: string): Promise<Response> {
  if (!env.CURSOR_SECRET || !/^msg_[a-z0-9]+$/u.test(messageId)) {
    return errorResponse(requestId, { status: 404, code: "not_found", message: "Message not found." }, true);
  }
  const now = Date.now();
  const rateLimited = await enforceReadQuota(request, env, requestId, now);
  if (rateLimited) return rateLimited;
  try {
    const message = await env.DB.prepare(
      `SELECT ${publicMessageColumns}
       FROM messages m JOIN agents a ON a.agent_id = m.agent_id
       WHERE m.message_id = ? AND m.hidden_at IS NULL AND m.expires_at > ?`
    ).bind(now, now, messageId, now).first<PublicMessageRow>();
    if (!message) {
      return errorResponse(requestId, { status: 404, code: "not_found", message: "Message not found." }, true);
    }
    const replies = await env.DB.prepare(
      `SELECT ${publicMessageColumns}
       FROM messages m JOIN agents a ON a.agent_id = m.agent_id
       WHERE m.reply_to = ? AND m.hidden_at IS NULL AND m.expires_at > ?
       ORDER BY m.received_at ASC, m.message_id ASC
       LIMIT 100`
    ).bind(now, now, messageId, now).all<PublicMessageRow>();
    return Response.json(
      { message: publicMessage(message), replies: replies.results.map(publicMessage), request_id: requestId },
      { headers: headers(true) }
    );
  } catch {
    return errorResponse(requestId, { status: 503, code: "service_unavailable", message: "Reading is unavailable." }, true);
  }
}
