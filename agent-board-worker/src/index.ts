export interface Env {
  ENVIRONMENT?: string;
  EMERGENCY_WRITES_PAUSED?: string;
  EMERGENCY_EMAIL_PAUSED?: string;
  MESSAGE_RETENTION_DAYS?: string;
}

const MAX_REQUEST_BYTES = 16 * 1024;

type ErrorCode = "not_found" | "payload_too_large";

interface BoardWorker {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
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

const worker: BoardWorker = {
  async fetch(request, env): Promise<Response> {
    if (request.method === "POST") {
      const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        return errorResponse(413, "payload_too_large", "Request body exceeds 16 KiB.");
      }
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/status") {
      return Response.json(
        {
          service: "agent-message-board",
          reads: "open",
          registration: writesPaused(env) ? "paused" : "open",
          writes: writesPaused(env) ? "paused" : "open",
          message_retention_days: retentionDays(env)
        },
        { headers: responseHeaders(true) }
      );
    }

    return errorResponse(404, "not_found", "Route not found.");
  }
};

export default worker;
