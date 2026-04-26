import type { RateLimitDoRequest, RateLimitDoResponse } from '@sheetflare/contracts';

type WindowRow = {
  bucket_key: string;
  count: number;
  reset_at_ms: number;
};

export class RateLimitDO {
  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown
  ) {
    void env;
    this.initialize();
  }

  private initialize() {
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
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const body = (await request.json()) as RateLimitDoRequest;
    const result = this.handle(body);
    return Response.json(result);
  }

  private handle(body: RateLimitDoRequest): RateLimitDoResponse {
    switch (body.type) {
      case 'rate-limit.check':
        return {
          type: 'rate-limit.check.result',
          result: this.check(body)
        };
    }
  }

  private check(input: Extract<RateLimitDoRequest, { type: 'rate-limit.check' }>) {
    const limit = Math.max(1, Math.floor(input.limit));
    const windowSeconds = Math.max(1, Math.floor(input.windowSeconds));
    const nowMs = input.nowMs ?? Date.now();
    const windowMs = windowSeconds * 1000;
    const bucketStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetAtMs = bucketStartMs + windowMs;
    const bucketKey = `${input.key}:${bucketStartMs}`;

    this.ctx.storage.sql.exec(
      `DELETE FROM rate_limit_windows WHERE reset_at_ms <= ?`,
      nowMs
    );

    const existing = this.ctx.storage.sql
      .exec(
        `SELECT bucket_key, count, reset_at_ms FROM rate_limit_windows WHERE bucket_key = ?`,
        bucketKey
      )
      .one() as WindowRow | null;

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

      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        resetAtMs
      };
    }

    if (existing.count >= limit) {
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

    return {
      allowed: true,
      remaining: Math.max(limit - existing.count - 1, 0),
      resetAtMs: existing.reset_at_ms
    };
  }
}
