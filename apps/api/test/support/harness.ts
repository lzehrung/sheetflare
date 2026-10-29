import { expect } from 'vitest';
import type { ZodType } from 'zod';
import {
  controlPlaneDoRequestSchema,
  projectDoRequestSchema,
  rateLimitDoRequestSchema,
  resolvedTableConfigSnapshotSchema,
  tableDoRequestSchema,
  toErrorResponse,
  type ControlPlaneDoResponse,
  type TableDoResponse
} from '@sheetflare/contracts';
import type { Env } from '../../src/env';
import { CachedTableReads, type CachePurgeTarget, type CachedTableReadProps } from '../../src/index';
import { exports as workerExports } from './cloudflare-workers';
import type { WorkersCacheEmulator } from './workers-cache';
import { apiKeyFixtures } from './api-keys';

export type FakeDurableObjectRequest = {
  /** Durable Object instance name, for example `rate-limit:data:client:anonymous`. */
  name: string;
  body: Record<string, unknown>;
};

/**
 * Runs before a fake Durable Object's built-in answer. Return a Response to replace that answer, return nothing to
 * fall through to it, or throw to simulate the stub call itself failing.
 */
export type FakeDurableObjectHook = (
  request: FakeDurableObjectRequest
) => Response | undefined | Promise<Response | undefined>;

type StubHandler = (request: Request) => Response | Promise<Response>;

/**
 * Answers like a Durable Object's RPC boundary does for a payload the shared schema rejects, so a gateway that builds
 * a bad payload sees the same 400 it would see in production.
 */
function rejectInvalidRpc(schema: ZodType, body: unknown) {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return undefined;
  }

  const { status, body: errorBody } = toErrorResponse(parsed.error);
  return Response.json(errorBody, { status });
}

function notFoundResponse(message: string) {
  return Response.json({ error: { code: 'NOT_FOUND', message, details: null } }, { status: 404 });
}

export type CachedReadRequestRecord = {
  url: string;
  method: string;
  authorization: string | null;
  cacheKey: string | null;
};

export type TableRequestRecord = {
  type: string;
  resolvedConfig?: Record<string, unknown> | undefined;
  requestContext?: Record<string, unknown> | undefined;
};

const resolvedTableConfigSnapshot = resolvedTableConfigSnapshotSchema.parse({
  projectSlug: 'demo',
  tableSlug: 'users',
  sheetTabName: 'Users',
  idColumn: '_id',
  indexedFields: ['_id'],
  readOnlyFields: [],
  fieldRules: {},
  headerRow: 1,
  dataStartRow: 2,
  readEnabled: true,
  createEnabled: true,
  updateEnabled: true,
  deleteEnabled: true,
  cacheTtlSeconds: 15,
  createdAt: '2026-04-26T00:00:00.000Z',
  updatedAt: '2026-04-26T00:00:00.000Z',
  spreadsheetId: 'sheet-1',
  googleCredentialRef: 'default'
});

/**
 * When the canned TableDO last completed a sync. Edge freshness counts from here, so a test that asserts an exact
 * `max-age` freezes the clock at this instant (or a known distance after it).
 */
export const cannedTableSyncCompletedAt = '2026-04-26T00:00:01.000Z';

export const defaultCachedTableReadProps: CachedTableReadProps = {
  resolvedConfig: resolvedTableConfigSnapshot,
  dataGeneration: 0
};

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

/** Everything a fake environment observed, without reaching through hidden properties on `Env`. */
export type EnvProbes = {
  rateLimitRequests: Array<{ name: string; key: string }>;
  projectRequests: string[];
  tableRequests: TableRequestRecord[];
  controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }>;
  durableObjectRequests: string[];
  cachedReadRequests: CachedReadRequestRecord[];
  /** The `ctx.props` of every cached-read invocation, in order. */
  cachedReadProps: CachedTableReadProps[];
  cachedReadPurgeCalls: CachePurgeCall[];
  readonly verifyApiKeyCallCount: number;
  readonly apiKeyTouchCallCount: number;
  /** Makes the fake control plane stop verifying this key, as `control.api-key.revoke` would. */
  revokeApiKey(apiKeyId: string): void;
};

const probeRegistry = new WeakMap<Env, EnvProbes>();

export function probesOf(env: Env): EnvProbes {
  const probes = probeRegistry.get(env);
  if (!probes) {
    throw new Error('Expected an environment created by createEnv().');
  }
  return probes;
}

