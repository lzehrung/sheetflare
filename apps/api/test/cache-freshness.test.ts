import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRowResultSchema, listRowsResultSchema } from '@sheetflare/contracts';
import { __resetGatewayStateForTests, createApp } from '../src/index';
import { apiKeys } from './support/api-keys';
import {
  cannedTableSyncCompletedAt,
  createCachedTableReadsHarness,
  createEnv,
  defaultCachedTableReadProps,
  getOnlyCachedReadRequest,
  probesOf,
  requireCacheKey
} from './support/harness';
import { FakeTable } from './support/table-model';
import { WorkersCacheEmulator } from './support/workers-cache';
import type { Env } from '../src/env';

const startedAt = Date.parse('2026-10-29T12:00:00.000Z');
const listPath = '/v1/projects/demo/tables/users/rows';
const rowPath = '/v1/projects/demo/tables/users/rows/row-1';
const schemaPath = '/v1/projects/demo/tables/users/schema';
const driveNotificationPath = '/v1/system/google/drive/notifications';
const adminHeaders = { authorization: 'Bearer secret' };

/**
 * The gateway, a stateful table, and an emulated Workers Cache in front of the cached-read entrypoint. The table is
 * warm (synced at the start of the test) with one row.
 */
class CachedStack {
  readonly table = new FakeTable({ rows: [{ id: 'row-1', values: { n: 0 } }], warm: true });
  readonly cache: WorkersCacheEmulator;
  readonly env: Env;
  readonly app = createApp();
  #beforeNextStatusRead: (() => Promise<void>) | null = null;

  constructor(options: { ttlSeconds?: number; purgeBurst?: number } = {}) {
    this.cache = new WorkersCacheEmulator(options.purgeBurst === undefined ? {} : { purgeBurst: options.purgeBurst });
    this.env = createEnv({
      workersCache: this.cache,
      tableCacheTtlSeconds: options.ttlSeconds ?? 300,
      hooks: {
        table: async (request) => {
          // `table.cache.get` is the status read a cached-read miss makes after it read the rows.
          if (request.body.type === 'table.cache.get' && this.#beforeNextStatusRead !== null) {
            const run = this.#beforeNextStatusRead;
            this.#beforeNextStatusRead = null;
            await run();
          }
          return this.table.hook(request);
        }
      }
    });
  }

  /** Runs `action` after the next cached read has read its rows and before it reads the table's status. */
  beforeNextStatusRead(action: () => Promise<void>) {
    this.#beforeNextStatusRead = action;
  }
}

async function readRow(stack: CachedStack) {
  const response = await stack.app.request(rowPath, { headers: adminHeaders }, stack.env);
  expect(response.status).toBe(200);
  return {
    n: getRowResultSchema.parse(await response.json()).data.values.n,
    cacheStatus: response.headers.get('x-sheetflare-cache-status')
  };
}

async function readFirstRowOfList(stack: CachedStack) {
  const response = await stack.app.request(listPath, { headers: adminHeaders }, stack.env);
  expect(response.status).toBe(200);
  return {
    n: listRowsResultSchema.parse(await response.json()).data[0]?.values.n,
    cacheStatus: response.headers.get('x-sheetflare-cache-status')
  };
}

async function updateRow(stack: CachedStack, n: number) {
  const response = await stack.app.request(
    rowPath,
    {
      method: 'PATCH',
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { n } })
    },
    stack.env
  );
  expect(response.status).toBe(200);
}

