import { rateLimitDoRequestSchema, type RateLimitDoRequest, type RateLimitDoResponse } from '@sheetflare/contracts';
import { durableObjectErrorResponse, parseDurableObjectRpcRequest } from '../rpc';

type WindowRow = {
  bucket_key: string;
  count: number;
  reset_at_ms: number;
};

const minCleanupIntervalMs = 1_000;
const maxCleanupIntervalMs = 60_000;

// The gateway addresses one RateLimitDO per route family and principal, including every anonymous client address. The
// table is created by the first check, and the cleanup alarm frees the whole database once every window has expired,
// so idle principals keep no storage.
export class RateLimitDO {
  private nextCleanupAtMs: number | null = null;
  private hasSchema: boolean;

  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown
  ) {
    void env;
    this.hasSchema = this.ctx.storage.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rate_limit_windows'`)
      .toArray().length > 0;
  }

  private ensureSchema() {
    if (this.hasSchema) {
      return;
    }

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_windows (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at_ms INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_reset
      ON rate_limit_windows(reset_at_ms)
    `);
    this.hasSchema = true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const body = await parseDurableObjectRpcRequest(request, rateLimitDoRequestSchema);
      const result = await this.handle(body);
      return Response.json(result);
    } catch (error) {
      return durableObjectErrorResponse(error);
    }
  }

  async alarm() {
    if (!this.hasSchema) {
      return;
    }

    this.ctx.storage.sql.exec(`DELETE FROM rate_limit_windows WHERE reset_at_ms <= ?`, Date.now());
    const nextResetAtMs = this.selectOptionalRow<{ reset_at_ms: number | null }>(
      `SELECT MIN(reset_at_ms) AS reset_at_ms FROM rate_limit_windows`
    )?.reset_at_ms ?? null;

    if (nextResetAtMs === null) {
      this.hasSchema = false;
      this.nextCleanupAtMs = null;
      await this.ctx.storage.deleteAll();
      return;
    }

    await this.ctx.storage.setAlarm(nextResetAtMs);
  }

  private async handle(body: RateLimitDoRequest): Promise<RateLimitDoResponse> {
    switch (body.type) {
      case 'rate-limit.check':
        return {
          type: 'rate-limit.check.result',
          result: await this.check(body)
        };
    }
  }

  private selectOptionalRow<Row>(query: string, ...params: unknown[]): Row | null {
    const rows = this.ctx.storage.sql.exec(query, ...params).toArray() as Row[];
    return rows[0] ?? null;
  }

  private async check(input: Extract<RateLimitDoRequest, { type: 'rate-limit.check' }>) {
    const limit = Math.max(1, Math.floor(input.limit));
    const windowSeconds = Math.max(1, Math.floor(input.windowSeconds));
    const nowMs = input.nowMs ?? Date.now();
    const windowMs = windowSeconds * 1000;
    const bucketStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetAtMs = bucketStartMs + windowMs;
    const bucketKey = `${input.key}:${bucketStartMs}`;

    this.ensureSchema();
    this.maybeCleanupExpiredWindows(nowMs, windowMs);

    // The read and the write below run without an intervening await, so concurrent checks cannot both pass the limit.
    const existing = this.selectOptionalRow<WindowRow>(
      `SELECT bucket_key, count, reset_at_ms FROM rate_limit_windows WHERE bucket_key = ?`,
      bucketKey
    );

    if (!existing) {
      this.ctx.storage.sql.exec(
        `
        INSERT INTO rate_limit_windows (bucket_key, count, reset_at_ms)
        VALUES (?, ?, ?)
        `,
        bucketKey,
        1,
        resetAtMs
      );
      await this.scheduleCleanupAlarm(resetAtMs);

      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        resetAtMs
      };
    }

    if (existing.count >= limit) {
      await this.scheduleCleanupAlarm(existing.reset_at_ms);
      return {
        allowed: false,
        remaining: 0,
        resetAtMs: existing.reset_at_ms
      };
    }

    this.ctx.storage.sql.exec(
      `
      UPDATE rate_limit_windows
      SET count = count + 1
      WHERE bucket_key = ?
      `,
      bucketKey
    );
    await this.scheduleCleanupAlarm(existing.reset_at_ms);

    return {
      allowed: true,
      remaining: Math.max(limit - existing.count - 1, 0),
      resetAtMs: existing.reset_at_ms
    };
  }

  private async scheduleCleanupAlarm(resetAtMs: number) {
    const scheduledAtMs = await this.ctx.storage.getAlarm();
    if (scheduledAtMs === null || scheduledAtMs > resetAtMs) {
      await this.ctx.storage.setAlarm(resetAtMs);
    }
  }

  private maybeCleanupExpiredWindows(nowMs: number, windowMs: number) {
    if (this.nextCleanupAtMs !== null && nowMs < this.nextCleanupAtMs) {
      return;
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM rate_limit_windows WHERE reset_at_ms <= ?`,
      nowMs
    );
    this.nextCleanupAtMs = nowMs + this.getCleanupIntervalMs(windowMs);
  }

  private getCleanupIntervalMs(windowMs: number) {
    return Math.min(
      Math.max(windowMs, minCleanupIntervalMs),
      maxCleanupIntervalMs
    );
  }
}
