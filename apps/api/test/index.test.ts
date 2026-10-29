import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  __getRecentApiKeyTouchCacheSizeForTests,
  __resetGatewayStateForTests,
  __touchApiKeyIfNeededForTests,
  createApp
} from '../src/index';
import { apiKeys, forgedApiKey } from './support/api-keys';
import {
  type CachePurgeCall,
  type CachedReadRequestRecord,
  createCachedTableReadsHarness,
  createEnv,
  defaultCachedTableReadProps,
  expectCachedDataReadGatewayHeaders,
  expectCachedReadPurgeCalls,
  expectDefaultGatewayNoStore,
  expectNoCredentialMaterial,
  expectSuccessfulCachedReadHeaders,
  getOnlyCachedReadRequest,
  requireCacheKey
} from './support/harness';

describe('CachedTableReads', () => {
  it('sets client-safe and Workers Cache headers for list rows', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: 42 }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10')
    );

    expect(response.status).toBe(200);
    expectSuccessfulCachedReadHeaders(response, {
      edgeCacheControl: 'public, max-age=42, stale-if-error=0',
      tags: ['project:demo', 'table:demo:users']
    });
    expect(await response.json()).toEqual({
      data: [
        {
          id: 'row-1',
          rowNumber: 2,
          values: {
            matched: true
          }
        }
      ],
      nextCursor: null
    });
  });

  it('sets project and table Cache-Tag values for schema reads', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: 36 }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/schema')
    );

    expect(response.status).toBe(200);
    expectSuccessfulCachedReadHeaders(response, {
      edgeCacheControl: 'public, max-age=36, stale-if-error=0',
      tags: ['project:demo', 'table:demo:users']
    });
    expect(await response.json()).toEqual({
      data: {
        fields: [
          {
            name: '_id',
            inferredType: 'string',
            nullable: false
          }
        ],
        inferredAt: '2026-04-26T00:00:00.000Z'
      }
    });
  });

  it('sets project, table, and row Cache-Tag values for row reads', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: 24 }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows/row-1')
    );

    expect(response.status).toBe(200);
    expectSuccessfulCachedReadHeaders(response, {
      edgeCacheControl: 'public, max-age=24, stale-if-error=0',
      tags: ['project:demo', 'table:demo:users', 'row:demo:users:row-1']
    });
    expect(await response.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {}
      }
    });
  });

  it('bypasses Workers Cache when required Cache-Tag values exceed purge limits', async () => {
    const longRowId = 'x'.repeat(1100);
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: 24 }));

    const response = await entrypoint.fetch(
      new Request(`https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows/${longRowId}`)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBe('no-store');
    expect(response.headers.get('cache-tag')).toBeNull();
    expect(await response.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {}
      }
    });
  });

  it('sets Workers Cache no-store when table cache TTL is disabled', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableCacheTtlSeconds: 0 }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10')
    );

    expect(response.status).toBe(200);
    expectSuccessfulCachedReadHeaders(response, {
      edgeCacheControl: 'no-store',
      tags: ['project:demo', 'table:demo:users']
    });
  });

  it.each([
    { name: 'inside the debounce window', debounceUntil: '2026-04-26T00:00:08.000Z' },
    { name: 'after the debounce deadline passed without a reindex', debounceUntil: '2020-01-01T00:00:00.000Z' }
  ])('never stores Workers Cache entries while an external change is pending $name', async ({ debounceUntil }) => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({
      tableCacheTtlSeconds: 60,
      tableExternalChangeDebounceUntil: debounceUntil
    }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10')
    );

    expect(response.status).toBe(200);
    expectSuccessfulCachedReadHeaders(response, {
      edgeCacheControl: 'no-store',
      tags: ['project:demo', 'table:demo:users']
    });
  });

  it('sets Workers Cache no-store when cache status is stale or not ready', async () => {
    const cases = [
      {
        name: 'stale ready cache',
        env: createEnv({ tableCacheStatus: 'ready', tableCacheStale: true, tableCacheTtlSeconds: 60 })
      },
      {
        name: 'not-ready cache',
        env: createEnv({ tableCacheStatus: 'syncing', tableCacheStale: false, tableCacheTtlSeconds: 60 })
      }
    ];

    for (const { name, env } of cases) {
      const { entrypoint } = createCachedTableReadsHarness(env);

      const response = await entrypoint.fetch(
        new Request(`https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10&case=${encodeURIComponent(name)}`)
      );

      expect(response.status).toBe(200);
      expectSuccessfulCachedReadHeaders(response, {
        edgeCacheControl: 'no-store',
        tags: ['project:demo', 'table:demo:users']
      });
    }
  });

  it('resolves asynchronous cached-read failures as structured no-store responses', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv({ tableRowsListStatus: 503 }));

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows?limit=10')
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Cached rows are temporarily unavailable.',
        details: null
      }
    });
  });

  it('returns a defensive no-store 404 for unknown cached-read paths', async () => {
    const { entrypoint } = createCachedTableReadsHarness();

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/unknown')
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Cached table read route is not configured.',
        details: null
      }
    });
  });

  it('rejects cached-read HEAD requests so HEAD cannot populate GET cache entries', async () => {
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string }>;
    };
    const { entrypoint } = createCachedTableReadsHarness(env);

    const response = await entrypoint.fetch(
      new Request('https://cached.sheetflare.internal/internal/cache/v1/projects/demo/tables/users/rows', {
        method: 'HEAD'
      })
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');
    expect(env.__tableRequests).toEqual([]);
  });

  it('purges the project tag when invalidating a project', async () => {
    const { entrypoint, purgeCalls } = createCachedTableReadsHarness();

    await entrypoint.invalidateProject('demo');

    expect(purgeCalls).toEqual([
      {
        tags: ['project:demo']
      }
    ]);
  });

  it('purges the table tag when invalidating a table', async () => {
    const { entrypoint, purgeCalls } = createCachedTableReadsHarness();

    await entrypoint.invalidateTable('demo', 'users');

    expect(purgeCalls).toEqual([
      {
        tags: ['table:demo:users']
      }
    ]);
  });

  it('rejects table invalidation when Workers Cache returns a failed purge result', async () => {
    const { entrypoint } = createCachedTableReadsHarness(createEnv(), {
      purgeResultShouldFail: true
    });

    await expect(entrypoint.invalidateTable('demo', 'users')).rejects.toThrow();
  });

  it('purges table and encoded row tags when invalidating a row', async () => {
    const { entrypoint, purgeCalls } = createCachedTableReadsHarness();

    await entrypoint.invalidateRow('demo', 'users', 'row/1:alpha,beta?sheet#frag%space value');

    expect(purgeCalls).toEqual([
      {
        tags: [
          'table:demo:users',
          'row:demo:users:row%2F1%3Aalpha%2Cbeta%3Fsheet%23frag%25space%20value'
        ]
      }
    ]);
  });

  it('falls back to only the table tag when a row tag exceeds the Workers Cache limit', async () => {
    const longRowId = 'x'.repeat(1025);
    const { entrypoint, purgeCalls } = createCachedTableReadsHarness();

    await entrypoint.invalidateRow('demo', 'users', longRowId);

    expect(purgeCalls).toEqual([
      {
        tags: ['table:demo:users']
      }
    ]);
  });
});