beforeEach(() => {
  __resetGatewayStateForTests();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startedAt);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cached reads are keyed by the table data generation', () => {
  it.each([
    { name: 'list rows', path: `${listPath}?limit=10`, tableRequest: 'table.rows.list' },
    { name: 'get schema', path: schemaPath, tableRequest: 'table.schema.get' },
    { name: 'get row', path: rowPath, tableRequest: 'table.row.get' }
  ])('asks the table for its generation before $name and keys the read by it', async ({ path, tableRequest }) => {
    const stack = new CachedStack();
    await updateRow(stack, 1);
    await updateRow(stack, 2);

    const response = await stack.app.request(path, { headers: adminHeaders }, stack.env);

    expect(response.status).toBe(200);
    const probes = probesOf(stack.env);
    expect(probes.tableRequests.slice(-3).map((request) => request.type)).toEqual([
      'table.generation.get',
      tableRequest,
      'table.cache.get'
    ]);
    expect(probes.tableRequests.at(-3)?.resolvedConfig).toMatchObject({ projectSlug: 'demo', tableSlug: 'users' });
    // One sync when the table warmed up, then one per committed write.
    expect(stack.table.dataGeneration).toBe(3);
    const cacheKey = new URL(requireCacheKey(getOnlyCachedReadRequest(stack.env)));
    expect(cacheKey.searchParams.get('__sf_gen')).toBe('3');
    expect(probes.cachedReadProps).toEqual([expect.objectContaining({ dataGeneration: 3 })]);
  });

  it('changes only the generation in the cache key when a write commits', async () => {
    const stack = new CachedStack();
    const keyOfNextRead = async () => {
      const before = probesOf(stack.env).cachedReadRequests.length;
      await readRow(stack);
      const key = probesOf(stack.env).cachedReadRequests[before]?.cacheKey;
      if (key === undefined || key === null) {
        throw new Error('Expected the read to reach the cached entrypoint.');
      }
      return new URL(key);
    };

    const beforeWrite = await keyOfNextRead();
    await updateRow(stack, 1);
    const afterWrite = await keyOfNextRead();

    expect(afterWrite.searchParams.get('__sf_gen')).not.toBe(beforeWrite.searchParams.get('__sf_gen'));
    beforeWrite.searchParams.delete('__sf_gen');
    afterWrite.searchParams.delete('__sf_gen');
    expect(afterWrite.toString()).toBe(beforeWrite.toString());
  });

  it('never asks the table for its generation on behalf of a caller that may not read it', async () => {
    const env = createEnv({ defaultAuthMode: 'private' });
    const app = createApp();

    const anonymous = await app.request(listPath, {}, env);
    const writeOnly = await app.request(listPath, { headers: { authorization: apiKeys.writeOnly.authorization } }, env);

    expect(anonymous.status).toBe(401);
    expect(writeOnly.status).toBe(403);
    expect(probesOf(env).tableRequests).toEqual([]);
    expect(probesOf(env).cachedReadRequests).toEqual([]);
  });

  it('asks for the generation when a public-read project lets a caller without read scope in', async () => {
    const env = createEnv({ defaultAuthMode: 'public-read' });

    const response = await createApp().request(
      listPath,
      { headers: { authorization: apiKeys.writeOnly.authorization } },
      env
    );

    expect(response.status).toBe(200);
    expect(probesOf(env).tableRequests.map((request) => request.type)).toContain('table.generation.get');
  });

  it('asks for the generation while the per-key rate limit is still being checked', { timeout: 2000 }, async () => {
    const generationRequested = Promise.withResolvers<void>();
    const env = createEnv({
      hooks: {
        table: ({ body }) => {
          if (body.type === 'table.generation.get') {
            generationRequested.resolve();
          }
          return undefined;
        },
        rateLimit: async ({ name }) => {
          // The key's rate limit may only answer once the generation lookup has started, so a gateway that waits for
          // the rate limit before it asks for the generation deadlocks here.
          if (name === `rate-limit:data:api-key:${apiKeys.project.id}`) {
            await generationRequested.promise;
          }
          return undefined;
        }
      }
    });

    const response = await createApp().request(rowPath, { headers: { authorization: apiKeys.project.authorization } }, env);

    expect(response.status).toBe(200);
  });

  it('fails the read when the table cannot report its generation instead of serving it unkeyed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = createEnv({
      hooks: {
        table: ({ body }) => body.type === 'table.generation.get'
          ? Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Table unavailable.', details: null } }, { status: 503 })
          : undefined
      }
    });

    const response = await createApp().request(rowPath, { headers: adminHeaders }, env);

    expect(response.status).toBe(503);
    expect(probesOf(env).cachedReadRequests).toEqual([]);
  });

  it('fails the read when the generation answer breaks the contract', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = createEnv({
      hooks: {
        table: ({ body }) => body.type === 'table.generation.get'
          ? Response.json({
              type: 'table.generation.get.result',
              result: { dataGeneration: 'three', lastSyncCompletedAt: null, cacheTtlSeconds: 15 }
            })
          : undefined
      }
    });

    const response = await createApp().request(rowPath, { headers: adminHeaders }, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Unexpected table generation response.', details: null }
    });
    expect(probesOf(env).cachedReadRequests).toEqual([]);
  });
});

