import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/index';

type StubHandler = (request: Request) => Response | Promise<Response>;

class FakeDurableObjectStub {
  constructor(private readonly handler: StubHandler) {}

  fetch(request: RequestInfo | URL, init?: RequestInit) {
    return this.handler(new Request(request, init));
  }
}

class FakeDurableObjectNamespace {
  constructor(private readonly handlerForName: (name: string) => StubHandler) {}

  idFromName(name: string) {
    return name;
  }

  get(name: string) {
    return new FakeDurableObjectStub(this.handlerForName(name));
  }
}

function createEnv(options?: { rateLimitAllowed?: boolean }): Env {
  const rateLimitRequests: Array<{ name: string; key: string }> = [];
  const projectRequests: string[] = [];
  const tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown> }> = [];
  let verifyApiKeyCallCount = 0;
  const controlPlane = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as { type: string; apiKeyId?: string; hash?: string; projectSlug?: string | null };

    if (body.type === 'control.api-key.verify') {
      verifyApiKeyCallCount += 1;
      return Response.json({
        type: 'control.api-key.verify.result',
        result: {
          record:
            body.apiKeyId === 'project-key'
              ? {
                  id: 'project-key',
                  projectSlug: 'demo',
                  name: 'Demo key',
                  scopes: ['table:create', 'table:read'],
                  createdAt: '2026-04-26T00:00:00.000Z',
                  revokedAt: null,
                  lastUsedAt: null
                }
              : body.apiKeyId === 'project-admin-key'
                ? {
                    id: 'project-admin-key',
                    projectSlug: 'demo',
                    name: 'Demo admin key',
                    scopes: ['admin:projects', 'admin:keys', 'table:read'],
                    createdAt: '2026-04-26T00:00:00.000Z',
                    revokedAt: null,
                    lastUsedAt: null
                  }
                : null
        }
      });
    }

    if (body.type === 'control.api-key.touch') {
      return Response.json({
        type: 'control.api-key.touch.result',
        result: { ok: true }
      });
    }

    if (body.type === 'control.api-key.create') {
      return Response.json({
        type: 'control.api-key.create.result',
        result: {
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
        }
      });
    }

    if (body.type === 'control.api-keys.list') {
      return Response.json({
        type: 'control.api-keys.list.result',
        result: {
          data: [
            {
              id: 'project-key',
              projectSlug: body.projectSlug ?? 'demo',
              name: 'Demo key',
              scopes: ['table:create', 'table:read'],
              createdAt: '2026-04-26T00:00:00.000Z',
              revokedAt: null,
              lastUsedAt: null
            }
          ]
        }
      });
    }

    if (body.type === 'control.api-key.get') {
      return Response.json({
        type: 'control.api-key.get.result',
        result: {
          record: body.apiKeyId === 'project-key'
            ? {
                id: 'project-key',
                projectSlug: 'demo',
                name: 'Demo key',
                scopes: ['table:create', 'table:read'],
                createdAt: '2026-04-26T00:00:00.000Z',
                revokedAt: null,
                lastUsedAt: null
              }
            : body.apiKeyId === 'global-key'
              ? {
                  id: 'global-key',
                  projectSlug: null,
                  name: 'Global key',
                  scopes: ['admin:keys'],
                  createdAt: '2026-04-26T00:00:00.000Z',
                  revokedAt: null,
                  lastUsedAt: null
                }
              : null
        }
      });
    }

    return Response.json({
      type: 'control.projects.list.result',
      result: {
        data: [
          {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            tableCount: 2,
            updatedAt: '2026-04-26T00:00:00.000Z'
          }
        ]
      }
    });
  });

  const project = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as { type: string };
    projectRequests.push(body.type);
    const table = {
      projectSlug: 'demo',
      tableSlug: 'users',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    };

    if (body.type === 'project.get') {
      return Response.json({
        type: 'project.get.result',
        result: {
          project: {
            slug: 'demo',
            name: 'Demo',
            spreadsheetId: 'sheet-1',
            googleCredentialRef: 'default',
            createdAt: '2026-04-26T00:00:00.000Z',
            updatedAt: '2026-04-26T00:00:00.000Z',
            defaultAuthMode: 'private'
          },
          tables: [table]
        }
      });
    }

    if (body.type === 'project.table.resolve') {
      return Response.json({
        type: 'project.table.resolve.result',
        result: {
          data: {
            project: {
              slug: 'demo',
              spreadsheetId: 'sheet-1',
              googleCredentialRef: 'default',
              defaultAuthMode: 'private'
            },
            table,
            resolvedConfig: {
              ...table,
              spreadsheetId: 'sheet-1',
              googleCredentialRef: 'default'
            }
          }
        }
      });
    }

    return Response.json({
      type: 'project.table.create.result',
      result: {
        data: table
      }
    });
  });

  const table = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as {
      type: string;
      input?: { values?: Record<string, unknown> };
      query?: unknown;
      resolvedConfig?: Record<string, unknown>;
    };
    tableRequests.push({
      type: body.type,
      resolvedConfig: body.resolvedConfig
    });

    if (body.type === 'table.row.create') {
      return Response.json({
        type: 'table.row.create.result',
        result: {
          data: {
            id: 'row-1',
            rowNumber: 2,
            values: body.input?.values ?? {}
          },
          ignoredKeys: []
        }
      });
    }

    if (body.type === 'table.cache.get') {
      return Response.json({
        type: 'table.cache.get.result',
        result: {
          data: {
            status: 'ready',
            cacheTtlSeconds: 15,
            stale: false,
            staleReason: 'fresh',
            rowCount: 2,
            lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
            lastSyncCompletedAt: '2026-04-26T00:00:01.000Z',
            lastSyncError: null
          }
        }
      });
    }

    if (body.type === 'table.rows.list') {
      return Response.json({
        type: 'table.rows.list.result',
        result: {
          data: body.query ? [{ id: 'row-1', rowNumber: 2, values: { matched: true } }] : [],
          nextCursor: null
        }
      });
    }

    return Response.json({
      type: 'table.row.get.result',
      result: {
        data: {
          id: 'row-1',
          rowNumber: 2,
          values: {}
        }
      }
    });
  });

  const rateLimit = new FakeDurableObjectNamespace((name) => async (request) => {
    const body = (await request.json()) as { key: string };
    rateLimitRequests.push({ name, key: body.key });
    return Response.json({
      type: 'rate-limit.check.result',
      result: {
        allowed: options?.rateLimitAllowed ?? true,
        remaining: options?.rateLimitAllowed === false ? 0 : 299,
        resetAtMs: Date.parse('2026-04-26T00:01:00.000Z')
      }
    });
  });

  const env: Env = {
    CONTROL_PLANE_DO: controlPlane as never,
    PROJECT_DO: project as never,
    TABLE_DO: table as never,
    RATE_LIMIT_DO: rateLimit as never,
    GOOGLE_CLIENT_EMAIL: 'service@example.com',
    GOOGLE_PRIVATE_KEY: 'private-key',
    ADMIN_BEARER_TOKEN: 'secret',
    RATE_LIMIT_MAX_REQUESTS: '300',
    RATE_LIMIT_WINDOW_SECONDS: '60'
  };

  Object.defineProperty(env, '__rateLimitRequests', {
    value: rateLimitRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__tableRequests', {
    value: tableRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__projectRequests', {
    value: projectRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__verifyApiKeyCallCount', {
    get: () => verifyApiKeyCallCount,
    enumerable: false
  });

  return env;
}

