import type { Env } from "./index";

const MESSAGE_DELETE_BATCH = 100;
const MAX_CLEANUP_BATCHES = 20;
const CLEANUP_TIME_BUDGET_MS = 15_000;
const IP_QUOTA_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const AUDIT_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_LIMIT_BYTES = 500_000_000;

export type StorageMeasure = () => Promise<number>;

export type CapacityState = "open" | "warning" | "high" | "paused" | "unavailable";

export interface CapacityReport {
  bytes: number | null;
  limit_bytes: number;
  state: CapacityState;
}

export interface RetentionResult {
  deleted_messages: number;
  capacity_state: CapacityState;
}

export function storageLimit(env: Env): number {
  const configured = Number.parseInt(env.D1_STORAGE_LIMIT_BYTES ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_STORAGE_LIMIT_BYTES;
}

function thresholdState(bytes: number, limitBytes: number): Exclude<CapacityState, "unavailable"> {
  if (bytes >= limitBytes * 0.95) return "paused";
  if (bytes >= limitBytes * 0.85) return "high";
  if (bytes >= limitBytes * 0.7) return "warning";
  return "open";
}

export function capacityReport(env: Env, storedBytes: string | undefined): CapacityReport {
  const limitBytes = storageLimit(env);
  const bytes = Number.parseInt(storedBytes ?? "", 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { bytes: null, limit_bytes: limitBytes, state: "unavailable" };
  return { bytes, limit_bytes: limitBytes, state: thresholdState(bytes, limitBytes) };
}

function audit(db: D1Database, now: number, action: string, outcome: string): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO audit_events (event_id, occurred_at, actor, action, request_id, outcome) VALUES (?, ?, 'system', ?, ?, ?)"
  ).bind(`evt_${crypto.randomUUID().replaceAll("-", "")}`, now, action, `retention_${now}`, outcome);
}

export async function runRetention(env: Env, now: number, measureStorage?: StorageMeasure): Promise<RetentionResult> {
  let deletedMessages = 0;
  const deadline = Date.now() + CLEANUP_TIME_BUDGET_MS;
  try {
    const daySeconds = Math.floor(now / 1000 / (24 * 60 * 60)) * 24 * 60 * 60;
    const quotaCutoff = daySeconds - IP_QUOTA_RETENTION_SECONDS;
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES && Date.now() < deadline; batch += 1) {
      // Keep referenced parents until their replies expire; reads already hide them.
      const expired = await env.DB.prepare(
        `SELECT m.message_id FROM messages m WHERE m.expires_at <= ?
         AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.message_id)
         ORDER BY m.expires_at ASC, m.message_id ASC LIMIT ?`
      ).bind(now, MESSAGE_DELETE_BATCH).all<{ message_id: string }>();
      const ids = expired.results.map((message) => message.message_id);
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(`DELETE FROM quota_counters WHERE rowid IN (
          SELECT rowid FROM quota_counters WHERE scope LIKE '%-ip-%' AND window_start < ? LIMIT ?
        )`).bind(quotaCutoff, MESSAGE_DELETE_BATCH),
        env.DB.prepare(`DELETE FROM audit_events WHERE event_id IN (
          SELECT event_id FROM audit_events WHERE occurred_at < ? ORDER BY occurred_at LIMIT ?
        )`).bind(now - AUDIT_RETENTION_MILLISECONDS, MESSAGE_DELETE_BATCH)
      ];
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(", ");
        statements.push(
          env.DB.prepare(`DELETE FROM digest_messages WHERE message_id IN (${placeholders})`).bind(...ids),
          env.DB.prepare(`DELETE FROM messages WHERE message_id IN (${placeholders})`).bind(...ids)
        );
      }
      const results = await env.DB.batch(statements);
      deletedMessages += ids.length ? results.at(-1)!.meta.changes : 0;
      if (!ids.length && results[0]!.meta.changes === 0 && results[1]!.meta.changes === 0) break;
    }
    await audit(env.DB, now, "retention", "success").run();
  } catch {
    // Cleanup failure must not skip the existing capacity pause check.
  }

  try {
    const bytes = measureStorage
      ? await measureStorage()
      : (await env.DB.prepare("SELECT state_key FROM board_state LIMIT 1").all()).meta.size_after;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
      return { deleted_messages: deletedMessages, capacity_state: "unavailable" };
    }

    const capacityState = thresholdState(bytes, storageLimit(env));
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO board_state (state_key, value, updated_at) VALUES ('capacity_bytes', ?, ?) ON CONFLICT(state_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(String(bytes), now),
      ...(capacityState === "paused" ? [
        env.DB.prepare("UPDATE board_state SET value = 'true', updated_at = ? WHERE state_key = 'capacity_paused'").bind(now),
        audit(env.DB, now, "capacity_pause", "threshold_reached")
      ] : [])
    ]);
    return { deleted_messages: deletedMessages, capacity_state: capacityState };
  } catch {
    return { deleted_messages: deletedMessages, capacity_state: "unavailable" };
  }
}
