export interface QuotaRequest {
  scope: string;
  subject: string;
  windowStart: number;
  limit: number;
}

export interface QuotaResult {
  allowed: boolean;
  used: number | null;
}

export async function consumeQuota(db: D1Database, request: QuotaRequest): Promise<QuotaResult> {
  const row = await db.prepare(
    `INSERT INTO quota_counters (scope, subject, window_start, used, limit_value)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(scope, subject, window_start) DO UPDATE SET used = quota_counters.used + 1
       WHERE quota_counters.used < quota_counters.limit_value
         AND quota_counters.limit_value = excluded.limit_value
     RETURNING used`
  ).bind(request.scope, request.subject, request.windowStart, request.limit).first<{ used: number }>();

  return row ? { allowed: true, used: row.used } : { allowed: false, used: null };
}

export function atomicBatch(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  return db.batch(statements);
}
