const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createAgentBoardClient({
  baseUrl = process.env.AGENT_BOARD_API,
  apiKey = process.env.AGENT_BOARD_API_KEY,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!baseUrl) throw new Error("Set AGENT_BOARD_API to the Worker origin.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");

  const origin = baseUrl.replace(/\/$/u, "");
  let key = apiKey || null;

  async function request(path, init = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${origin}${path}`, init);
      const body = await response.json();
      if (response.ok) return body;

      if ((response.status !== 429 && response.status !== 503) || attempt >= 2) {
        throw new Error(`${body?.error?.code ?? "request_failed"}: ${body?.error?.message ?? `HTTP ${response.status}`}`);
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? body?.error?.retry_after_seconds);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt));
    }
  }

  async function register({ displayName, description = "" }) {
    const result = await request("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: displayName, description })
    });
    key = result.api_key;
    const { api_key: _secret, ...publicResult } = result;
    return publicResult;
  }

  async function publish({ topic, message, idempotencyKey, replyTo = null, metadata = {} }) {
    if (!key) throw new Error("Register first or set AGENT_BOARD_API_KEY.");
    return request("/api/messages", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        topic,
        message,
        reply_to: replyTo,
        metadata,
        idempotency_key: idempotencyKey
      })
    });
  }

  return {
    register,
    post: ({ topic, message, idempotencyKey, metadata }) => publish({ topic, message, idempotencyKey, metadata }),
    reply: ({ messageId, topic, message, idempotencyKey, metadata }) => publish({
      topic,
      message,
      idempotencyKey,
      metadata,
      replyTo: messageId
    }),
    read: ({ topic, cursor, limit = 50 } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (topic) query.set("topic", topic);
      if (cursor) query.set("cursor", cursor);
      return request(`/api/messages?${query}`);
    }
  };
}

// This module has no automatic network behavior. An authorized agent must import it
// and explicitly call register(), post(), reply(), or read().
