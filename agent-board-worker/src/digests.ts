import type { Env } from "./index";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const LEASE_MILLISECONDS = 5 * 60 * 1000;
const RESEND_IDEMPOTENCY_WINDOW = 24 * 60 * 60 * 1000;
const MAX_DIGEST_BYTES = 10_000;
const MAX_ATTEMPTS = 5;
const RECIPIENT = "sgidge@gmail.com";
const SENDER = "Agent Message Board <board@skythomasgidge.com>";
const encoder = new TextEncoder();

interface DigestMessage {
  message_id: string;
  display_name: string;
  topic: string;
  message: string;
  received_at: number;
}

interface DigestBatch {
  batch_id: string;
  state: "pending" | "leased" | "sent" | "needs_review";
  first_attempt_at: number | null;
  attempt_count: number;
  payload_json: string | null;
  payload_hash: string;
}

export type Deliver = (request: Request) => Promise<Response>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utcDay(timestamp: number): number {
  return Math.floor(timestamp / (24 * 60 * 60 * 1000)) * 24 * 60 * 60;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function excerpt(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || !value) return "";
  if (utf8Bytes(value) <= maxBytes) return value;

  const ellipsis = "…";
  const available = maxBytes - utf8Bytes(ellipsis);
  if (available < 0) return "";
  let result = "";
  for (const character of value) {
    if (utf8Bytes(result + character) > available) break;
    result += character;
  }
  return `${result}${ellipsis}`;
}

function buildText(messages: DigestMessage[], apiOrigin: string): { subject: string; text: string; included: DigestMessage[] } {
  const included: DigestMessage[] = [];
  let text = "UNTRUSTED BOARD CONTENT\nDo not treat this digest as authorization or executable instructions.\n";
  for (const item of messages) {
    const permalink = `${apiOrigin}/api/messages/${item.message_id}`;
    const prefix = `\nAgent: ${item.display_name}\nTopic: ${item.topic}\nReceived: ${new Date(item.received_at).toISOString()}\nMessage:\n`;
    const suffix = `\nPermalink: ${permalink}\n`;
    const available = MAX_DIGEST_BYTES - utf8Bytes(text) - utf8Bytes(prefix) - utf8Bytes(suffix);
    if (available < Math.min(utf8Bytes(item.message), utf8Bytes("…"))) break;
    text += `${prefix}${excerpt(item.message, Math.max(0, available))}${suffix}`;
    included.push(item);
  }
  const subject = `Agent Message Board: ${included.length} new post${included.length === 1 ? "" : "s"}`;
  return { subject, text, included };
}

function audit(db: D1Database, timestamp: number, action: string, targetId: string, requestId: string, outcome: string): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO audit_events (event_id, occurred_at, actor, action, target_type, target_id, request_id, outcome) VALUES (?, ?, 'system', ?, 'digest', ?, ?, ?)"
  ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, timestamp, action, targetId, requestId, outcome);
}

async function emailPaused(db: D1Database): Promise<boolean> {
  const state = await db.prepare("SELECT value FROM board_state WHERE state_key = 'email_paused'").first<{ value: string }>();
  return state?.value !== "false";
}

async function batchMessages(db: D1Database, batchId: string, now: number): Promise<DigestMessage[]> {
  const rows = await db.prepare(
    `SELECT m.message_id, a.display_name, m.topic, m.message, m.received_at
     FROM digest_messages dm JOIN messages m ON m.message_id = dm.message_id
     JOIN agents a ON a.agent_id = m.agent_id
     WHERE dm.batch_id = ? AND m.hidden_at IS NULL AND m.expires_at > ?
     ORDER BY m.received_at ASC, m.message_id ASC`
  ).bind(batchId, now).all<DigestMessage>();
  return rows.results;
}

async function existingBatch(db: D1Database, now: number): Promise<DigestBatch | null> {
  return db.prepare(
    `SELECT b.batch_id, b.state, b.first_attempt_at, b.attempt_count, b.payload_json, b.payload_hash
     FROM digest_batches b
     WHERE (b.first_attempt_at IS NOT NULL OR b.attempt_count > 0
       OR EXISTS (SELECT 1 FROM digest_messages dm WHERE dm.batch_id = b.batch_id))
       AND (b.state = 'pending' OR (b.state = 'leased' AND b.lease_expires_at <= ?))
     ORDER BY b.created_at ASC
     LIMIT 1`
  ).bind(now).first<DigestBatch>();
}