describe('api routes', () => {
  beforeEach(() => {
    __resetGatewayStateForTests();
  });

  it('applies no-store to default-gateway dynamic and privileged routes', async () => {
    const app = createApp();
    const cases: Array<{
      name: string;
      path: string;
      init?: RequestInit;
      expectedStatus: number;
    }> = [
      {
        name: 'readiness probe',
        path: '/ready',
        expectedStatus: 200
      },
      {
        name: 'admin project listing',
        path: '/v1/admin/projects',
        init: {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        expectedStatus: 200
      },
      {
        name: 'api key creation',
        path: '/v1/admin/keys',
        init: {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            name: 'Created key',
            scopes: ['admin:keys']
          })
        },
        expectedStatus: 201
      },
      {
        name: 'drive watch status',
        path: '/v1/admin/system/google/drive/watches',
        init: {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        expectedStatus: 200
      },
      {
        name: 'drive notification',
        path: '/v1/system/google/drive/notifications',
        init: {
          method: 'POST',
          headers: {
            'x-goog-channel-id': 'channel-1',
            'x-goog-resource-id': 'resource-1',
            'x-goog-resource-state': 'update',
            'x-goog-message-number': '2',
            'x-goog-channel-token': 'drive-secret'
          }
        },
        expectedStatus: 204
      },
      {
        name: 'spreadsheet tab list',
        path: '/v1/admin/projects/demo/spreadsheet/tabs',
        init: {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        expectedStatus: 200
      },
      {
        name: 'spreadsheet tab inspection',
        path: '/v1/admin/projects/demo/spreadsheet/tabs/Users?headerRow=3',
        init: {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        expectedStatus: 200
      },
      {
        name: 'authorization failure',
        path: '/v1/admin/projects',
        expectedStatus: 401
      },
      {
        name: 'missing project 404',
        path: '/v1/admin/projects/missing-project/tables',
        init: {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        expectedStatus: 404
      },
      {
        name: 'unknown route 404',
        path: '/v1/not-found',
        expectedStatus: 404
      },
      {
        name: 'OpenAPI document',
        path: '/doc',
        expectedStatus: 200
      },
      {
        name: 'interactive docs',
        path: '/docs',
        expectedStatus: 200
      }
    ];

    for (const { name, path, init, expectedStatus } of cases) {
      const response = await app.request(path, init ?? {}, createEnv());

      expect(response.status, name).toBe(expectedStatus);
      expectDefaultGatewayNoStore(response);
    }
  });

  it('enforces admin bearer auth when configured', async () => {
    const app = createApp();
    const response = await app.request('/v1/admin/projects', {}, createEnv());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        details: null
      }
    });
  });

  it('returns a bad-request error for malformed JSON bodies', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: '{'
      },
      createEnv()
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON in request body.',
        details: null
      }
    });
  });

  it('lists projects through the registry durable object', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          tableCount: 2,
          updatedAt: '2026-04-26T00:00:00.000Z'
        }
      ]
    });
  });

  it('accepts bootstrap admin tokens even when the deployed secret includes trailing whitespace', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv({
        adminBearerToken: 'secret\n'
      })
    );

    expect(response.status).toBe(200);
  });

  it('registers Drive spreadsheet watches through a global admin route', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> };
    const response = await app.request(
      '/v1/admin/system/google/drive/watches/register',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          debounceSeconds: 45,
          expirationHours: 72
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          channelId: 'channel-1',
          resourceId: 'resource-1',
          resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
          expirationAt: '2026-05-03T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: null,
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: null,
          lastReindexError: null,
          projectSlugs: ['demo']
        }
      ]
    });
    expect(env.__controlPlaneRequests.at(-1)).toMatchObject({
      type: 'control.spreadsheet-watches.register',
      body: {
        debounceSeconds: 45,
        webhookToken: 'drive-secret'
      }
    });
  });

  it('lists Drive spreadsheet watch status through a global admin route', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> };
    const response = await app.request(
      '/v1/admin/system/google/drive/watches',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          channelId: 'channel-1',
          resourceId: 'resource-1',
          resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
          expirationAt: '2026-05-03T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: '2026-04-26T00:00:00.000Z',
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: '2026-04-26T00:00:10.000Z',
          lastReindexError: null,
          projectSlugs: ['demo']
        }
      ]
    });
    expect(env.__controlPlaneRequests.at(-1)?.type).toBe('control.spreadsheet-watches.list');
  });

  it('stops known Drive spreadsheet watches through a global admin route', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> };
    const response = await app.request(
      '/v1/admin/system/google/drive/watches/stop',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          spreadsheetId: 'sheet-1'
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          spreadsheetId: 'sheet-1',
          googleCredentialRef: 'default',
          channelId: 'channel-1',
          resourceId: 'resource-1',
          resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
          expirationAt: '2026-05-03T00:00:00.000Z',
          lastWatchError: null,
          lastNotificationAt: '2026-04-26T00:00:00.000Z',
          pendingChangedAt: null,
          debounceUntil: null,
          lastReindexStartedAt: null,
          lastReindexCompletedAt: '2026-04-26T00:00:10.000Z',
          lastReindexError: null,
          projectSlugs: ['demo']
        }
      ]
    });
    expect(env.__controlPlaneRequests.at(-1)).toMatchObject({
      type: 'control.spreadsheet-watches.stop',
      body: {
        input: {
          spreadsheetId: 'sheet-1'
        }
      }
    });
  });

  it('lists Drive spreadsheet watch retry advice through a global admin route', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> };
    const response = await app.request(
      '/v1/admin/system/google/drive/watches/retry-advice',
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          spreadsheetId: 'sheet-1',
          status: 'cooldown-recommended',
          currentWatchExpirationAt: null,
          lastKnownStoppedAt: '2026-05-01T18:00:00.000Z',
          lastKnownExpirationAt: '2026-05-02T17:37:46.000Z',
          safeRetryAt: '2026-05-02T17:52:46.000Z',
          note: 'Wait until after the last known watch expiration plus a short grace window before re-registering.',
          projectSlugs: ['demo']
        }
      ]
    });
    expect(env.__controlPlaneRequests.at(-1)?.type).toBe('control.spreadsheet-watches.retry-advice.list');
  });

  it('accepts verified Google Drive webhook notifications, records the external-change debounce, and purges project tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }>;
      __rateLimitRequests: Array<{ name: string; key: string }>;
      __cachedReadPurgeCalls: CachePurgeCall[];
    };
    const response = await app.request(
      '/v1/system/google/drive/notifications',
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
      env
    );

    expect(response.status).toBe(204);
    expect(env.__rateLimitRequests).toEqual([]);
    expect(env.__controlPlaneRequests).toContainEqual(expect.objectContaining({
      type: 'control.spreadsheet-watch.notify',
      body: expect.objectContaining({
        channelId: 'channel-1',
        resourceId: 'resource-1',
        resourceState: 'update'
      })
    }));
    expect(env.__controlPlaneRequests).toContainEqual(expect.objectContaining({
      type: 'control.projects.list'
    }));
    expectCachedReadPurgeCalls(env, [
      ['project:demo']
    ]);
  });

  it('returns a controlled service unavailable error when an accepted Drive notification gets an unexpected project list response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const path = '/v1/system/google/drive/notifications';

    try {
      const response = await app.request(
        path,
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
        createEnv({ controlProjectsListUnexpectedResponse: true })
      );

      expect(response.status).toBe(503);
      const responseBody: unknown = await response.json();
      expect(responseBody).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unexpected control plane projects list response.',
          details: null
        }
      });

      const requestId = response.headers.get('x-request-id');
      expect(requestId).toEqual(expect.any(String));
      if (requestId === null) {
        throw new Error('Expected the response to include a request ID.');
      }
      const matchingEvents = errorSpy.mock.calls.flatMap(([errorLog]) => {
        if (typeof errorLog !== 'string') {
          return [];
        }
        try {
          const event: unknown = JSON.parse(errorLog);
          const identity = z.object({
            event: z.literal('request.error'),
            path: z.literal(path),
            requestId: z.literal(requestId)
          }).safeParse(event);
          return identity.success ? [event] : [];
        } catch {
          return [];
        }
      });
      expect(matchingEvents).toHaveLength(1);
      expect(matchingEvents[0]).toMatchObject({
        event: 'request.error',
        method: 'POST',
        path,
        requestId,
        errorName: 'ServiceUnavailableError',
        errorMessage: 'Unexpected control plane projects list response.'
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns a controlled service unavailable error before project lookup when a Drive notification gets an unexpected notify response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const path = '/v1/system/google/drive/notifications';
    const env: Env & {
      __controlPlaneRequests?: Array<{ type: string; body: Record<string, unknown> }>;
      __cachedReadPurgeCalls?: CachePurgeCall[];
    } = createEnv({
      controlSpreadsheetWatchNotifyUnexpectedResponse: true
    });

    try {
      const response = await app.request(
        path,
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
        env
      );

      expect(response.status).toBe(503);
      const responseBody: unknown = await response.json();
      expect(responseBody).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unexpected control plane spreadsheet watch notify response.',
          details: null
        }
      });

      expect(env.__controlPlaneRequests).not.toContainEqual(expect.objectContaining({
        type: 'control.projects.list'
      }));
      expect(env.__cachedReadPurgeCalls).toEqual([]);

      const requestId = response.headers.get('x-request-id');
      expect(requestId).toEqual(expect.any(String));
      if (requestId === null) {
        throw new Error('Expected the response to include a request ID.');
      }
      const matchingEvents = errorSpy.mock.calls.flatMap(([errorLog]) => {
        if (typeof errorLog !== 'string') {
          return [];
        }
        try {
          const event: unknown = JSON.parse(errorLog);
          const identity = z.object({
            event: z.literal('request.error'),
            path: z.literal(path),
            requestId: z.literal(requestId)
          }).safeParse(event);
          return identity.success ? [event] : [];
        } catch {
          return [];
        }
      });
      expect(matchingEvents).toHaveLength(1);
      expect(matchingEvents[0]).toMatchObject({
        event: 'request.error',
        method: 'POST',
        path,
        requestId,
        errorName: 'ServiceUnavailableError',
        errorMessage: 'Unexpected control plane spreadsheet watch notify response.'
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects Google Drive webhook notifications with the wrong verification token', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/system/google/drive/notifications',
      {
        method: 'POST',
        headers: {
          'x-goog-channel-id': 'channel-1',
          'x-goog-resource-id': 'resource-1',
          'x-goog-resource-state': 'update',
          'x-goog-channel-token': 'wrong-secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  it('rejects duplicate project creation unless upsert is requested explicitly', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        })
      },
      createEnv()
    );

    expect(response.status).toBe(409);
  });

  it('allows explicit project upserts for idempotent automation and purges replaced project tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __cachedReadPurgeCalls: CachePurgeCall[] };
    const response = await app.request(
      '/v1/admin/projects?upsert=true',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expectCachedReadPurgeCalls(env, [
      ['project:demo']
    ]);
  });

  it('treats upsert=false as a real false value instead of enabling replacement', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects?upsert=false',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        })
      },
      createEnv()
    );

    expect(response.status).toBe(409);
  });

  it('rejects invalid upsert query values', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects?upsert=yes',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          slug: 'demo',
          name: 'Demo',
          spreadsheetId: 'sheet-1'
        })
      },
      createEnv()
    );

    expect(response.status).toBe(400);
  });

  it('returns 200 for explicit table upserts that replace existing config and purges replaced table tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __cachedReadPurgeCalls: CachePurgeCall[] };
    const response = await app.request(
      '/v1/admin/projects/demo/tables?upsert=true',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          tableSlug: 'users',
          sheetTabName: 'Users'
        })
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: expect.objectContaining({
        projectSlug: 'demo',
        tableSlug: 'users'
      })
    });
    expectCachedReadPurgeCalls(env, [
      ['table:demo:users']
    ]);
  });

  it('treats table upsert=false as a real false value instead of replacing config', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/demo/tables?upsert=false',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          tableSlug: 'users',
          sheetTabName: 'Users'
        })
      },
      createEnv()
    );

    expect(response.status).toBe(409);
  });

  it('returns not found when listing tables for a missing project', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/missing-project/tables',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Project missing-project was not found.',
        details: {
          projectSlug: 'missing-project'
        }
      }
    });
  });

  it('deletes a configured table, clears cached table state, and purges table tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string }>;
      __durableObjectRequests: string[];
      __cachedReadPurgeCalls: CachePurgeCall[];
    };
    const response = await app.request(
      '/v1/admin/projects/demo/tables/users',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deletedTable: 'users'
    });
    expect(env.__projectRequests).toContain('project.table.delete');
    expect(env.__tableRequests.map((request) => request.type)).toContain('table.cache.clear');
    expect(env.__durableObjectRequests.indexOf('table.cache.clear')).toBeLessThan(
      env.__durableObjectRequests.indexOf('project.table.delete')
    );
    expectCachedReadPurgeCalls(env, [
      ['table:demo:users']
    ]);
  });

  it('does not delete table metadata when its cached table state cannot be cleared first', async () => {
    const app = createApp();
    const env = createEnv({ tableCacheClearStatus: 503 }) as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string }>;
    };
    const response = await app.request(
      '/v1/admin/projects/demo/tables/users',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(503);
    expect(env.__tableRequests.map((request) => request.type)).toContain('table.cache.clear');
    expect(env.__projectRequests).not.toContain('project.table.delete');
  });

  it('deletes a configured project, clears caches for its tables, and purges project tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string }>;
      __durableObjectRequests: string[];
      __cachedReadPurgeCalls: CachePurgeCall[];
    };
    const response = await app.request(
      '/v1/admin/projects/demo',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deletedProject: 'demo',
      deletedTables: ['users']
    });
    expect(env.__projectRequests).toContain('project.delete');
    expect(env.__tableRequests.map((request) => request.type)).toContain('table.cache.clear');
    expect(env.__durableObjectRequests.indexOf('table.cache.clear')).toBeLessThan(
      env.__durableObjectRequests.indexOf('project.delete')
    );
    expectCachedReadPurgeCalls(env, [
      ['project:demo']
    ]);
  });

  it('does not delete project metadata when one of its table caches cannot be cleared first', async () => {
    const app = createApp();
    const env = createEnv({ tableCacheClearStatus: 503 }) as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string }>;
    };
    const response = await app.request(
      '/v1/admin/projects/demo',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(503);
    expect(env.__tableRequests.map((request) => request.type)).toContain('table.cache.clear');
    expect(env.__projectRequests).not.toContain('project.delete');
  });

  it('returns an idempotent project delete response when project metadata is already absent', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/missing-project',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deletedProject: 'missing-project',
      deletedTables: []
    });
  });

  it('reports internal readiness separately from liveness', async () => {
    const app = createApp();
    const response = await app.request('/ready', {}, createEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: 'configured',
        namedGoogleCredentials: 'missing',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured',
        adminUi: 'disabled'
      },
      notes: [
        'This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.'
      ]
    });
  });

  it('does not emit browser CORS headers unless an origin is explicitly allowed', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          origin: 'https://client.example'
        }
      },
      createEnv({ defaultAuthMode: 'public-read' })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows configured browser CORS preflights before route rate limiting', async () => {
    const app = createApp();
    const env = createEnv({ allowedOrigins: 'https://client.example' }) as Env & {
      __rateLimitRequests: Array<{ name: string; key: string }>;
    };
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://client.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization'
        }
      },
      env
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(env.__rateLimitRequests).toEqual([]);
  });

  it('rejects browser CORS preflights from unconfigured origins', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'OPTIONS',
        headers: {
          origin: 'https://untrusted.example',
          'access-control-request-method': 'GET'
        }
      },
      createEnv({ allowedOrigins: 'https://client.example' })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'CORS origin is not allowed.',
        details: null
      }
    });
  });

  it('treats the checked-in placeholder GOOGLE_CLIENT_EMAIL as not configured in /ready', async () => {
    const app = createApp();
    const response = await app.request('/ready', {}, createEnv({
      googleClientEmail: 'service-account@your-gcp-project.iam.gserviceaccount.com'
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: 'missing',
        namedGoogleCredentials: 'missing',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured',
        adminUi: 'disabled'
      },
      notes: [
        'Neither the default Google service-account credential nor named GOOGLE_CREDENTIALS_JSON entries are configured.',
        'This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.'
      ]
    });
  });

  it('treats named Google credentials as a healthy readiness source when the default credential is absent', async () => {
    const app = createApp();
    const response = await app.request('/ready', {}, createEnv({
      googleClientEmail: 'service-account@your-gcp-project.iam.gserviceaccount.com',
      googlePrivateKey: '',
      googleCredentialsJson: JSON.stringify({
        prod: {
          client_email: 'service@example.com',
          private_key: 'secret'
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: 'missing',
        namedGoogleCredentials: 'configured',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured',
        adminUi: 'disabled'
      },
      notes: [
        'Default Google service-account credential is not configured, but named GOOGLE_CREDENTIALS_JSON entries are available for project-specific refs.',
        'This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.'
      ]
    });
  });

  it('accepts documented named Google credential field names in /ready', async () => {
    const app = createApp();
    const response = await app.request('/ready', {}, createEnv({
      googleClientEmail: 'service-account@your-gcp-project.iam.gserviceaccount.com',
      googlePrivateKey: '',
      googleCredentialsJson: JSON.stringify({
        prod: {
          clientEmail: 'service@example.com',
          privateKey: 'secret'
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      checks: {
        defaultGoogleCredential: 'missing',
        namedGoogleCredentials: 'configured'
      }
    });
  });

  it('reports invalid named Google credentials distinctly in /ready', async () => {
    const app = createApp();
    const response = await app.request('/ready', {}, createEnv({
      googleClientEmail: 'service-account@your-gcp-project.iam.gserviceaccount.com',
      googlePrivateKey: '',
      googleCredentialsJson: '{"prod":{"client_email":"service@example.com"}}'
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: 'missing',
        namedGoogleCredentials: 'invalid',
        googleDriveWebhookSecret: 'configured',
        bootstrapAdmin: 'configured',
        adminUi: 'disabled'
      },
      notes: [
        'GOOGLE_CREDENTIALS_JSON is present but invalid. Each named credential must include non-empty client_email/private_key or clientEmail/privateKey fields.',
        'This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.'
      ]
    });
  });

  it('rejects global project listing for project-scoped admin keys', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: apiKeys.projectAdmin.authorization
        }
      },
      createEnv()
    );

    expect(response.status).toBe(403);
  });

  it('creates rows against the table durable object', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: apiKeys.project.authorization
        },
        body: JSON.stringify({
          values: {
            name: 'Ada'
          }
        })
      },
      createEnv()
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {
          name: 'Ada'
        }
      },
      ignoredKeys: []
    });
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('x-ratelimit-limit')).toBe('300');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('299');
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"rateLimitOperationKey":"rows.create"'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`"rateLimitPrincipal":"api-key:${apiKeys.project.id}"`));
  });

  it('keeps row mutations on the default route and purges exact cache tags', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
      __cachedReadRequests: CachedReadRequestRecord[];
      __cachedReadPurgeCalls: CachePurgeCall[];
    };

    const createResponse = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: {
            name: 'Ada'
          }
        })
      },
      env
    );
    const updateResponse = await app.request(
      '/v1/projects/demo/tables/users/rows/row-1',
      {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: {
            name: 'Grace'
          }
        })
      },
      env
    );
    const deleteResponse = await app.request(
      '/v1/projects/demo/tables/users/rows/row-1',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get('x-sheetflare-cache-invalidation')).toBeNull();
    expect(await createResponse.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {
          name: 'Ada'
        }
      },
      ignoredKeys: []
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {
          name: 'Grace'
        }
      },
      ignoredKeys: []
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      ok: true,
      deletedId: 'row-1'
    });
    expect(env.__cachedReadRequests).toEqual([]);
    expect(env.__tableRequests.map((request) => request.type)).toEqual([
      'table.row.create',
      'table.row.update',
      'table.row.delete'
    ]);
    expect(env.__tableRequests.map((request) => request.requestContext?.route)).toEqual([
      'rows.create',
      'rows.update',
      'rows.delete'
    ]);
    expectCachedReadPurgeCalls(env, [
      ['table:demo:users'],
      ['table:demo:users', 'row:demo:users:row-1'],
      ['table:demo:users', 'row:demo:users:row-1']
    ]);
  });

  it('deletes rows with over-limit cache tags and purges only the table tag', async () => {
    const longRowId = 'x'.repeat(1025);
    const app = createApp();
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string }>;
      __cachedReadPurgeCalls: CachePurgeCall[];
    };

    const response = await app.request(
      `/v1/projects/demo/tables/users/rows/${longRowId}`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deletedId: longRowId
    });
    expect(env.__tableRequests.map((request) => request.type)).toContain('table.row.delete');
    expectCachedReadPurgeCalls(env, [
      ['table:demo:users']
    ]);
  });

  it('returns a committed row creation with a warning and structured log when cache invalidation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const env = createEnv({ cachedReadPurgeShouldFail: true }) as Env & {
      __tableRequests: Array<{ type: string }>;
      __cachedReadPurgeCalls: CachePurgeCall[];
    };

    try {
      const response = await app.request(
        '/v1/projects/demo/tables/users/rows',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            values: {
              name: 'Ada'
            }
          })
        },
        env
      );

      expect(response.status).toBe(201);
      expect(response.headers.get('x-sheetflare-cache-invalidation')).toBe('failed');
      expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
      expect(response.headers.get('cache-tag')).toBeNull();
      const requestId = response.headers.get('x-request-id');
      expect(requestId).toEqual(expect.any(String));
      expect(await response.json()).toEqual({
        data: {
          id: 'row-1',
          rowNumber: 2,
          values: {
            name: 'Ada'
          }
        },
        ignoredKeys: []
      });
      expect(env.__tableRequests.map((request) => request.type)).toEqual(['table.row.create']);
      expectCachedReadPurgeCalls(env, [
        ['table:demo:users']
      ]);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const errorLog = errorSpy.mock.calls[0]?.[0];
      expect(errorLog).toEqual(expect.any(String));
      if (typeof errorLog !== 'string') {
        throw new Error('Expected cache invalidation failure to emit a JSON log line.');
      }
      const event: unknown = JSON.parse(errorLog);
      expect(event).toEqual({
        event: 'cache.invalidation.failed',
        method: 'POST',
        path: '/v1/projects/demo/tables/users/rows',
        requestId,
        errorName: 'Error',
        errorMessage: 'Workers Cache purge failed for test.'
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects protected row creation without credentials', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          values: {
            name: 'Ada'
          }
        })
      },
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  it('does not leak private project existence on anonymous read routes', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __projectRequests: string[] };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {},
      env
    );

    expect(response.status).toBe(401);
    expect(env.__projectRequests).toEqual(['project.table.resolve']);
  });

  it('does not leak missing project existence on anonymous read routes', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __projectRequests: string[] };

    const response = await app.request(
      '/v1/projects/absent/tables/users/rows',
      {},
      env
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        details: null
      }
    });
    expect(env.__projectRequests).toEqual(['project.table.resolve']);
  });

  it('rejects wrong-project scoped read keys before resolving private table existence', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __projectRequests: string[] };

    const response = await app.request(
      '/v1/projects/other/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(403);
    expect(env.__projectRequests).toEqual([]);
  });

  it('preserves internal project lookup failures instead of rewriting them as unauthorized', async () => {
    const app = createApp();
    const response = await app.request('/v1/projects/demo/tables/users/rows', {}, createEnv({
      hooks: {
        project: ({ body }) =>
          body.type === 'project.table.resolve' ? new Response('project lookup failed', { status: 500 }) : undefined
      }
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: null
      }
    });
  });

  it('allows anonymous reads for public-read projects and still resolves the table', async () => {
    const app = createApp();
    const env = createEnv({ defaultAuthMode: 'public-read' }) as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
      __cachedReadRequests: CachedReadRequestRecord[];
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {},
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    expect(response.headers.get('cache-tag')).toBeNull();
    expect(env.__projectRequests).toEqual(['project.table.resolve']);
    expect(env.__cachedReadRequests).toHaveLength(1);
    expect(env.__cachedReadRequests[0].authorization).toBeNull();
    expect(env.__cachedReadRequests[0].url).toBe(
      'http://localhost/internal/cache/v1/projects/demo/tables/users/rows'
    );
    expect(env.__tableRequests[0]).toMatchObject({
      type: 'table.rows.list'
    });
  });

  it('preserves cached data-read no-store headers without exposing edge cache metadata', async () => {
    const app = createApp();
    const cases = [
      {
        path: '/v1/projects/demo/tables/users/rows?limit=10'
      },
      {
        path: '/v1/projects/demo/tables/users/schema'
      },
      {
        path: '/v1/projects/demo/tables/users/rows/row-1'
      }
    ];

    for (const { path } of cases) {
      const env = createEnv() as Env & { __cachedReadRequests: CachedReadRequestRecord[] };
      const response = await app.request(
        path,
        {
          headers: {
            authorization: apiKeys.project.authorization
          }
        },
        env
      );

      expect(response.status).toBe(200);
      expectCachedDataReadGatewayHeaders(response);
      expect(env.__cachedReadRequests).toHaveLength(1);
    }
  });

  it('propagates only a non-empty inner cache status under the Sheetflare namespace', async () => {
    const app = createApp();
    const cases = [
      { name: 'present status', innerStatus: ' HIT ', expectedStatus: 'HIT' },
      { name: 'missing status', innerStatus: undefined, expectedStatus: null },
      { name: 'blank status', innerStatus: '   ', expectedStatus: null }
    ];

    for (const { name, innerStatus, expectedStatus } of cases) {
      const env = createEnv(innerStatus === undefined ? undefined : {
        cachedReadResponseHeaders: {
          'cf-cache-status': innerStatus
        }
      });
      const response = await app.request(
        `/v1/projects/demo/tables/users/rows?case=${encodeURIComponent(name)}`,
        {
          headers: {
            authorization: apiKeys.project.authorization
          }
        },
        env
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('x-sheetflare-cache-status')).toBe(expectedStatus);
      expect(response.headers.get('cf-cache-status')).toBeNull();
      expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
      expect(response.headers.get('cache-tag')).toBeNull();
    }
  });

  it('replaces a downstream cacheable client directive with gateway no-store', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?limit=10',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      createEnv({
        cachedReadResponseHeaders: {
          'cache-control': 'public, max-age=600'
        }
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    expect(response.headers.get('cache-tag')).toBeNull();
  });

  it('adds default-gateway request, CORS, and rate-limit headers after cached data reads', async () => {
    const app = createApp();
    const env = createEnv({ allowedOrigins: 'https://client.example' }) as Env & {
      __cachedReadRequests: CachedReadRequestRecord[];
      __rateLimitRequests: Array<{ name: string; key: string }>;
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?limit=10',
      {
        headers: {
          authorization: apiKeys.project.authorization,
          origin: 'https://client.example'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expectCachedDataReadGatewayHeaders(response);
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
    expect(response.headers.get('access-control-allow-origin')).toBe('https://client.example');
    const exposedHeaders = response.headers.get('access-control-expose-headers')
      ?.split(',')
      .map((header) => header.trim().toLowerCase());
    expect(exposedHeaders).toEqual(expect.arrayContaining([
      'x-sheetflare-cache-status',
      'x-sheetflare-cache-invalidation'
    ]));
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('x-ratelimit-limit')).toBe('300');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('299');
    expect(response.headers.get('x-ratelimit-reset')).toEqual(expect.any(String));
    expect(env.__cachedReadRequests).toHaveLength(1);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:data:client:anonymous', key: 'rows.list' },
      { name: `rate-limit:data:api-key:${apiKeys.project.id}`, key: 'rows.list' }
    ]);
  });

  it('returns 429 when the edge rate limit is exceeded', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv({ rateLimitAllowed: false })
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded.',
        details: {
          principal: 'bootstrap-admin',
          routeFamily: 'admin',
          operationKey: 'admin.projects.list',
          maxRequests: 300,
          windowSeconds: 60,
          resetAt: '2026-04-26T00:01:00.000Z'
        }
      }
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"rateLimitOperationKey":"admin.projects.list"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"rateLimitPrincipal":"bootstrap-admin"'));
  });

  it('creates api keys through bootstrap admin auth', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Created key',
          scopes: ['admin:keys']
        })
      },
      createEnv()
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      apiKey: 'sfk_created-key.secret',
      record: {
        id: 'created-key',
        projectSlug: null,
        name: 'Created key',
        scopes: ['admin:keys'],
        createdAt: '2026-04-26T00:00:00.000Z',
        revokedAt: null,
        lastUsedAt: null
      }
    });
  });

  it('lists spreadsheet tabs for an admin project request', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/demo/spreadsheet/tabs',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          title: 'Users',
          sheetGid: 11
        },
        {
          title: 'Archive',
          sheetGid: 12
        }
      ]
    });
  });

  it('inspects one spreadsheet tab header row for an admin project request', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/demo/spreadsheet/tabs/Users?headerRow=3',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        tab: {
          title: 'Users',
          sheetGid: 11
        },
        headerRow: 3,
        headers: ['_id', 'email', 'status']
      }
    });
  });

  it('uses explicit rate-limit keys for spreadsheet discovery routes', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __rateLimitRequests: Array<{ name: string; key: string }> };

    await app.request(
      '/v1/admin/projects/demo/spreadsheet/tabs',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    await app.request(
      '/v1/admin/projects/demo/spreadsheet/tabs/Users?headerRow=3',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:bootstrap-admin', key: 'admin.spreadsheet.tabs.list' },
      { name: 'rate-limit:admin:bootstrap-admin', key: 'admin.spreadsheet.tabs.inspect' }
    ]);
  });

  it('rejects project-scoped key creation outside the caller project', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys',
      {
        method: 'POST',
        headers: {
          authorization: apiKeys.projectAdmin.authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Wrong key',
          projectSlug: 'other',
          scopes: ['table:read']
        })
      },
      createEnv()
    );

    expect(response.status).toBe(403);
  });

  it('rejects project-scoped key creation that grants scopes the caller does not have', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys',
      {
        method: 'POST',
        headers: {
          authorization: apiKeys.projectAdmin.authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Escalated key',
          projectSlug: 'demo',
          scopes: ['table:delete']
        })
      },
      createEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'API keys can only delegate scopes they already have.',
        details: null
      }
    });
  });

  it('rejects global API key creation that grants scopes the caller does not have', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys',
      {
        method: 'POST',
        headers: {
          authorization: apiKeys.global.authorization,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Escalated global key',
          scopes: ['admin:projects', 'table:delete']
        })
      },
      createEnv()
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'API keys can only delegate scopes they already have.',
        details: null
      }
    });
  });

  it('rejects revoking another project or global key with a project-scoped admin key', async () => {
    const app = createApp();
    const response = await app.request(
      `/v1/admin/keys/${apiKeys.global.id}`,
      {
        method: 'DELETE',
        headers: {
          authorization: apiKeys.projectAdmin.authorization
        }
      },
      createEnv()
    );

    expect(response.status).toBe(403);
  });

  it('returns table cache status for admin requests', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects/demo/tables/users/cache',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        status: 'ready',
        cacheTtlSeconds: 15,
        stale: false,
        staleReason: 'fresh',
        rowCount: 2,
        lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
        lastSyncCompletedAt: '2026-04-26T00:00:01.000Z',
        lastSyncError: null,
        validation: {
          status: 'ok',
          issueCount: 0,
          issues: [],
          validatedAt: '2026-04-26T00:00:02.000Z'
        },
        externalChange: {
          pending: false,
          lastChangedAt: null,
          debounceUntil: null,
          lastAutoReindexAt: null
        }
      }
    });
  });

  it('returns a controlled service unavailable error for an unexpected table cache status response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    const path = '/v1/admin/projects/demo/tables/users/cache';

    try {
      const response = await app.request(
        path,
        {
          headers: {
            authorization: 'Bearer secret'
          }
        },
        createEnv({ tableCacheGetUnexpectedResponse: true })
      );

      expect(response.status).toBe(503);
      const responseBody: unknown = await response.json();
      expect(responseBody).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Unexpected table cache status response.',
          details: null
        }
      });

      const requestId = response.headers.get('x-request-id');
      expect(requestId).toEqual(expect.any(String));
      if (requestId === null) {
        throw new Error('Expected the response to include a request ID.');
      }
      const matchingEvents = errorSpy.mock.calls.flatMap(([errorLog]) => {
        if (typeof errorLog !== 'string') {
          return [];
        }
        try {
          const event: unknown = JSON.parse(errorLog);
          const identity = z.object({
            event: z.literal('request.error'),
            path: z.literal(path),
            requestId: z.literal(requestId)
          }).safeParse(event);
          return identity.success ? [event] : [];
        } catch {
          return [];
        }
      });
      expect(matchingEvents).toHaveLength(1);
      expect(matchingEvents[0]).toMatchObject({
        event: 'request.error',
        method: 'GET',
        path,
        requestId,
        errorName: 'ServiceUnavailableError',
        errorMessage: 'Unexpected table cache status response.'
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each([
    {
      name: 'cache refresh',
      requestType: 'table.cache.refresh',
      path: '/v1/admin/projects/demo/tables/users/refresh',
      init: {
        method: 'POST',
        headers: { authorization: 'Bearer secret' }
      },
      message: 'Unexpected table cache refresh response.',
      requestTypes: ['table.cache.get', 'table.cache.refresh'],
    },
    {
      name: 'table reindex',
      requestType: 'table.reindex',
      path: '/v1/admin/projects/demo/tables/users/reindex',
      init: {
        method: 'POST',
        headers: { authorization: 'Bearer secret' }
      },
      message: 'Unexpected table reindex response.',
      requestTypes: ['table.reindex'],
    },
    {
      name: 'row create',
      requestType: 'table.row.create',
      path: '/v1/projects/demo/tables/users/rows',
      init: {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ values: { name: 'Ada' } })
      },
      message: 'Unexpected table row create response.',
      requestTypes: ['table.row.create'],
    },
    {
      name: 'row update',
      requestType: 'table.row.update',
      path: '/v1/projects/demo/tables/users/rows/row-1',
      init: {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ values: { name: 'Grace' } })
      },
      message: 'Unexpected table row update response.',
      requestTypes: ['table.row.update'],
    },
    {
      name: 'row delete',
      requestType: 'table.row.delete',
      path: '/v1/projects/demo/tables/users/rows/row-1',
      init: {
        method: 'DELETE',
        headers: { authorization: 'Bearer secret' }
      },
      message: 'Unexpected table row delete response.',
      requestTypes: ['table.row.delete'],
    }
  ] satisfies Array<{
    name: string;
    requestType: UnexpectedTableResponseRequest;
    path: string;
    init: RequestInit;
    message: string;
    requestTypes: string[];
  }>)('rejects an unexpected TableDO response for $name before cache invalidation', async ({
    requestType,
    path,
    init,
    message,
    requestTypes
  }) => {
    const app = createApp();
    const env = createEnv({
      tableUnexpectedResponseFor: requestType,
      tableCacheStale: true,
      tableCacheStaleReason: 'ttl-expired'
    });
    const response = await app.request(path, init, env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message,
        details: null
      }
    });
    expect(Reflect.get(env, '__cachedReadPurgeCalls')).toEqual([]);
    expect(Reflect.get(env, '__tableRequests')).toEqual(
      requestTypes.map((type) => expect.objectContaining({ type }))
    );
  });

  it('refreshes a table cache if it is stale for admin requests', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
    };
    const response = await app.request(
      '/v1/admin/projects/demo/tables/users/refresh',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      rowCount: 3,
      cache: {
        status: 'ready',
        cacheTtlSeconds: 15,
        stale: false,
        staleReason: 'fresh',
        rowCount: 3,
        lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
        lastSyncCompletedAt: '2026-04-26T00:00:02.000Z',
        lastSyncError: null,
        validation: {
          status: 'ok',
          issueCount: 0,
          issues: [],
          validatedAt: '2026-04-26T00:00:03.000Z'
        },
        externalChange: {
          pending: false,
          lastChangedAt: null,
          debounceUntil: null,
          lastAutoReindexAt: null
        }
      }
    });
    expect(env.__tableRequests.at(-1)).toMatchObject({
      type: 'table.cache.refresh',
      requestContext: {
        route: 'admin.cache.refresh',
        principal: 'bootstrap-admin'
      }
    });
  });

  it('purges table tags after refreshing stale or not-ready admin caches', async () => {
    const app = createApp();
    const cases = [
      {
        name: 'stale cache',
        envOptions: { tableCacheStatus: 'ready' as const, tableCacheStale: true, tableCacheStaleReason: 'ttl-expired' as const }
      },
      {
        name: 'not-ready cache',
        envOptions: { tableCacheStatus: 'idle' as const, tableCacheStale: true, tableCacheStaleReason: 'never-synced' as const }
      }
    ];

    for (const { name, envOptions } of cases) {
      const env = createEnv(envOptions) as Env & {
        __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
        __cachedReadPurgeCalls: CachePurgeCall[];
      };
      const response = await app.request(
        `/v1/admin/projects/demo/tables/users/refresh?case=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer secret'
          }
        },
        env
      );

      expect(response.status).toBe(200);
      expect(env.__tableRequests.map((request) => request.type)).toContain('table.cache.refresh');
      expect(env.__tableRequests.at(-1)).toMatchObject({
        type: 'table.cache.refresh',
        requestContext: {
          route: 'admin.cache.refresh',
          principal: 'bootstrap-admin'
        }
      });
      expectCachedReadPurgeCalls(env, [
        ['table:demo:users']
      ]);
    }
  });

  it('purges table tags after a successful admin table reindex', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
      __cachedReadPurgeCalls: CachePurgeCall[];
    };
    const response = await app.request(
      '/v1/admin/projects/demo/tables/users/reindex',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      rowCount: 3,
      cache: expect.objectContaining({
        status: 'ready',
        stale: false,
        rowCount: 3
      })
    });
    expect(env.__tableRequests.at(-1)).toMatchObject({
      type: 'table.reindex',
      requestContext: {
        route: 'admin.cache.reindex',
        principal: 'bootstrap-admin'
      }
    });
    expectCachedReadPurgeCalls(env, [
      ['table:demo:users']
    ]);
  });

  it('parses filter queries for row listing', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?filter=%7B%22status%22%3A%7B%22eq%22%3A%22active%22%7D%7D',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          id: 'row-1',
          rowNumber: 2,
          values: {
            matched: true
          }
        }
      ],
      nextCursor: null
    });
  });

  it('accepts numeric limit query parameters on row listing', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?limit=10',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          id: 'row-1',
          rowNumber: 2,
          values: {
            matched: true
          }
        }
      ],
      nextCursor: null
    });
  });

  it('uses separate rate-limit buckets for admin and data routes', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __rateLimitRequests: Array<{ name: string; key: string }> };

    await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer secret'
        }
      },
      env
    );

    await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:bootstrap-admin', key: 'admin.projects.list' },
      {
        name: 'rate-limit:data:client:anonymous',
        key: 'rows.list'
      },
      {
        name: `rate-limit:data:api-key:${apiKeys.project.id}`,
        key: 'rows.list'
      }
    ]);
  });

  it('uses the client bucket before authentication and never targets a real api-key bucket for forged credentials', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __rateLimitRequests: Array<{ name: string; key: string }>;
      __verifyApiKeyCallCount: number;
    };

    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: forgedApiKey.authorization
        }
      },
      env
    );

    expect(response.status).toBe(401);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:client:anonymous', key: 'admin.projects.list' }
    ]);
    expect(env.__verifyApiKeyCallCount).toBe(1);
  });

  it('uses a verified per-key bucket after authentication succeeds', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __rateLimitRequests: Array<{ name: string; key: string }>;
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:data:client:anonymous', key: 'rows.list' },
      { name: `rate-limit:data:api-key:${apiKeys.project.id}`, key: 'rows.list' }
    ]);
  });

  it('does not verify api-key credentials before source-based rate limiting rejects the request', async () => {
    const app = createApp();
    const env = createEnv({ rateLimitAllowed: false }) as Env & {
      __rateLimitRequests: Array<{ name: string; key: string }>;
      __verifyApiKeyCallCount: number;
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(429);
    expect(env.__verifyApiKeyCallCount).toBe(0);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:data:client:anonymous', key: 'rows.list' }
    ]);
  });

  it('ignores x-forwarded-for when deriving the anonymous rate-limit principal', async () => {
    const app = createApp();
    const env = createEnv({ rateLimitAllowed: false }) as Env & { __rateLimitRequests: Array<{ name: string; key: string }> };

    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          'x-forwarded-for': '203.0.113.10'
        }
      },
      env
    );

    expect(response.status).toBe(429);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:client:anonymous', key: 'admin.projects.list' }
    ]);
  });

  it('verifies API-key credentials only once per request', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __verifyApiKeyCallCount: number };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(env.__verifyApiKeyCallCount).toBe(1);
  });

  it('throttles api-key touch updates across repeated requests from the same key', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __apiKeyTouchCallCount: number };

    const first = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.touch.authorization
        }
      },
      env
    );
    const second = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: apiKeys.touch.authorization
        }
      },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(env.__apiKeyTouchCallCount).toBe(1);
  });

  it('caps the in-memory api-key touch cache under high key churn', async () => {
    const env = createEnv() as Env & { __apiKeyTouchCallCount: number };

    for (let index = 0; index <= 10_000; index += 1) {
      await __touchApiKeyIfNeededForTests(env, `touch-key-${index}`);
    }

    expect(env.__apiKeyTouchCallCount).toBe(10_001);
    expect(__getRecentApiKeyTouchCacheSizeForTests()).toBe(10_000);
  });

  it('sends resolved config to cached list-row origin reads without leaking it into the cache URL or key', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __controlPlaneRequests: Array<{ type: string }>;
      __tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown>; requestContext?: Record<string, unknown> }>;
      __projectRequests: string[];
      __cachedReadRequests: CachedReadRequestRecord[];
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?limit=10',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        {
          id: 'row-1',
          rowNumber: 2,
          values: {
            matched: true
          }
        }
      ],
      nextCursor: null
    });
    expect(env.__controlPlaneRequests[0]?.type).toBe('control.api-key.verify');
    expect(env.__projectRequests).toContain('project.table.resolve');
    expect(env.__projectRequests).not.toContain('project.get');
    const cachedReadRequest = getOnlyCachedReadRequest(env);
    expect(cachedReadRequest).toEqual({
      url: 'http://localhost/internal/cache/v1/projects/demo/tables/users/rows?limit=10',
      method: 'GET',
      authorization: null,
      cacheKey: expect.any(String)
    });
    const cacheKey = requireCacheKey(cachedReadRequest);
    expectNoCredentialMaterial(cachedReadRequest.url);
    expectNoCredentialMaterial(cacheKey);
    for (const rawConfigMarker of ['sheet-1', 'googleCredentialRef', 'sheetTabName', 'cacheTtlSeconds']) {
      expect(cachedReadRequest.url).not.toContain(rawConfigMarker);
      expect(cacheKey).not.toContain(rawConfigMarker);
    }
    const expectedResolvedConfig = {
      spreadsheetId: 'sheet-1',
      googleCredentialRef: 'default',
      projectSlug: 'demo',
      tableSlug: 'users',
      cacheTtlSeconds: 15
    };
    expect(env.__tableRequests.find(({ type }) => type === 'table.rows.list')).toMatchObject({
      type: 'table.rows.list',
      resolvedConfig: expectedResolvedConfig
    });
    expect(env.__tableRequests.find(({ type }) => type === 'table.cache.get')).toMatchObject({
      type: 'table.cache.get',
      resolvedConfig: expectedResolvedConfig
    });
  });

  it('canonicalizes semantically identical list-row query strings into one cached URL and cache key', async () => {
    const app = createApp();
    const firstEnv = createEnv({ defaultAuthMode: 'private' }) as Env & {
      __cachedReadRequests: CachedReadRequestRecord[];
    };
    const firstQuery = new URLSearchParams([
      ['filter', JSON.stringify({ status: { eq: 'active' }, email: { eq: 'a@example.com' } })],
      ['limit', '10'],
      ['fields', 'email,status'],
      ['sort', 'email:asc']
    ]);
    const secondQuery = new URLSearchParams([
      ['sort', 'email:asc'],
      ['fields', 'email,status'],
      ['limit', '10'],
      ['filter', JSON.stringify({ email: { eq: 'a@example.com' }, status: { eq: 'active' } })]
    ]);
    const expectedCanonicalQuery = new URLSearchParams([
      ['limit', '10'],
      ['sort', 'email:asc'],
      ['fields', 'email,status'],
      ['filter', '{"email":{"eq":"a@example.com"},"status":{"eq":"active"}}']
    ]).toString();

    const firstResponse = await app.request(
      `/v1/projects/demo/tables/users/rows?${firstQuery.toString()}`,
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      firstEnv
    );
    const secondEnv = createEnv({ defaultAuthMode: 'private' }) as Env & {
      __cachedReadRequests: CachedReadRequestRecord[];
    };
    const secondResponse = await app.request(
      `/v1/projects/demo/tables/users/rows?${secondQuery.toString()}`,
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      secondEnv
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstRecord = getOnlyCachedReadRequest(firstEnv);
    const secondRecord = getOnlyCachedReadRequest(secondEnv);
    expect(firstRecord.url).toBe(`http://localhost/internal/cache/v1/projects/demo/tables/users/rows?${expectedCanonicalQuery}`);
    expect(secondRecord.url).toBe(firstRecord.url);
    expect(firstRecord.authorization).toBeNull();
    expect(secondRecord.authorization).toBeNull();
    const firstCacheKey = requireCacheKey(firstRecord);
    const secondCacheKey = requireCacheKey(secondRecord);
    expect(secondCacheKey).toBe(firstCacheKey);
    const cacheKeyUrl = new URL(firstCacheKey);
    expect(cacheKeyUrl.origin).toBe('https://sheetflare-cache.internal');
    expect(cacheKeyUrl.pathname).toBe('/internal/cache/v1/projects/demo/tables/users/rows');
    expect(cacheKeyUrl.searchParams.get('limit')).toBe('10');
    expect(cacheKeyUrl.searchParams.get('sort')).toBe('email:asc');
    expect(cacheKeyUrl.searchParams.get('fields')).toBe('email,status');
    expect(cacheKeyUrl.searchParams.get('filter')).toBe('{"email":{"eq":"a@example.com"},"status":{"eq":"active"}}');
    expect(cacheKeyUrl.searchParams.get('__sf_auth')).toBe('private');
    expect(cacheKeyUrl.searchParams.get('__sf_config')).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expectNoCredentialMaterial(firstRecord.url);
    expectNoCredentialMaterial(firstCacheKey);
  });

  it('orders Unicode filter keys by deterministic UTF-16 code units in cached URLs and keys', async () => {
    const app = createApp();
    const readCanonicalRequest = async (filter: Record<string, { eq: string }>) => {
      const env = createEnv({ defaultAuthMode: 'private' }) as Env & {
        __cachedReadRequests: CachedReadRequestRecord[];
      };
      const query = new URLSearchParams([
        ['filter', JSON.stringify(filter)]
      ]);
      const response = await app.request(
        `/v1/projects/demo/tables/users/rows?${query.toString()}`,
        {
          headers: {
            authorization: apiKeys.project.authorization
          }
        },
        env
      );

      expect(response.status).toBe(200);
      const record = getOnlyCachedReadRequest(env);
      return {
        url: record.url,
        cacheKey: requireCacheKey(record),
        filter: new URL(record.url).searchParams.get('filter')
      };
    };

    const accentFirst = await readCanonicalRequest({
      'éclair': { eq: 'accented' },
      zebra: { eq: 'ascii' }
    });
    const asciiFirst = await readCanonicalRequest({
      zebra: { eq: 'ascii' },
      'éclair': { eq: 'accented' }
    });

    expect(accentFirst.filter).toBe('{"zebra":{"eq":"ascii"},"éclair":{"eq":"accented"}}');
    expect(asciiFirst.url).toBe(accentFirst.url);
    expect(asciiFirst.cacheKey).toBe(accentFirst.cacheKey);
  });

  it('partitions list-row cache keys by project auth mode and resolved table config', async () => {
    const app = createApp();
    const readCacheKey = async (env: Env & { __cachedReadRequests: CachedReadRequestRecord[] }) => {
      const response = await app.request(
        '/v1/projects/demo/tables/users/rows?limit=10',
        {
          headers: {
            authorization: apiKeys.project.authorization
          }
        },
        env
      );

      expect(response.status).toBe(200);
      return requireCacheKey(getOnlyCachedReadRequest(env));
    };

    const privateCacheKey = await readCacheKey(createEnv({
      defaultAuthMode: 'private',
      tableCacheTtlSeconds: 15
    }) as Env & { __cachedReadRequests: CachedReadRequestRecord[] });
    const publicReadCacheKey = await readCacheKey(createEnv({
      defaultAuthMode: 'public-read',
      tableCacheTtlSeconds: 15
    }) as Env & {
      __cachedReadRequests: CachedReadRequestRecord[];
    });
    const changedConfigCacheKey = await readCacheKey(createEnv({
      defaultAuthMode: 'private',
      tableCacheTtlSeconds: 30
    }) as Env & {
      __cachedReadRequests: CachedReadRequestRecord[];
    });

    expect(publicReadCacheKey).not.toBe(privateCacheKey);
    expect(changedConfigCacheKey).not.toBe(privateCacheKey);
    const privateCacheKeyUrl = new URL(privateCacheKey);
    const publicReadCacheKeyUrl = new URL(publicReadCacheKey);
    const changedConfigCacheKeyUrl = new URL(changedConfigCacheKey);
    expect(privateCacheKeyUrl.searchParams.get('__sf_auth')).toBe('private');
    expect(publicReadCacheKeyUrl.searchParams.get('__sf_auth')).toBe('public-read');
    expect(changedConfigCacheKeyUrl.searchParams.get('__sf_auth')).toBe('private');
    expect(changedConfigCacheKeyUrl.searchParams.get('__sf_config')).not.toBe(
      privateCacheKeyUrl.searchParams.get('__sf_config')
    );
    expectNoCredentialMaterial(privateCacheKey);
    expectNoCredentialMaterial(publicReadCacheKey);
    expectNoCredentialMaterial(changedConfigCacheKey);
  });

  it('routes authorized schema reads through the cached entrypoint with a path-scoped secret-free cache key', async () => {
    const app = createApp();
    const env = createEnv({ defaultAuthMode: 'private' }) as Env & {
      __tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown>; requestContext?: Record<string, unknown> }>;
      __projectRequests: string[];
      __cachedReadRequests: CachedReadRequestRecord[];
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/schema',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        fields: [
          {
            name: '_id',
            inferredType: 'string',
            nullable: false
          }
        ],
        inferredAt: '2026-04-26T00:00:00.000Z'
      }
    });
    expect(env.__projectRequests).toContain('project.table.resolve');
    expect(env.__cachedReadRequests).toEqual([
      {
        url: 'http://localhost/internal/cache/v1/projects/demo/tables/users/schema',
        method: 'GET',
        authorization: null,
        cacheKey: expect.any(String)
      }
    ]);
    const schemaCacheKey = requireCacheKey(getOnlyCachedReadRequest(env));
    const schemaCacheKeyUrl = new URL(schemaCacheKey);
    expect(schemaCacheKeyUrl.pathname).toBe('/internal/cache/v1/projects/demo/tables/users/schema');
    expect(schemaCacheKeyUrl.searchParams.get('__sf_auth')).toBe('private');
    expect(schemaCacheKeyUrl.searchParams.get('__sf_config')).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expectNoCredentialMaterial(env.__cachedReadRequests[0]?.url ?? '');
    expectNoCredentialMaterial(schemaCacheKey);
    expect(env.__tableRequests[0]).toMatchObject({
      type: 'table.schema.get',
      resolvedConfig: defaultCachedTableReadProps.resolvedConfig,
      requestContext: undefined
    });
  });

  it('routes authorized get-row reads through the cached entrypoint with a row-scoped secret-free cache key', async () => {
    const app = createApp();
    const env = createEnv({ defaultAuthMode: 'private' }) as Env & {
      __tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown>; requestContext?: Record<string, unknown> }>;
      __projectRequests: string[];
      __cachedReadRequests: CachedReadRequestRecord[];
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows/row-1',
      {
        headers: {
          authorization: apiKeys.project.authorization
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        id: 'row-1',
        rowNumber: 2,
        values: {}
      }
    });
    expect(env.__projectRequests).toContain('project.table.resolve');
    expect(env.__cachedReadRequests).toEqual([
      {
        url: 'http://localhost/internal/cache/v1/projects/demo/tables/users/rows/row-1',
        method: 'GET',
        authorization: null,
        cacheKey: expect.any(String)
      }
    ]);
    const rowCacheKey = requireCacheKey(getOnlyCachedReadRequest(env));
    const rowCacheKeyUrl = new URL(rowCacheKey);
    expect(rowCacheKeyUrl.pathname).toBe('/internal/cache/v1/projects/demo/tables/users/rows/row-1');
    expect(rowCacheKeyUrl.searchParams.get('__sf_auth')).toBe('private');
    expect(rowCacheKeyUrl.searchParams.get('__sf_config')).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expectNoCredentialMaterial(env.__cachedReadRequests[0]?.url ?? '');
    expectNoCredentialMaterial(rowCacheKey);
    expect(env.__tableRequests[0]).toMatchObject({
      type: 'table.row.get',
      resolvedConfig: defaultCachedTableReadProps.resolvedConfig,
      requestContext: undefined
    });
  });

  it('serves an OpenAPI document with the expected API surface', async () => {
    const app = createApp();
    const response = await app.request('/doc', {}, createEnv());

    expect(response.status).toBe(200);
    const document = z.object({
      openapi: z.string(),
      info: z.object({
        title: z.string()
      }),
      paths: z.record(z.string(), z.unknown()),
      components: z.object({
        securitySchemes: z.record(z.string(), z.unknown())
      }).optional()
    }).parse(await response.json());

    expect(document.openapi).toBe('3.0.0');
    expect(document.info.title).toBe('Sheetflare API');
    expect(document.paths['/v1/admin/projects']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/spreadsheet/tabs']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/spreadsheet/tabs/{tab}']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/tables']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/tables/{table}']).toBeDefined();
    expect(document.paths['/v1/projects/{project}/tables/{table}/rows']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/tables/{table}/cache']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/tables/{table}/refresh']).toBeDefined();
    expect(document.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it('serves the interactive docs page', async () => {
    const app = createApp();
    const response = await app.request('/docs', {}, createEnv());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('Sheetflare API Docs');
    expect(html).toContain('/doc');
  });
});

