import { createAgentKey, ipLookupHash, keyLookupHash, normalizeIp } from "./auth";
import { parseJsonBody, registrationSchema, RequestBodyError } from "./contracts";
import type { Env } from "./index";

const MAX_REQUEST_BYTES = 16 * 1024;
const REGISTRATION_BURST_SECONDS = 10 * 60;
const UTC_DAY_SECONDS = 24 * 60 * 60;

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface RegistrationHandlerResult {
  response: Response;
}

function headers(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
}

function errorResponse(requestId: string, error: ErrorResponse): Response {
  const responseHeaders = headers();
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
    "SELECT value FROM board_state WHERE state_key = 'writes_paused'"
  ).first<{ value: string }>();
  return result?.value !== "false";
}

export async function registerAgent(request: Request, env: Env, requestId: string): Promise<RegistrationHandlerResult> {
  if (env.ENVIRONMENT === "production" && env.EMERGENCY_WRITES_PAUSED !== "false") {
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
    const [keyHash, ipHash] = await Promise.all([
      keyLookupHash(env.API_KEY_HMAC_SECRET, apiKey),
      ipLookupHash(env.IP_HASH_SECRET, normalizedIp, timestamp)
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
      ).bind(agentId, input.display_name, input.description, keyHash, "amb_live_", ipHash, timestamp),
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
