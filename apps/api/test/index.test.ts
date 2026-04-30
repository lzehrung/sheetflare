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

function createEnv(options?: {
  rateLimitAllowed?: boolean;
  defaultAuthMode?: 'private' | 'public-read';
  projectAccessStatus?: 200 | 404 | 500;
}): Env {
  const rateLimitRequests: Array<{ name: string; key: string }> = [];
  const projectRequests: string[] = [];
  const tableRequests: Array<{ type: string; resolvedConfig?: Record<string, unknown>; requestContext?: Record<string, unknown> }> = [];
  const controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> = [];
  let verifyApiKeyCallCount = 0;
  let apiKeyTouchCallCount = 0;
  const controlPlane = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as { type: string; apiKeyId?: string; hash?: string; projectSlug?: string | null };
    controlPlaneRequests.push({
      type: body.type,
      body
    });

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
              : body.apiKeyId === 'touch-key'
                ? {
                    id: 'touch-key',
                    projectSlug: 'demo',
                    name: 'Touch key',
                    scopes: ['table:read'],
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
      apiKeyTouchCallCount += 1;
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
            : body.apiKeyId === 'touch-key'
              ? {
                  id: 'touch-key',
                  projectSlug: 'demo',
                  name: 'Touch key',
                  scopes: ['table:read'],
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

    if (body.type === 'control.spreadsheet-watches.register') {
      return Response.json({
        type: 'control.spreadsheet-watches.register.result',
        result: {
          data: [
            {
              spreadsheetId: 'sheet-1',
              googleCredentialRef: 'default',
              channelId: 'channel-1',
              resourceId: 'resource-1',
              resourceUri: 'https://www.googleapis.com/drive/v3/files/sheet-1',
              expirationAt: '2026-05-03T00:00:00.000Z',
              lastNotificationAt: null,
              pendingChangedAt: null,
              debounceUntil: null,
              lastReindexStartedAt: null,
              lastReindexCompletedAt: null,
              lastReindexError: null,
              projectSlugs: ['demo']
            }
          ]
        }
      });
    }

    if (body.type === 'control.spreadsheet-watch.notify') {
      return Response.json({
        type: 'control.spreadsheet-watch.notify.result',
        result: {
          accepted: true,
          spreadsheetId: 'sheet-1',
          debounceUntil: '2026-04-26T00:00:30.000Z'
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
            googleCredentialRef: 'default',
            tableCount: 2,
            updatedAt: '2026-04-26T00:00:00.000Z'
          }
        ]
      }
    });
  });

  const project = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as {
      type: string;
      tab?: string;
      headerRow?: number;
      allowExisting?: boolean;
      input?: {
        slug?: string;
        tableSlug?: string;
      };
    };
    projectRequests.push(body.type);
    const requestUrl = new URL(request.url);
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

    if (body.type === 'project.create') {
      if (body.input?.slug === 'demo' && body.allowExisting !== true && requestUrl.searchParams.get('upsert') !== 'true') {
        return Response.json({
          error: {
            code: 'CONFLICT',
            message: 'Project demo already exists.',
            details: {
              projectSlug: 'demo'
            }
          }
        }, { status: 409 });
      }

      return Response.json({
        type: 'project.create.result',
        result: {
          created: !(body.allowExisting === true && body.input?.slug === 'demo'),
          data: {
            project: {
              slug: body.input?.slug ?? 'demo',
              name: 'Demo',
              spreadsheetId: 'sheet-1',
              googleCredentialRef: 'default',
              createdAt: '2026-04-26T00:00:00.000Z',
              updatedAt: '2026-04-26T00:00:00.000Z',
              defaultAuthMode: options?.defaultAuthMode ?? 'private'
            },
            tables: [table]
          }
        }
      });
    }

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
            defaultAuthMode: options?.defaultAuthMode ?? 'private'
          },
          tables: [table]
        }
      });
    }

    if (body.type === 'project.access.get') {
      if (options?.projectAccessStatus === 404) {
        return Response.json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Project demo was not found.',
              details: null
            }
          },
          { status: 404 }
        );
      }

      if (options?.projectAccessStatus === 500) {
        return new Response('project access failed', { status: 500 });
      }

      return Response.json({
        type: 'project.access.get.result',
        result: {
          data: {
            slug: 'demo',
            defaultAuthMode: options?.defaultAuthMode ?? 'private'
          }
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
              defaultAuthMode: options?.defaultAuthMode ?? 'private'
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

    if (body.type === 'project.spreadsheet.tabs.list') {
      return Response.json({
        type: 'project.spreadsheet.tabs.list.result',
        result: {
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
        }
      });
    }

    if (body.type === 'project.spreadsheet.tab.inspect') {
      return Response.json({
        type: 'project.spreadsheet.tab.inspect.result',
        result: {
          data: {
            tab: {
              title: body.tab ?? 'Users',
              sheetGid: 11
            },
            headerRow: body.headerRow ?? 1,
            headers: ['_id', 'email', 'status']
          }
        }
      });
    }

    if (body.type === 'project.table.create') {
      if (body.input?.tableSlug === 'users' && body.allowExisting !== true && requestUrl.searchParams.get('upsert') !== 'true') {
        return Response.json({
          error: {
            code: 'CONFLICT',
            message: 'Table demo/users already exists.',
            details: {
              projectSlug: 'demo',
              tableSlug: 'users'
            }
          }
        }, { status: 409 });
      }

      return Response.json({
        type: 'project.table.create.result',
        result: {
          created: !(body.allowExisting === true && body.input?.tableSlug === 'users'),
          data: table
        }
      });
    }

    return Response.json({
      type: 'project.table.list.result',
      result: {
        data: [table]
      }
    });
  });

  const table = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as {
      type: string;
      input?: { values?: Record<string, unknown> };
      query?: unknown;
      resolvedConfig?: Record<string, unknown>;
      requestContext?: Record<string, unknown>;
    };
    tableRequests.push({
      type: body.type,
      resolvedConfig: body.resolvedConfig,
      requestContext: body.requestContext
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
            lastSyncError: null,
            validation: {
              status: 'ok',
              issueCount: 0,
              issues: []
            },
            externalChange: {
              pending: false,
              lastChangedAt: null,
              debounceUntil: null,
              lastAutoReindexAt: null
            }
          }
        }
      });
    }

    if (body.type === 'table.cache.refresh') {
      return Response.json({
        type: 'table.cache.refresh.result',
        result: {
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
              issues: []
            },
            externalChange: {
              pending: false,
              lastChangedAt: null,
              debounceUntil: null,
              lastAutoReindexAt: null
            }
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
    GOOGLE_DRIVE_WEBHOOK_SECRET: 'drive-secret',
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
  Object.defineProperty(env, '__controlPlaneRequests', {
    value: controlPlaneRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__verifyApiKeyCallCount', {
    get: () => verifyApiKeyCallCount,
    enumerable: false
  });
  Object.defineProperty(env, '__apiKeyTouchCallCount', {
    get: () => apiKeyTouchCallCount,
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
          googleCredentialRef: 'default',
          tableCount: 2,
          updatedAt: '2026-04-26T00:00:00.000Z'
        }
      ]
    });
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

  it('accepts verified Google Drive webhook notifications without edge rate limiting', async () => {
    const app = createApp();
    const env = createEnv() as Env & {
      __controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }>;
      __rateLimitRequests: Array<{ name: string; key: string }>;
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
    expect(env.__controlPlaneRequests.at(-1)).toMatchObject({
      type: 'control.spreadsheet-watch.notify',
      body: {
        channelId: 'channel-1',
        resourceId: 'resource-1',
        resourceState: 'update'
      }
    });
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

  it('allows explicit project upserts for idempotent automation', async () => {
    const app = createApp();
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
      createEnv()
    );

    expect(response.status).toBe(200);
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

  it('returns 200 for explicit table upserts that replace existing config', async () => {
    const app = createApp();
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
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: expect.objectContaining({
        projectSlug: 'demo',
        tableSlug: 'users'
      })
    });
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
      notes: [
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
          authorization: 'Bearer sfk_project-admin-key.any-secret'
        }
      },
      createEnv()
    );

    expect(response.status).toBe(401);
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
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"rateLimitOperationKey":"rows.create"'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"rateLimitPrincipal":"api-key:project-key"'));
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
    expect(env.__projectRequests).toContain('project.access.get');
    expect(env.__projectRequests).not.toContain('project.table.resolve');
  });

  it('preserves internal project access failures instead of rewriting them as unauthorized', async () => {
    const app = createApp();
    const response = await app.request('/v1/projects/demo/tables/users/rows', {}, createEnv({
      projectAccessStatus: 500
    }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Durable Object RPC failed with 500.',
        details: null
      }
    });
  });

  it('allows anonymous reads for public-read projects and still resolves the table', async () => {
    const app = createApp();
    const env = createEnv({ defaultAuthMode: 'public-read' }) as Env & {
      __projectRequests: string[];
      __tableRequests: Array<{ type: string; requestContext?: Record<string, unknown> }>;
    };

    const response = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {},
      env
    );

    expect(response.status).toBe(200);
    expect(env.__projectRequests).toContain('project.access.get');
    expect(env.__projectRequests).toContain('project.table.resolve');
    expect(env.__tableRequests[0]).toMatchObject({
      type: 'table.rows.list',
      requestContext: {
        route: 'rows.list',
        principal: 'anonymous'
      }
    });
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
        lastSyncError: null,
        validation: {
          status: 'ok',
          issueCount: 0,
          issues: []
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
          issues: []
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
      { name: 'rate-limit:admin:bootstrap-admin', key: 'admin.projects.list' },
      { name: 'rate-limit:data:api-key:project-key', key: 'rows.list' }
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
      { name: 'rate-limit:admin:client:anonymous', key: 'admin.projects.list' }
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
          authorization: 'Bearer sfk_project-key.any-secret'
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
          authorization: 'Bearer sfk_touch-key.any-secret'
        }
      },
      env
    );
    const second = await app.request(
      '/v1/projects/demo/tables/users/rows',
      {
        headers: {
          authorization: 'Bearer sfk_touch-key.any-secret'
        }
      },
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(env.__apiKeyTouchCallCount).toBe(1);
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
    expect(env.__tableRequests[0]).toMatchObject({
      type: 'table.rows.list',
      resolvedConfig: {
        projectSlug: 'demo',
        tableSlug: 'users',
        spreadsheetId: 'sheet-1',
        googleCredentialRef: 'default'
      }
    });
    expect(env.__tableRequests[0]).toMatchObject({
      requestContext: {
        route: 'rows.list',
        principal: 'api-key:project-key'
      }
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
    expect(document.paths['/v1/admin/projects/{project}/spreadsheet/tabs']).toBeDefined();
    expect(document.paths['/v1/admin/projects/{project}/spreadsheet/tabs/{tab}']).toBeDefined();
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