describe('hosted admin UI', () => {
  const hostedCsp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

  function createAdminEnv(adminUi: string | undefined, withAssets = true) {
    const assetPaths: string[] = [];
    const assets = {
      async fetch(request: Request) {
        const path = new URL(request.url).pathname;
        assetPaths.push(path);
        if (path === '/admin/' || path === '/admin/index.html') {
          return new Response('<!doctype html><title>Sheetflare Admin</title>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'public, max-age=0, must-revalidate',
              etag: '"admin-index"'
            }
          });
        }
        return new Response(null, { status: 404 });
      }
    };
    const env: Env = {
      ...createEnv(),
      ...(adminUi === undefined ? {} : { ADMIN_UI: adminUi }),
      ...(withAssets ? { ASSETS: assets } : {})
    };
    return { env, assetPaths };
  }

  it('serves admin assets with the hosted security headers', async () => {
    const { env, assetPaths } = createAdminEnv('enabled');
    const response = await createApp().request('/admin/', {}, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Sheetflare Admin');
    expect(assetPaths).toEqual(['/admin/']);
    expect(response.headers.get('content-security-policy')).toBe(hostedCsp);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('etag')).toBe('"admin-index"');
  });

  it('keeps security headers on missing admin assets', async () => {
    const { env } = createAdminEnv('enabled');
    const response = await createApp().request('/admin/missing.js', {}, env);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toBe(hostedCsp);
  });

  it('redirects the bare admin path to the trailing-slash entry point', async () => {
    const { env, assetPaths } = createAdminEnv('enabled');
    const response = await createApp().request('/admin', {}, env);

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/admin/');
    expect(assetPaths).toEqual([]);
  });

  it.each([
    { name: 'unset', adminUi: undefined },
    { name: 'disabled', adminUi: 'disabled' }
  ])('returns the standard not-found error without reading assets when ADMIN_UI is $name', async ({ adminUi }) => {
    const { env, assetPaths } = createAdminEnv(adminUi);
    const response = await createApp().request('/admin/', {}, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(assetPaths).toEqual([]);
  });

  it.each([
    { name: 'ADMIN_UI is invalid', adminUi: 'on', withAssets: true, status: 'invalid', note: 'ADMIN_UI must be "enabled" or "disabled". The hosted admin UI returns 503 until it is fixed.' },
    { name: 'assets are missing', adminUi: 'enabled', withAssets: false, status: 'assets-missing', note: 'ADMIN_UI is enabled but the ASSETS binding is missing. Build the admin UI and redeploy.' }
  ])('fails clearly and reports readiness when $name', async ({ adminUi, withAssets, status, note }) => {
    const { env, assetPaths } = createAdminEnv(adminUi, withAssets);
    const app = createApp();

    const adminResponse = await app.request('/admin/', {}, env);
    expect(adminResponse.status).toBe(503);
    expect(await adminResponse.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
    expect(assetPaths).toEqual([]);

    const readyResponse = await app.request('/ready', {}, env);
    const ready = z.object({ ok: z.boolean(), checks: z.object({ adminUi: z.string() }), notes: z.array(z.string()) }).parse(await readyResponse.json());
    expect(ready.ok).toBe(true);
    expect(ready.checks.adminUi).toBe(status);
    expect(ready.notes).toContain(note);
  });

  it('reports an enabled admin UI in readiness', async () => {
    const { env } = createAdminEnv('enabled');
    const response = await createApp().request('/ready', {}, env);

    expect(await response.json()).toMatchObject({ checks: { adminUi: 'enabled' } });
  });

  it('tells the admin UI that the Worker holds no server credential', async () => {
    const { env } = createAdminEnv('enabled');
    const response = await createApp().request('/__sheetflare/admin-session', {}, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ serverCredential: false });
  });

  it.each([
    { name: 'a write to the admin path', path: '/admin/', init: { method: 'POST' } },
    { name: 'a root asset path', path: '/index.html', init: {} },
    { name: 'a root assets directory path', path: '/assets/index.js', init: {} },
    { name: 'a path that only starts with admin', path: '/administrator', init: {} }
  ])('never reads assets for $name', async ({ path, init }) => {
    const { env, assetPaths } = createAdminEnv('enabled');
    const response = await createApp().request(path, init, env);

    expect(response.status).toBe(404);
    expect(assetPaths).toEqual([]);
  });
});
