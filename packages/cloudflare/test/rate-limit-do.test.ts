import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type RateLimitDoResponse } from '@sheetflare/contracts';
import { RateLimitDO, doRpc } from '../src';
import { createDurableObjectNamespace } from './support/do-harness';

type SqlRow = Record<string, unknown>;

class SqlResult {
  constructor(private readonly rows: SqlRow[]) {}

  toArray() {
    return [...this.rows];
  }
}

class SqlStorageHarness {
  constructor(private readonly database: Database.Database) {}

  exec(sql: string, ...parameters: Array<string | number | boolean | null>) {
    const trimmed = sql.trimStart();
    const statement = this.database.prepare(sql);

    if (/^(SELECT|WITH)\b/i.test(trimmed)) {
      return new SqlResult(statement.all(...parameters) as SqlRow[]);
    }

    statement.run(...parameters);
    return new SqlResult([]);
  }
}

function createStateWithDatabase() {
  const database = new Database(':memory:');
  return {
    database,
    state: {
      storage: {
        sql: new SqlStorageHarness(database),
        transactionSync<T>(callback: () => T) {
          const transaction = database.transaction(callback);
          return transaction();
        }
      }
    } as DurableObjectState
  };
}

async function callCheck(instance: RateLimitDO, input: {
  key: string;
  limit: number;
  windowSeconds: number;
  nowMs: number;
}) {
  const response = await instance.fetch(new Request('https://sheetflare.test/rate-limit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rate-limit.check',
      ...input
    })
  }));
  return await response.json() as RateLimitDoResponse;
}

describe('RateLimitDO', () => {
  it('tracks independent windows per bucket key', async () => {
    const env = {} as Record<string, never>;
    const namespace = createDurableObjectNamespace(env, RateLimitDO);
    const stub = namespace.get(namespace.idFromName('global-rate-limit'));

    const adminFirst = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 1_000
    });
    const adminSecond = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 2_000
    });
    const dataFirst = await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'data:GET:bootstrap-admin',
      limit: 1,
      windowSeconds: 60,
      nowMs: 2_000
    });

    expect((adminFirst as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(true);
    expect((adminSecond as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(false);
    expect((dataFirst as { type: 'rate-limit.check.result'; result: { allowed: boolean } }).result.allowed).toBe(true);
  });

  it('cleans up expired windows on a bounded cadence instead of every request', async () => {
    const { database, state } = createStateWithDatabase();
    const instance = new RateLimitDO(state, {});

    await callCheck(instance, {
      key: 'admin:GET:bootstrap-admin',
      limit: 2,
      windowSeconds: 60,
      nowMs: 1_000
    });
    await callCheck(instance, {
      key: 'data:GET:bootstrap-admin',
      limit: 2,
      windowSeconds: 60,
      nowMs: 61_000
    });

    expect(
      (database.prepare('SELECT bucket_key FROM rate_limit_windows ORDER BY bucket_key').all() as Array<{ bucket_key: string }>).map((row) => row.bucket_key)
    ).toEqual([
      'data:GET:bootstrap-admin:60000'
    ]);

    await callCheck(instance, {
      key: 'other:GET:bootstrap-admin',
      limit: 2,
      windowSeconds: 60,
      nowMs: 62_000
    });

    expect(
      (database.prepare('SELECT bucket_key FROM rate_limit_windows ORDER BY bucket_key').all() as Array<{ bucket_key: string }>).map((row) => row.bucket_key)
    ).toEqual([
      'data:GET:bootstrap-admin:60000',
      'other:GET:bootstrap-admin:60000'
    ]);

    await callCheck(instance, {
      key: 'late:GET:bootstrap-admin',
      limit: 2,
      windowSeconds: 60,
      nowMs: 121_000
    });

    expect(
      (database.prepare('SELECT bucket_key FROM rate_limit_windows ORDER BY bucket_key').all() as Array<{ bucket_key: string }>).map((row) => row.bucket_key)
    ).toEqual([
      'late:GET:bootstrap-admin:120000'
    ]);
  });
});