describe('read-after-write through the emulated Workers Cache', () => {
  it('stays correct through 40 row updates inside one minute while the purge budget runs out', async () => {
    const stack = new CachedStack();

    for (let n = 1; n <= 40; n += 1) {
      await updateRow(stack, n);
      vi.advanceTimersByTime(1_000);

      expect(await readRow(stack)).toEqual({ n, cacheStatus: 'MISS' });
      expect(await readRow(stack)).toEqual({ n, cacheStatus: 'HIT' });
    }

    const rejectedPurges = stack.cache.purgeRequests.filter((request) => !request.accepted);
    expect(stack.cache.purgeRequests).toHaveLength(40);
    // 25 tokens of burst plus about 3 refilled in 40 seconds cannot cover 40 purges.
    expect(rejectedPurges.length).toBeGreaterThanOrEqual(10);
  });

  it('does not serve data from before a write that committed while the read was in flight', async () => {
    const stack = new CachedStack();
    const hold = stack.cache.holdFills();

    const inFlight = await readRow(stack);
    await updateRow(stack, 1);
    // The read's response reaches the cache only now, after the write committed and purged.
    await hold.release();

    expect(inFlight).toEqual({ n: 0, cacheStatus: 'MISS' });
    expect(await readRow(stack)).toEqual({ n: 1, cacheStatus: 'MISS' });
    expect(await readRow(stack)).toEqual({ n: 1, cacheStatus: 'HIT' });
  });

  it('does not store a read that a write overtook before the read finished', async () => {
    const stack = new CachedStack();
    stack.beforeNextStatusRead(() => updateRow(stack, 1));

    const overtaken = await readRow(stack);

    expect(overtaken.n).toBe(0);
    expect(stack.cache.entries()).toEqual([]);
    expect(await readRow(stack)).toEqual({ n: 1, cacheStatus: 'MISS' });
  });

  it('stops serving entries from before a Drive change when the purge for it is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stack = new CachedStack({ purgeBurst: 0 });
    expect(await readFirstRowOfList(stack)).toEqual({ n: 0, cacheStatus: 'MISS' });
    expect(await readFirstRowOfList(stack)).toEqual({ n: 0, cacheStatus: 'HIT' });

    const entriesBeforeChange = stack.cache.entries();
    stack.table.editSheet('row-1', { n: 5 });
    stack.table.recordExternalChange({ debounceSeconds: 30 });
    const notified = await stack.app.request(
      driveNotificationPath,
      {
        method: 'POST',
        headers: {
          'x-goog-channel-id': 'channel-1',
          'x-goog-resource-id': 'resource-1',
          'x-goog-resource-state': 'update',
          'x-goog-message-number': '2',
          'x-goog-channel-token': 'drive-secret'
        }
      },
      stack.env
    );
    expect(notified.status).toBe(204);
    expect(stack.cache.purgeRequests.every((request) => !request.accepted)).toBe(true);

    // Inside the debounce window the table still answers from its cache, but marks it stale, so nothing new is stored.
    const duringDebounce = await readFirstRowOfList(stack);
    expect(duringDebounce.cacheStatus).not.toBe('HIT');
    expect(stack.cache.entries()).toEqual(entriesBeforeChange);

    vi.advanceTimersByTime(31_000);
    expect((await readFirstRowOfList(stack)).n).toBe(5);
    expect(await readFirstRowOfList(stack)).toEqual({ n: 5, cacheStatus: 'MISS' });
    expect(await readFirstRowOfList(stack)).toEqual({ n: 5, cacheStatus: 'HIT' });
  });
});

