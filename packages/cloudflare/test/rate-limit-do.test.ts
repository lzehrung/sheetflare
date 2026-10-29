import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RateLimitDoResponse } from '@sheetflare/contracts';
import { RateLimitDO, doRpc } from '../src';
import { expectRpcResult } from './support/rpc-result';
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
  let alarmTimestamp: number | null = null;
  return {
    database,
    state: {
      storage: {
        sql: new SqlStorageHarness(database),
        transactionSync<T>(callback: () => T) {
          const transaction = database.transaction(callback);
          return transaction();
        },
        getAlarm() {
          return Promise.resolve(alarmTimestamp);
        },
        setAlarm(scheduledTime: number) {
          alarmTimestamp = scheduledTime;
          return Promise.resolve();
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('frees an idle limiter from its cleanup alarm once every window has expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const name = 'data:client:203.0.113.7';
    const namespace = createDurableObjectNamespace({}, RateLimitDO);
    const stub = namespace.get(namespace.idFromName(name));
    const check = {
      type: 'rate-limit.check',
      key: 'data:GET:client',
      limit: 2,
      windowSeconds: 60
    } as const;

    await doRpc<RateLimitDoResponse>(stub, { ...check, nowMs: 1_000 });

    expect(namespace.getAlarm(name)).toBe(60_000);

    vi.setSystemTime(60_000);
    await namespace.triggerAlarm(name);

    expect(namespace.getStoredTableNames(name)).toEqual([]);
    expect(namespace.getAlarm(name)).toBeNull();

    const afterCleanup = expectRpcResult(
      await doRpc<RateLimitDoResponse>(stub, { ...check, nowMs: 61_000 }),
      'rate-limit.check.result'
    );
    expect(afterCleanup).toEqual({ allowed: true, remaining: 1, resetAtMs: 120_000 });
    expect(namespace.getAlarm(name)).toBe(120_000);
  });

  it('re-arms the cleanup alarm for windows that are still open', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const name = 'admin:client:203.0.113.7';
    const namespace = createDurableObjectNamespace({}, RateLimitDO);
    const stub = namespace.get(namespace.idFromName(name));

    await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:short',
      limit: 2,
      windowSeconds: 60,
      nowMs: 1_000
    });
    await doRpc<RateLimitDoResponse>(stub, {
      type: 'rate-limit.check',
      key: 'admin:GET:long',
      limit: 2,
      windowSeconds: 300,
      nowMs: 1_000
    });

    expect(namespace.getAlarm(name)).toBe(60_000);

    vi.setSystemTime(60_000);
    await namespace.triggerAlarm(name);

    expect(namespace.getStoredTableNames(name)).toEqual(['rate_limit_windows']);
    expect(namespace.getAlarm(name)).toBe(300_000);
  });
});