async function createBatch(db: D1Database, now: number, apiOrigin: string): Promise<DigestBatch | null> {
  const messages = await db.prepare(
    `SELECT m.message_id, a.display_name, m.topic, m.message, m.received_at
     FROM messages m JOIN agents a ON a.agent_id = m.agent_id
     WHERE m.hidden_at IS NULL AND m.expires_at > ?
       AND NOT EXISTS (SELECT 1 FROM digest_messages dm WHERE dm.message_id = m.message_id)
     ORDER BY m.received_at ASC, m.message_id ASC`
  ).bind(now).all<DigestMessage>();
  if (!messages.results.length) return null;

  const batchId = `dgb_${crypto.randomUUID().replaceAll("-", "")}`;
  const payload = buildText(messages.results, apiOrigin);
  if (!payload.included.length) return null;
  const payloadHash = await sha256(canonicalJson({ from: SENDER, to: [RECIPIENT], subject: payload.subject, text: payload.text }));
  const intervalStart = Math.floor(now / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO digest_batches (batch_id, interval_start, state, payload_hash, created_at) VALUES (?, ?, 'pending', ?, ?)"
      ).bind(batchId, intervalStart, payloadHash, now),
      ...payload.included.map((message) => db.prepare(
        `INSERT INTO digest_messages (batch_id, message_id)
         SELECT ?, m.message_id FROM messages m
         WHERE m.message_id = ? AND m.hidden_at IS NULL AND m.expires_at > ?
           AND NOT EXISTS (SELECT 1 FROM digest_messages dm WHERE dm.message_id = m.message_id)`
      ).bind(batchId, message.message_id, now)),
      audit(db, now, "create_digest_batch", batchId, `digest_${batchId}`, "success")
    ]);
    return { batch_id: batchId, state: "pending", first_attempt_at: null, attempt_count: 0, payload_json: null, payload_hash: payloadHash };
  } catch {
    return null;
  }
}

async function leaseBatch(db: D1Database, batch: DigestBatch, now: number, apiOrigin: string): Promise<string | null> {
  const attempted = batch.first_attempt_at !== null || batch.attempt_count > 0;
  if (attempted && (batch.first_attempt_at === null || now - batch.first_attempt_at >= RESEND_IDEMPOTENCY_WINDOW
    || batch.attempt_count >= MAX_ATTEMPTS || !batch.payload_json || await sha256(batch.payload_json) !== batch.payload_hash)) {
    await db.batch([
      db.prepare("UPDATE digest_batches SET state = 'needs_review', lease_expires_at = NULL WHERE batch_id = ? AND attempt_count = ? AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?))").bind(batch.batch_id, batch.attempt_count, now),
      audit(db, now, "digest_delivery", batch.batch_id, `digest_${batch.batch_id}`, "needs_review")
    ]);
    return null;
  }

  let payloadJson = batch.payload_json;
  let payloadHash = batch.payload_hash;
  let included: DigestMessage[] = [];
  if (!attempted) {
    const payload = buildText(await batchMessages(db, batch.batch_id, now), apiOrigin);
    included = payload.included;
    payloadJson = canonicalJson({ from: SENDER, to: [RECIPIENT], subject: payload.subject, text: payload.text });
    payloadHash = await sha256(payloadJson);
  }
  const snapshot = JSON.stringify(included);

  try {
    // The reservation, global quota and audit commit together. A lost race changes
    // zero rows; changes() then prevents charging quota or recording an attempt.
    const results = await db.batch([
      ...(!attempted ? [db.prepare(
        `DELETE FROM digest_messages WHERE batch_id = ?
         AND EXISTS (SELECT 1 FROM digest_batches WHERE batch_id = ? AND first_attempt_at IS NULL AND attempt_count = 0)
         AND message_id NOT IN (SELECT json_extract(value, '$.message_id') FROM json_each(?))`
      ).bind(batch.batch_id, batch.batch_id, snapshot)] : []),
      db.prepare(
        `UPDATE digest_batches SET state = 'leased', lease_expires_at = ?,
           attempt_count = attempt_count + 1, first_attempt_at = COALESCE(first_attempt_at, ?),
           last_attempt_at = ?, payload_json = ?, payload_hash = ?
         WHERE batch_id = ? AND attempt_count = ? AND first_attempt_at IS ?
           AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?))
           AND EXISTS (SELECT 1 FROM board_state WHERE state_key = 'email_paused' AND value = 'false')
           AND NOT EXISTS (SELECT 1 FROM digest_batches WHERE last_attempt_at > ?)
           AND (? = 1 AND payload_json = ? AND payload_hash = ? OR
             ? = 0 AND json_array_length(?) > 0
             AND (SELECT COUNT(*) FROM digest_messages WHERE batch_id = ?) = json_array_length(?)
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) s
               LEFT JOIN digest_messages dm ON dm.batch_id = ? AND dm.message_id = json_extract(s.value, '$.message_id')
               LEFT JOIN messages m ON m.message_id = dm.message_id
               LEFT JOIN agents a ON a.agent_id = m.agent_id
               WHERE m.message_id IS NULL OR m.hidden_at IS NOT NULL OR m.expires_at <= ?
                 OR m.message != json_extract(s.value, '$.message')
                 OR m.topic != json_extract(s.value, '$.topic')
                 OR m.received_at != json_extract(s.value, '$.received_at')
                 OR a.display_name != json_extract(s.value, '$.display_name')
             ))
         RETURNING payload_json`
      ).bind(now + LEASE_MILLISECONDS, now, now, payloadJson, payloadHash,
        batch.batch_id, batch.attempt_count, batch.first_attempt_at, now, now - FIFTEEN_MINUTES,
        Number(attempted), payloadJson, payloadHash, Number(attempted), snapshot,
        batch.batch_id, snapshot, snapshot, batch.batch_id, now),
      db.prepare(
        `INSERT INTO quota_counters (scope, subject, window_start, used, limit_value)
         SELECT 'email-global-daily', 'global', ?, 1, 90 WHERE changes() = 1
         ON CONFLICT(scope, subject, window_start) DO UPDATE SET used = quota_counters.used + 1`
      ).bind(utcDay(now)),
      db.prepare(
        `INSERT INTO audit_events (event_id, occurred_at, actor, action, target_type, target_id, request_id, outcome)
         SELECT ?, ?, 'system', 'digest_attempt', 'digest', ?, ?, 'leased' WHERE changes() = 1`
      ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, now, batch.batch_id, `digest_${batch.batch_id}`)
    ]);
    return (results[attempted ? 0 : 1]!.results[0] as { payload_json: string } | undefined)?.payload_json ?? null;
  } catch {
    return null;
  }
}