describe('edge TTL is the remaining freshness', () => {
  it('stores an entry only for what is left of the table TTL and lets it expire with the table', async () => {
    const stack = new CachedStack({ ttlSeconds: 60 });
    vi.advanceTimersByTime(50_000);

    expect((await readRow(stack)).cacheStatus).toBe('MISS');

    expect(stack.cache.entries()).toEqual([
      expect.objectContaining({ maxAgeSeconds: 10, expiresAtMs: startedAt + 60_000 })
    ]);
    vi.advanceTimersByTime(9_000);
    expect((await readRow(stack)).cacheStatus).toBe('HIT');
    vi.advanceTimersByTime(2_000);
    // The table is past its TTL now, so nothing may still be served from the edge.
    expect((await readRow(stack)).cacheStatus).not.toBe('HIT');
  });

  it('does not store the read that resynced the table, and stores the next one for the full TTL and no longer', async () => {
    const stack = new CachedStack({ ttlSeconds: 60 });
    vi.advanceTimersByTime(61_000);

    expect(await readFirstRowOfList(stack)).toEqual({ n: 0, cacheStatus: 'BYPASS' });
    expect(stack.cache.entries()).toEqual([]);

    expect(await readFirstRowOfList(stack)).toEqual({ n: 0, cacheStatus: 'MISS' });
    expect(stack.cache.entries()).toEqual([expect.objectContaining({ maxAgeSeconds: 60 })]);
  });

  describe('for a table synced at a known instant', () => {
    function cachedListRequest() {
      return new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10');
    }

    async function edgeCacheControl(options: { ageSeconds: number; ttlSeconds: number; keyedGeneration?: number }) {
      vi.setSystemTime(Date.parse(cannedTableSyncCompletedAt) + options.ageSeconds * 1000);
      const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: options.ttlSeconds }), {
        props: {
          ...defaultCachedTableReadProps,
          dataGeneration: options.keyedGeneration ?? defaultCachedTableReadProps.dataGeneration
        }
      });
      const response = await entrypoint.fetch(cachedListRequest());
      expect(response.status).toBe(200);
      return response.headers.get('cloudflare-cdn-cache-control');
    }

    it.each([
      { name: 'just synced', ageSeconds: 0, expected: 'public, max-age=60, stale-if-error=0' },
      { name: '50 seconds into the TTL', ageSeconds: 50, expected: 'public, max-age=10, stale-if-error=0' },
      { name: 'with less than a second of freshness left', ageSeconds: 59.5, expected: 'no-store' },
      { name: 'exactly at the end of the TTL', ageSeconds: 60, expected: 'no-store' },
      { name: 'after the TTL', ageSeconds: 61, expected: 'no-store' },
      { name: 'when the sync is stamped ahead of this clock', ageSeconds: -5, expected: 'public, max-age=60, stale-if-error=0' }
    ])('caps max-age at what is left of a 60 second TTL $name', async ({ ageSeconds, expected }) => {
      expect(await edgeCacheControl({ ageSeconds, ttlSeconds: 60 })).toBe(expected);
    });

    it('does not store a read when the table moved to another generation than the one the key was built for', async () => {
      expect(await edgeCacheControl({ ageSeconds: 0, ttlSeconds: 60, keyedGeneration: 0 })).toBe(
        'public, max-age=60, stale-if-error=0'
      );
      expect(await edgeCacheControl({ ageSeconds: 0, ttlSeconds: 60, keyedGeneration: 7 })).toBe('no-store');
    });
  });
});
