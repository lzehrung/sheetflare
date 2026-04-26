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

function createEnv(): Env {
  const registry = new FakeDurableObjectNamespace(() => async () =>
    Response.json({
      type: 'registry.projects.list.result',
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
    })
  );

  const project = new FakeDurableObjectNamespace((name) => async () => {
    if (name === 'project:demo') {
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
          tables: []
        }
      });
    }

    return Response.json({
      type: 'project.table.create.result',
      result: {
        data: {
          projectSlug: 'demo',
          tableSlug: 'users',
          sheetTabName: 'Users',
          idColumn: '_id',
          headerRow: 1,
          dataStartRow: 2,
          readEnabled: true,
          createEnabled: true,
          updateEnabled: true,
          deleteEnabled: true,
          cacheTtlSeconds: 15,
          createdAt: '2026-04-26T00:00:00.000Z',
          updatedAt: '2026-04-26T00:00:00.000Z'
        }
      }
    });
  });

  const table = new FakeDurableObjectNamespace(() => async (request) => {
    const body = (await request.json()) as { type: string; input?: { values?: Record<string, unknown> } };

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

    return Response.json({
      type: 'table.rows.list.result',
      result: {
        data: [],
        nextCursor: null
      }
    });
  });

  return {
    REGISTRY_DO: registry as never,
    PROJECT_DO: project as never,
    TABLE_DO: table as never,
    RATE_LIMIT_DO: table as never,
    GOOGLE_CLIENT_EMAIL: 'service@example.com',
    GOOGLE_PRIVATE_KEY: 'private-key',
    ADMIN_BEARER_TOKEN: 'secret'
  };
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

  it('creates rows against the table durable object', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
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
  });
});