describe('api routes', () => {
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
          tableCount: 2,
          updatedAt: '2026-04-26T00:00:00.000Z'
        }
      ]
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
        bootstrapAdmin: 'configured'
      },
      notes: []
    });
  });

  it('rejects global project listing for project-scoped admin keys', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer sfk_project-admin-key.any-secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(401);
  });

  it('creates rows against the table durable object', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sfk_project-key.any-secret'
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

  it('returns 429 when the edge rate limit is exceeded', async () => {
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
          maxRequests: 300,
          windowSeconds: 60,
          resetAt: '2026-04-26T00:01:00.000Z'
        }
      }
    });
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

  it('rejects project-scoped key creation outside the caller project', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer sfk_project-admin-key.any-secret',
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

    expect(response.status).toBe(401);
  });

  it('rejects revoking another project or global key with a project-scoped admin key', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/admin/keys/global-key',
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer sfk_project-admin-key.any-secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(401);
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
        lastSyncError: null
      }
    });
  });

  it('parses filter queries for row listing', async () => {
    const app = createApp();
    const response = await app.request(
      '/v1/projects/demo/tables/users/rows?filter=%7B%22status%22%3A%7B%22eq%22%3A%22active%22%7D%7D',
      {
        headers: {
          authorization: 'Bearer sfk_project-key.any-secret'
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
          authorization: 'Bearer sfk_project-key.any-secret'
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
          authorization: 'Bearer sfk_project-key.any-secret'
        }
      },
      env
    );

    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:bootstrap-admin', key: 'GET' },
      { name: 'rate-limit:data:api-key:project-key', key: 'GET' }
    ]);
  });

  it('falls back to the anonymous client bucket for unverified api-key shaped credentials', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __rateLimitRequests: Array<{ name: string; key: string }> };

    const response = await app.request(
      '/v1/admin/projects',
      {
        headers: {
          authorization: 'Bearer sfk_forged-key.any-secret'
        }
      },
      env
    );

    expect(response.status).toBe(401);
    expect(env.__rateLimitRequests).toEqual([
      { name: 'rate-limit:admin:client:anonymous', key: 'GET' }
    ]);
  });

  it('verifies API-key credentials only once per request', async () => {
    const app = createApp();
    const env = createEnv() as Env & { __verifyApiKeyCallCount: number };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: 'Bearer sfk_project-key.any-secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(env.__verifyApiKeyCallCount).toBe(1);
  });

  it('passes resolved table config to public-read route durable-object calls', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown> }>;
      __projectRequests: string[];
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: 'Bearer sfk_project-key.any-secret'
        }
      },
      env
    );

    expect(response.status).toBe(200);
    expect(env.__tableRequests).toContainEqual({
      type: 'table.rows.list',
      resolvedConfig: expect.objectContaining({
        projectSlug: 'demo',
        tableSlug: 'users',
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'default'
      })
    });
    expect(env.__projectRequests).toContain('project.table.resolve');
    expect(env.__projectRequests).not.toContain('project.get');
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
    expect(document.paths['/v1/projects/{project}/tables/{table}/rows']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/tables/{table}/cache']).toBeDefined();
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