export type UnexpectedTableResponseRequest =
  | 'table.cache.refresh'
  | 'table.reindex'
  | 'table.row.create'
  | 'table.row.update'
  | 'table.row.delete';

export function createEnv(options?: {
  rateLimitAllowed?: boolean;
  defaultAuthMode?: 'private' | 'public-read';
  tableCacheClearStatus?: 200 | 503;
  tableCacheGetUnexpectedResponse?: boolean;
  tableUnexpectedResponseFor?: UnexpectedTableResponseRequest;
  controlSpreadsheetWatchNotifyUnexpectedResponse?: boolean;
  tableRowsListStatus?: 200 | 503;
  tableCacheTtlSeconds?: number;
  tableCacheStatus?: 'idle' | 'syncing' | 'ready' | 'error';
  tableCacheStale?: boolean;
  tableCacheStaleReason?: 'fresh' | 'never-synced' | 'ttl-expired' | 'config-changed' | 'external-change' | 'error';
  tableExternalChangeDebounceUntil?: string | null;
  googleClientEmail?: string;
  googlePrivateKey?: string;
  googleCredentialsJson?: string;
  adminBearerToken?: string;
  googleDriveWebhookSecret?: string;
  allowedOrigins?: string;
  cachedReadPurgeShouldFail?: boolean;
  cachedReadResponseHeaders?: Record<string, string>;
  /**
   * Puts an emulated Workers Cache in front of the cached-read entrypoint and routes its purge calls to the emulated
   * purge API, instead of invoking the entrypoint on every read and accepting every purge.
   */
  workersCache?: WorkersCacheEmulator;
  /** Counts rate-limit checks per Durable Object name and key like the real fixed window instead of answering from a script. */
  rateLimitFixedWindow?: boolean;
  /** Replaces the body of every response from the cached-read entrypoint, as a Workers Cache hit would. */
  cachedReadResponseBody?: string;
  hooks?: {
    controlPlane?: FakeDurableObjectHook;
    project?: FakeDurableObjectHook;
    table?: FakeDurableObjectHook;
    rateLimit?: FakeDurableObjectHook;
  };
}): Env {
  const rateLimitRequests: Array<{ name: string; key: string }> = [];
  const projectRequests: string[] = [];
  const tableRequests: TableRequestRecord[] = [];
  const controlPlaneRequests: Array<{ type: string; body: Record<string, unknown> }> = [];
  const durableObjectRequests: string[] = [];
  const cachedReadRequests: CachedReadRequestRecord[] = [];
  const cachedReadProps: CachedTableReadProps[] = [];
  const cachedReadPurgeCalls: CachePurgeCall[] = [];
  let verifyApiKeyCallCount = 0;
  let apiKeyTouchCallCount = 0;
  const revokedApiKeyIds = new Set<string>();
  const rateLimitCounters = new Map<string, number>();
  const controlPlane = new FakeDurableObjectNamespace((name) => async (request) => {
    const body = (await request.json()) as { type: string; apiKeyId?: string; hash?: string; projectSlug?: string | null };
    controlPlaneRequests.push({
      type: body.type,
      body
    });
    const invalidRequest = rejectInvalidRpc(controlPlaneDoRequestSchema, body);
    if (invalidRequest) {
      return invalidRequest;
    }
    const hookResponse = await options?.hooks?.controlPlane?.({ name, body });
    if (hookResponse) {
      return hookResponse;
    }

    if (body.type === 'control.api-key.verify') {
      verifyApiKeyCallCount += 1;
      const fixture = apiKeyFixtures.find((candidate) => candidate.id === body.apiKeyId);
      const verified = fixture !== undefined && !revokedApiKeyIds.has(fixture.id) && fixture.hash === body.hash;
      return Response.json({
        type: 'control.api-key.verify.result',
        result: {
          record: verified ? fixture.record : null
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

    if (body.type === 'control.api-key.revoke') {
      if (body.apiKeyId) {
        revokedApiKeyIds.add(body.apiKeyId);
      }
      return Response.json({
        type: 'control.api-key.revoke.result',
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
          record: apiKeyFixtures.find((candidate) => candidate.id === body.apiKeyId)?.record ?? null
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
        }
      });
    }

    if (body.type === 'control.spreadsheet-watches.list') {
      return Response.json({
        type: 'control.spreadsheet-watches.list.result',
        result: {
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
        }
      });
    }

    if (body.type === 'control.spreadsheet-watches.retry-advice.list') {
      return Response.json({
        type: 'control.spreadsheet-watches.retry-advice.list.result',
        result: {
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
        }
      });
    }

    if (body.type === 'control.spreadsheet-watches.stop') {
      return Response.json({
        type: 'control.spreadsheet-watches.stop.result',
        result: {
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
        }
      });
    }

    if (body.type === 'control.spreadsheet-watch.notify' && options?.controlSpreadsheetWatchNotifyUnexpectedResponse === true) {
      const response = {
        type: 'control.project.upsert.result',
        result: { ok: true }
      } satisfies ControlPlaneDoResponse;
      return Response.json(response);
    }

    if (body.type === 'control.spreadsheet-watch.notify') {
      const response = {
        type: 'control.spreadsheet-watch.notify.result',
        result: {
          accepted: true,
          spreadsheetId: 'sheet-1',
          debounceUntil: '2026-04-26T00:00:30.000Z',
          changed: true,
          projectSlugs: ['demo']
        }
      } satisfies ControlPlaneDoResponse;
      return Response.json(response);
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

  const project = new FakeDurableObjectNamespace((name) => async (request) => {
    const body = (await request.json()) as {
      type: string;
      projectSlug?: string;
      tableSlug?: string;
      tab?: string;
      headerRow?: number;
      allowExisting?: boolean;
      input?: {
        slug?: string;
        tableSlug?: string;
      };
    };
    projectRequests.push(body.type);
    durableObjectRequests.push(body.type);
    const invalidRequest = rejectInvalidRpc(projectDoRequestSchema, body);
    if (invalidRequest) {
      return invalidRequest;
    }
    const hookResponse = await options?.hooks?.project?.({ name, body });
    if (hookResponse) {
      return hookResponse;
    }
    const requestUrl = new URL(request.url);
    const table = {
      projectSlug: 'demo',
      tableSlug: 'users',
      sheetTabName: 'Users',
      idColumn: '_id',
      indexedFields: ['_id'],
      readOnlyFields: [],
      fieldRules: {},
      headerRow: 1,
      dataStartRow: 2,
      readEnabled: true,
      createEnabled: true,
      updateEnabled: true,
      deleteEnabled: true,
      cacheTtlSeconds: options?.tableCacheTtlSeconds ?? 15,
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z'
    };
    const resolvedConfig = {
      ...resolvedTableConfigSnapshot,
      cacheTtlSeconds: table.cacheTtlSeconds
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

    if (body.type === 'project.table.resolve') {
      if (body.projectSlug !== 'demo' && body.projectSlug !== 'other') {
        return notFoundResponse(`Project ${body.projectSlug} was not found.`);
      }

      if (body.tableSlug !== 'users') {
        return notFoundResponse(`Table demo/${body.tableSlug} was not found.`);
      }

      return Response.json({
        type: 'project.table.resolve.result',
        result: {
          data: {
            project: {
              slug: body.projectSlug,
              spreadsheetId: 'sheet-1',
              googleCredentialRef: 'default',
              defaultAuthMode: body.projectSlug === 'demo' ? options?.defaultAuthMode ?? 'private' : 'private'
            },
            table,
            resolvedConfig
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

    if (body.type === 'project.table.delete') {
      return Response.json({
        type: 'project.table.delete.result',
        result: {
          ok: true,
          deletedTable: body.tableSlug ?? 'users'
        }
      });
    }

    if (body.type === 'project.delete') {
      return Response.json({
        type: 'project.delete.result',
        result: {
          ok: true,
          deletedProject: body.projectSlug ?? 'demo',
          deletedTables: body.projectSlug === 'missing-project' ? [] : ['users']
        }
      });
    }

    if (body.type === 'project.table.list') {
      if (body.projectSlug === 'missing-project') {
        return Response.json({
          error: {
            code: 'NOT_FOUND',
            message: 'Project missing-project was not found.',
            details: {
              projectSlug: 'missing-project'
            }
          }
        }, { status: 404 });
      }

      return Response.json({
        type: 'project.table.list.result',
        result: {
          data: [table]
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

  const table = new FakeDurableObjectNamespace((name) => async (request) => {
    const body = (await request.json()) as {
      type: string;
      input?: { values?: Record<string, unknown> };
      query?: unknown;
      resolvedConfig?: Record<string, unknown>;
      requestContext?: Record<string, unknown>;
      rowId?: string;
    };
    tableRequests.push({
      type: body.type,
      resolvedConfig: body.resolvedConfig,
      requestContext: body.requestContext
    });
    durableObjectRequests.push(body.type);
    const invalidRequest = rejectInvalidRpc(tableDoRequestSchema, body);
    if (invalidRequest) {
      return invalidRequest;
    }
    const hookResponse = await options?.hooks?.table?.({ name, body });
    if (hookResponse) {
      return hookResponse;
    }
    if (options?.tableUnexpectedResponseFor === body.type) {
      const response = {
        type: 'table.cache.clear.result',
        result: { ok: true }
      } satisfies TableDoResponse;
      return Response.json(response);
    }


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

    if (body.type === 'table.row.update') {
      return Response.json({
        type: 'table.row.update.result',
        result: {
          data: {
            id: body.rowId ?? 'row-1',
            rowNumber: 2,
            values: body.input?.values ?? {}
          },
          ignoredKeys: []
        }
      });
    }

    if (body.type === 'table.row.delete') {
      return Response.json({
        type: 'table.row.delete.result',
        result: {
          ok: true,
          deletedId: body.rowId ?? 'row-1'
        }
      });
    }

    if (body.type === 'table.generation.get') {
      const response = {
        type: 'table.generation.get.result',
        result: {
          dataGeneration: 0,
          lastSyncCompletedAt: cannedTableSyncCompletedAt,
          cacheTtlSeconds: options?.tableCacheTtlSeconds ?? 15
        }
      } satisfies TableDoResponse;
      return Response.json(response);
    }

    if (body.type === 'table.cache.get') {
      if (options?.tableCacheGetUnexpectedResponse) {
        const response = {
          type: 'table.cache.clear.result',
          result: { ok: true }
        } satisfies TableDoResponse;
        return Response.json(response);
      }

      // TableDO.getStaleReason reports a pending external change as stale with reason `external-change`, so a
      // cache that is fresh while a change is pending cannot exist.
      const externalChangePending = options?.tableExternalChangeDebounceUntil !== undefined;
      const stale = externalChangePending || (options?.tableCacheStale ?? false);
      const defaultStaleReason = stale ? 'ttl-expired' : 'fresh';
      return Response.json({
        type: 'table.cache.get.result',
        result: {
          data: {
            status: options?.tableCacheStatus ?? 'ready',
            cacheTtlSeconds: options?.tableCacheTtlSeconds ?? 15,
            stale,
            staleReason: externalChangePending ? 'external-change' : (options?.tableCacheStaleReason ?? defaultStaleReason),
            rowCount: 2,
            lastSyncStartedAt: '2026-04-26T00:00:00.000Z',
            lastSyncCompletedAt: cannedTableSyncCompletedAt,
            dataGeneration: 0,
            lastSyncError: null,
            validation: {
              status: 'ok',
              issueCount: 0,
              issues: [],
              validatedAt: '2026-04-26T00:00:02.000Z'
            },
            externalChange: {
              pending: options?.tableExternalChangeDebounceUntil !== undefined,
              lastChangedAt: options?.tableExternalChangeDebounceUntil === undefined ? null : '2026-04-26T00:00:00.000Z',
              debounceUntil: options?.tableExternalChangeDebounceUntil ?? null,
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
            dataGeneration: 0,
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
        }
      });
    }

    if (body.type === 'table.reindex') {
      return Response.json({
        type: 'table.reindex.result',
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
            dataGeneration: 0,
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
        }
      });
    }

    if (body.type === 'table.cache.clear') {
      if (options?.tableCacheClearStatus === 503) {
        return Response.json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Cache clear unavailable.',
            details: null
          }
        }, { status: 503 });
      }

      return Response.json({
        type: 'table.cache.clear.result',
        result: {
          ok: true
        }
      });
    }

    if (body.type === 'table.rows.list') {
      if (options?.tableRowsListStatus === 503) {
        return Response.json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Cached rows are temporarily unavailable.',
            details: null
          }
        }, { status: 503 });
      }

      return Response.json({
        type: 'table.rows.list.result',
        result: {
          data: body.query ? [{ id: 'row-1', rowNumber: 2, values: { matched: true } }] : [],
          nextCursor: null
        }
      });
    }

    if (body.type === 'table.schema.get') {
      return Response.json({
        type: 'table.schema.get.result',
        result: {
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
    const body = (await request.json()) as { key: string; limit: number; windowSeconds: number };
    rateLimitRequests.push({ name, key: body.key });
    const invalidRequest = rejectInvalidRpc(rateLimitDoRequestSchema, body);
    if (invalidRequest) {
      return invalidRequest;
    }
    const hookResponse = await options?.hooks?.rateLimit?.({ name, body });
    if (hookResponse) {
      return hookResponse;
    }

    if (options?.rateLimitFixedWindow === true) {
      const windowMs = body.windowSeconds * 1000;
      const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs;
      const bucket = `${name}:${body.key}:${windowStartMs}`;
      const used = rateLimitCounters.get(bucket) ?? 0;
      const resetAtMs = windowStartMs + windowMs;
      if (used >= body.limit) {
        return Response.json({ type: 'rate-limit.check.result', result: { allowed: false, remaining: 0, resetAtMs } });
      }
      rateLimitCounters.set(bucket, used + 1);
      return Response.json({
        type: 'rate-limit.check.result',
        result: { allowed: true, remaining: body.limit - used - 1, resetAtMs }
      });
    }

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
    GOOGLE_CLIENT_EMAIL: options?.googleClientEmail ?? 'service@example.com',
    GOOGLE_PRIVATE_KEY: options?.googlePrivateKey ?? 'private-key',
    ...(options?.googleCredentialsJson === undefined ? {} : { GOOGLE_CREDENTIALS_JSON: options.googleCredentialsJson }),
    GOOGLE_DRIVE_WEBHOOK_SECRET: options?.googleDriveWebhookSecret ?? 'drive-secret',
    ADMIN_BEARER_TOKEN: options?.adminBearerToken ?? 'secret',
    RATE_LIMIT_MAX_REQUESTS: '300',
    RATE_LIMIT_WINDOW_SECONDS: '60',
    ...(options?.allowedOrigins === undefined ? {} : { SHEETFLARE_ALLOWED_ORIGINS: options.allowedOrigins })
  };

  const fetchCachedTableRead = async (
    props: CachedTableReadProps,
    request: Request,
    init?: Parameters<typeof workerExports.CachedTableReads.fetch>[1]
  ) => {
    cachedReadProps.push(props);
    cachedReadRequests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      cacheKey: init?.cf?.cacheKey ?? null
    });
    const runEntrypoint = () => createCachedTableReadsHarness(env, {
      props,
      purgeCalls: cachedReadPurgeCalls,
      purgeShouldFail: options?.cachedReadPurgeShouldFail ?? false,
      workersCache: options?.workersCache
    }).entrypoint.fetch(request);
    const entrypointResponse = options?.workersCache === undefined
      ? await runEntrypoint()
      : await options.workersCache.fetch({ props, cacheKey: init?.cf?.cacheKey ?? null, request, run: runEntrypoint });
    const response = options?.cachedReadResponseBody === undefined
      ? entrypointResponse
      : new Response(options.cachedReadResponseBody, {
          status: entrypointResponse.status,
          headers: entrypointResponse.headers
        });
    for (const [name, value] of Object.entries(options?.cachedReadResponseHeaders ?? {})) {
      response.headers.set(name, value);
    }
    return response;
  };
  workerExports.CachedTableReads = Object.assign(
    ({ props }: { props: CachedTableReadProps }) => ({
      fetch: (request: Request, init?: Parameters<typeof workerExports.CachedTableReads.fetch>[1]) =>
        fetchCachedTableRead(props, request, init)
    }),
    {
      fetch: (request: Request, init?: Parameters<typeof workerExports.CachedTableReads.fetch>[1]) =>
        fetchCachedTableRead(defaultCachedTableReadProps, request, init),
      async purge(targets: readonly CachePurgeTarget[]) {
        await createCachedTableReadsHarness(env, {
          purgeCalls: cachedReadPurgeCalls,
          purgeShouldFail: options?.cachedReadPurgeShouldFail ?? false,
          workersCache: options?.workersCache
        }).entrypoint.purge(targets);
      }
    }
  );

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
  Object.defineProperty(env, '__durableObjectRequests', {
    value: durableObjectRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__cachedReadRequests', {
    value: cachedReadRequests,
    enumerable: false
  });
  Object.defineProperty(env, '__cachedReadPurgeCalls', {
    value: cachedReadPurgeCalls,
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

  probeRegistry.set(env, {
    rateLimitRequests,
    projectRequests,
    tableRequests,
    controlPlaneRequests,
    durableObjectRequests,
    cachedReadRequests,
    cachedReadProps,
    cachedReadPurgeCalls,
    get verifyApiKeyCallCount() {
      return verifyApiKeyCallCount;
    },
    get apiKeyTouchCallCount() {
      return apiKeyTouchCallCount;
    },
    revokeApiKey(apiKeyId) {
      revokedApiKeyIds.add(apiKeyId);
    }
  });

  return env;
}

export type CachePurgeCall = Parameters<CacheContext['purge']>[0];

class FakeSpan implements Span {
  get isTraced() {
    return false;
  }

  setAttribute() {}

  end() {}
}

function createTracing(): Tracing {
  return {
    Span: FakeSpan,
    enterSpan<T, A extends unknown[]>(
      _name: string,
      callback: (span: Span, ...args: A) => T,
      ...args: A
    ): T {
      return callback(new FakeSpan(), ...args);
    },
    startActiveSpan<T, A extends unknown[]>(
      _name: string,
      callback: (span: Span, ...args: A) => T,
      ...args: A
    ): T {
      return callback(new FakeSpan(), ...args);
    }
  };
}

export function createCachedTableReadsHarness(
  env: Env = createEnv(),
  options?: {
    props?: CachedTableReadProps;
    purgeCalls?: CachePurgeCall[];
    purgeShouldFail?: boolean;
    purgeResultShouldFail?: boolean;
    /** Answers purge calls like the emulated purge API (rate limit included) instead of always accepting them. */
    workersCache?: WorkersCacheEmulator | undefined;
  }
): { entrypoint: CachedTableReads; purgeCalls: CachePurgeCall[] } {
  const purgeCalls = options?.purgeCalls ?? [];
  const ctx: ExecutionContext<CachedTableReadProps> = {
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
    passThroughOnException() {},
    props: options?.props ?? defaultCachedTableReadProps,
    cache: {
      async purge(purgeOptions) {
        purgeCalls.push(purgeOptions);
        if (options?.purgeShouldFail === true) {
          throw new Error('Workers Cache purge failed for test.');
        }
        if (options?.purgeResultShouldFail === true) {
          return {
            success: false,
            errors: [
              {
                code: 1000,
                message: 'Workers Cache purge was rejected for test.'
              }
            ]
          };
        }
        if (options?.workersCache !== undefined) {
          return options.workersCache.purge(purgeOptions);
        }
        return {
          success: true,
          errors: []
        };
      }
    },
    tracing: createTracing()
  };

  return {
    entrypoint: new CachedTableReads(ctx, env),
    purgeCalls
  };
}

export function getOnlyCachedReadRequest(env: Env) {
  const { cachedReadRequests } = probesOf(env);
  expect(cachedReadRequests).toHaveLength(1);
  const [request] = cachedReadRequests;
  if (!request) {
    throw new Error('Expected one cached read request.');
  }
  return request;
}

export function requireCacheKey(record: CachedReadRequestRecord) {
  expect(record.cacheKey).toEqual(expect.any(String));
  if (record.cacheKey === null) {
    throw new Error('Expected cached read request to include cf.cacheKey.');
  }
  return record.cacheKey;
}


export function readCacheTagHeader(response: Response) {
  const value = response.headers.get('cache-tag');
  expect(value).toEqual(expect.any(String));
  if (value === null) {
    throw new Error('Expected Cache-Tag header.');
  }
  return value.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
}

export function expectCachedReadPurgeCalls(env: Env, expectedTags: string[][]) {
  expect(probesOf(env).cachedReadPurgeCalls).toEqual(
    expectedTags.map((tags) => ({
      tags
    }))
  );
}

export function expectSuccessfulCachedReadHeaders(
  response: Response,
  options: { edgeCacheControl: string; tags: string[] }
) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('cloudflare-cdn-cache-control')).toBe(options.edgeCacheControl);
  expect(readCacheTagHeader(response)).toEqual(options.tags);
}

export function expectDefaultGatewayNoStore(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
  expect(response.headers.get('cache-tag')).toBeNull();
}

export function expectCachedDataReadGatewayHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('cloudflare-cdn-cache-control')).toBeNull();
  expect(response.headers.get('cache-tag')).toBeNull();
}

export function expectNoCredentialMaterial(value: string) {
  const lowerValue = value.toLowerCase();
  expect(lowerValue).not.toContain('authorization');
  expect(lowerValue).not.toContain('bearer');
  for (const fixture of apiKeyFixtures) {
    expect(value).not.toContain(fixture.credential);
    expect(value).not.toContain(fixture.id);
    expect(value).not.toContain(fixture.secret);
  }
}
