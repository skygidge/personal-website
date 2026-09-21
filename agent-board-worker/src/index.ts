import { handleAdmin } from "./admin";
import { runDigest } from "./digests";
import { getMessage, listMessages, postMessage, registerAgent } from "./messages";
import { runRetention } from "./retention";
import { openapiDocument } from "./openapi";

export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  EMERGENCY_WRITES_PAUSED?: string;
  EMERGENCY_EMAIL_PAUSED?: string;
  MESSAGE_RETENTION_DAYS?: string;
  API_KEY_HMAC_SECRET?: string;
  IP_HASH_SECRET?: string;
  CURSOR_SECRET?: string;
  ADMIN_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_TRACKING_DISABLED?: string;
  PUBLIC_API_ORIGIN?: string;
  D1_STORAGE_LIMIT_BYTES?: string;
}

const MAX_REQUEST_BYTES = 16 * 1024;

type ErrorCode = string;

interface BoardWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
  scheduled?(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void | Promise<void>;
}

function requestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function responseHeaders(publicRead = false): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });

  if (publicRead) headers.set("access-control-allow-origin", "*");
  return headers;
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return Response.json(
    { error: { code, message }, request_id: requestId() },
    { status, headers: responseHeaders() }
  );
}

function writesPaused(env: Env): boolean {
  return env.ENVIRONMENT === "production" && env.EMERGENCY_WRITES_PAUSED !== "false";
}

function retentionDays(env: Env): number {
  const configured = Number.parseInt(env.MESSAGE_RETENTION_DAYS ?? "90", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 90;
}

async function publicStatus(env: Env): Promise<Response> {
  if (writesPaused(env)) {
    const reads = env.CURSOR_SECRET ? "open" : "unavailable";
    return Response.json(
      { service: "agent-message-board", reads, registration: "paused", writes: "paused", message_retention_days: retentionDays(env) },
      { status: reads === "open" ? 200 : 503, headers: responseHeaders(true) }
    );
  }
  try {
    const state = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM board_state WHERE state_key IN ('writes_paused', 'capacity_paused') AND value != 'false'"
    ).first<{ count: number }>();
    const paused = (state?.count ?? 1) > 0;
    const reads = env.CURSOR_SECRET ? "open" : "unavailable";
    return Response.json(
      { service: "agent-message-board", reads, registration: paused ? "paused" : "open", writes: paused ? "paused" : "open", message_retention_days: retentionDays(env) },
      { status: reads === "open" ? 200 : 503, headers: responseHeaders(true) }
    );
  } catch {
    return Response.json(
      { service: "agent-message-board", reads: "unavailable", registration: "unavailable", writes: "unavailable", message_retention_days: retentionDays(env) },
      { status: 503, headers: responseHeaders(true) }
    );
  }
}

const worker: BoardWorker = {
  async fetch(request, env): Promise<Response> {
    if (request.method === "POST") {
      const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        return errorResponse(413, "payload_too_large", "Request body exceeds 16 KiB.");
      }
    }

    const url = new URL(request.url);
    const id = requestId();
    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, id);
    }
    if (request.method === "POST" && url.pathname === "/api/register") {
      return (await registerAgent(request, env, id)).response;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      return postMessage(request, env, id);
    }
    if (request.method === "GET" && url.pathname === "/api/messages") {
      return listMessages(request, env, id);
    }
    if (request.method === "GET" && /^\/api\/messages\/msg_[a-z0-9]+$/u.test(url.pathname)) {
      return getMessage(url.pathname.slice("/api/messages/".length), request, env, id);
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return publicStatus(env);
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return Response.json(openapiDocument, { headers: responseHeaders(true) });
    }

    return errorResponse(404, "not_found", "Route not found.");
  },
  scheduled(event, env, ctx): void {
    ctx.waitUntil((async () => {
      await runDigest(env, event.scheduledTime);
      const scheduled = new Date(event.scheduledTime);
      if (scheduled.getUTCHours() === 0 && scheduled.getUTCMinutes() === 0) {
        await runRetention(env, event.scheduledTime);
      }
    })());
  }
};

export default worker;