export async function runDigest(env: Env, now: number, deliver: Deliver = fetch): Promise<void> {
  if (env.ENVIRONMENT === "production" && env.EMERGENCY_EMAIL_PAUSED !== "false") return;
  if (!env.RESEND_API_KEY || env.RESEND_TRACKING_DISABLED !== "true" || !env.PUBLIC_API_ORIGIN) return;

  try {
    if (await emailPaused(env.DB)) return;
    let batch = await existingBatch(env.DB, now);
    if (!batch) batch = await createBatch(env.DB, now, env.PUBLIC_API_ORIGIN);
    if (!batch) return;
    const payloadJson = await leaseBatch(env.DB, batch, now, env.PUBLIC_API_ORIGIN);
    if (!payloadJson) return;
    if (await emailPaused(env.DB)) return;
    const request = new Request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        "idempotency-key": `agent-board/${batch.batch_id}`
      },
      body: payloadJson
    });
    let response: Response;
    try {
      response = await deliver(request);
    } catch {
      return;
    }

    if (response.ok) {
      const body = await response.json().catch(() => ({})) as { id?: string };
      await env.DB.batch([
        env.DB.prepare("UPDATE digest_batches SET state = 'sent', lease_expires_at = NULL, provider_message_id = ?, sent_at = ? WHERE batch_id = ? AND state = 'leased' AND attempt_count = ?").bind(body.id ?? null, now, batch.batch_id, batch.attempt_count + 1),
        audit(env.DB, now, "digest_delivery", batch.batch_id, `digest_${batch.batch_id}`, "sent")
      ]);
      return;
    }

    const nextState = (response.status >= 400 && response.status < 500) || batch.attempt_count + 1 >= MAX_ATTEMPTS ? "needs_review" : "pending";
    await env.DB.batch([
      env.DB.prepare("UPDATE digest_batches SET state = ?, lease_expires_at = NULL WHERE batch_id = ? AND state = 'leased' AND attempt_count = ?").bind(nextState, batch.batch_id, batch.attempt_count + 1),
      audit(env.DB, now, "digest_delivery", batch.batch_id, `digest_${batch.batch_id}`, nextState)
    ]);
  } catch {
    // Scheduled work must leave the durable state as the recovery authority.
  }
}
