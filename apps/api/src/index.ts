import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  adminCreateApiKeyInputSchema,
  adminCreateApiKeyResultSchema,
  adminGetProjectResultSchema,
  adminInspectSpreadsheetTabResultSchema,
  adminRegisterSpreadsheetWatchesInputSchema,
  adminRegisterSpreadsheetWatchesResultSchema,
  adminListApiKeysResultSchema,
  adminListProjectsResultSchema,
  adminListSpreadsheetTabsResultSchema,
  adminProjectParamsSchema,
  adminProjectSpreadsheetTabParamsSchema,
  adminProjectTableParamsSchema,
  apiKeyParamsSchema,
  createProjectInputSchema,
  createRowInputSchema,
  createRowResultSchema,
  createTableInputSchema,
  deleteRowResultSchema,
  getRowResultSchema,
  getSchemaResultSchema,
  getTableCacheStatusResultSchema,
  listRowsQuerySchema,
  listRowsResultSchema,
  refreshTableCacheResultSchema,
  reindexTableResultSchema,
  rowParamsSchema,
  tableConfigSchema,
  BadRequestError,
  ServiceUnavailableError,
  toErrorResponse,
  UnauthorizedError,
  updateRowInputSchema,
  updateRowResultSchema,
  type AdminCreateApiKeyResult,
  type AdminGetProjectResult,
  type AdminListApiKeysResult,
  type AdminListProjectsResult,
  type AdminInspectSpreadsheetTabResult,
  type AdminRegisterSpreadsheetWatchesInput,
  type AdminRegisterSpreadsheetWatchesResult,
  type AdminListSpreadsheetTabsResult,
  type ApiKeyPrincipal,
  type ApiScope,
  type ControlPlaneDoResponse,
  type CreateProjectInput,
  type CreateRowInput,
  type CreateTableInput,
  type CreateRowResult,
  type GetRowResult,
  type GetSchemaResult,
  type GetTableCacheStatusResult,
  type ListRowsQuery,
  type ListRowsResult,
  type ProjectAccessResult,
  type ProjectDoResponse,
  type RefreshTableCacheResult,
  type ResolvedProjectTableResult,
  type ReindexTableResult,
  type RateLimitDoResponse,
  type TableDoResponse,
  TooManyRequestsError,
  type UpdateRowInput,
  type UpdateRowResult,
  type UpsertTableResult
} from '@sheetflare/contracts';
import { ControlPlaneDO, DurableRpcError, ProjectDO, RateLimitDO, TableDO, doRpc } from '@sheetflare/cloudflare';
import type { Env } from './env';

type AppVariables = {
  requestId: string;
  authPrincipal?: string;
  verifiedApiKeyCredential?: {
    credential: string;
    record: ApiKeyPrincipal | null;
  };
  rateLimit?: {
    limit: number;
    remaining: number;
    resetAtMs: number;
  };
  rateLimitContext?: {
    principal: string;
    routeFamily: string;
    operationKey: string;
  };
};

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'bootstrap-admin' }
  | { kind: 'api-key'; record: ApiKeyPrincipal };

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string()
});

const readyResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  checks: z.object({
    controlPlane: z.literal('ok'),
    rateLimit: z.literal('ok'),
    defaultGoogleCredential: z.enum(['configured', 'missing']),
    bootstrapAdmin: z.enum(['configured', 'missing'])
  }),
  notes: z.array(z.string())
});

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().nullable()
  })
});

const listTablesResultSchema = z.object({
  data: z.array(tableConfigSchema)
});

const okResultSchema = z.object({
  ok: z.literal(true)
});

const adminProjectsQuerySchema = z.object({
  project: z.string().optional().openapi({
    param: {
      name: 'project',
      in: 'query'
    },
    example: 'demo'
  })
});

const adminUpsertQuerySchema = z.object({
  upsert: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .openapi({
      param: {
        name: 'upsert',
        in: 'query'
      },
      example: true
    })
});

const listRowsQueryOpenApiSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional().openapi({
    param: {
      name: 'limit',
      in: 'query'
    },
    example: 50
  }),
  cursor: z.string().optional().openapi({
    param: {
      name: 'cursor',
      in: 'query'
    }
  }),
  sort: z.string().optional().openapi({
    param: {
      name: 'sort',
      in: 'query'
    },
    example: 'rowNumber:asc'
  }),
  fields: z.string().optional().openapi({
    param: {
      name: 'fields',
      in: 'query'
    },
    example: 'name,email,status'
  }),
  filter: z.string().optional().openapi({
    param: {
      name: 'filter',
      in: 'query'
    },
    example: '{"status":{"eq":"active"},"score":{"gte":80}}'
  })
});

const listApiKeysQuerySchema = z.object({
  project: z.string().optional().openapi({
    param: {
      name: 'project',
      in: 'query'
    },
    example: 'demo'
  })
});

const inspectSpreadsheetTabQuerySchema = z.object({
  headerRow: z.coerce.number().int().positive().optional().openapi({
    param: {
      name: 'headerRow',
      in: 'query'
    },
    example: 1
  })
});

function jsonContent(schema: z.ZodTypeAny) {
  return {
    'application/json': {
      schema
    }
  };
}

function parseDurableRpcErrorResponse(error: DurableRpcError) {
  try {
    const parsed = JSON.parse(error.responseText) as {
      error?: {
        code?: string;
        message?: string;
        details?: unknown;
      };
    };

    if (
      parsed.error
      && typeof parsed.error.code === 'string'
      && typeof parsed.error.message === 'string'
    ) {
      return {
        status: error.status,
        body: {
          error: {
            code: parsed.error.code,
            message: parsed.error.message,
            details: parsed.error.details ?? null
          }
        }
      };
    }
  } catch {
    return null;
  }

  return null;
}

const unauthorizedResponse = {
  description: 'Unauthorized',
  content: jsonContent(errorResponseSchema)
} as const;

const badRequestResponse = {
  description: 'Bad request',
  content: jsonContent(errorResponseSchema)
} as const;

const forbiddenResponse = {
  description: 'Forbidden',
  content: jsonContent(errorResponseSchema)
} as const;

const notFoundResponse = {
  description: 'Not found',
  content: jsonContent(errorResponseSchema)
} as const;

const adminSecurity = [{ bearerAuth: [] }];
const optionalBearerSecurity = [{ bearerAuth: [] }, {}];
const apiKeyTouchIntervalMs = 5 * 60 * 1000;
const maxRecentApiKeyTouches = 10_000;
const recentApiKeyTouches = new Map<string, number>();

function getControlPlaneStub(env: Env) {
  return env.CONTROL_PLANE_DO.get(env.CONTROL_PLANE_DO.idFromName('control-plane'));
}

function getProjectStub(env: Env, projectSlug: string) {
  return env.PROJECT_DO.get(env.PROJECT_DO.idFromName(`project:${projectSlug}`));
}

function getTableStub(env: Env, projectSlug: string, tableSlug: string) {
  return env.TABLE_DO.get(env.TABLE_DO.idFromName(`table:${projectSlug}:${tableSlug}`));
}

function getRateLimitStub(env: Env, shardKey: string) {
  return env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(`rate-limit:${shardKey}`));
}

function parseApiKey(value: string) {
  if (!value.startsWith('sfk_')) {
    throw new UnauthorizedError('Invalid API key.');
  }

  const separatorIndex = value.indexOf('.');
  if (separatorIndex === -1) {
    throw new UnauthorizedError('Invalid API key.');
  }

  return {
    apiKeyId: value.slice(4, separatorIndex),
    secret: value.slice(separatorIndex + 1)
  };
}

async function verifyApiKeyCredential(env: Env, credential: string): Promise<ApiKeyPrincipal | null> {
  if (!credential.startsWith('sfk_')) {
    return null;
  }

  let parsed: ReturnType<typeof parseApiKey>;
  try {
    parsed = parseApiKey(credential);
  } catch {
    return null;
  }

  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
    type: 'control.api-key.verify',
    apiKeyId: parsed.apiKeyId,
    hash: await hashApiKeySecret(parsed.secret)
  });

  return (response as {
    type: 'control.api-key.verify.result';
    result: { record: ApiKeyPrincipal | null };
  }).result.record;
}

async function verifyApiKeyCredentialCached(c: AppContext, credential: string): Promise<ApiKeyPrincipal | null> {
  const cached = c.get('verifiedApiKeyCredential');
  if (cached?.credential === credential) {
    return cached.record;
  }

  const record = await verifyApiKeyCredential(c.env, credential);
  c.set('verifiedApiKeyCredential', {
    credential,
    record
  });
  return record;
}

function getRateLimitConfiguration(env: Env) {
  const maxRequests = Number.parseInt(env.RATE_LIMIT_MAX_REQUESTS ?? '300', 10);
  const windowSeconds = Number.parseInt(env.RATE_LIMIT_WINDOW_SECONDS ?? '60', 10);

  return {
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 300,
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60
  };
}

function getRateLimitPrincipal(c: { req: { header(name: string): string | undefined; method: string; path: string } ; env: Env }) {
  const ipAddress = c.req.header('cf-connecting-ip')?.trim();
  return ipAddress ? `client:${ipAddress}` : 'client:anonymous';
}

function getRateLimitRouteFamily(path: string) {
  if (path.startsWith('/v1/system/')) {
    return 'system';
  }

  if (path.startsWith('/v1/admin/')) {
    return 'admin';
  }

  return 'data';
}

function getRateLimitOperationKey(
  path: string,
  method: string
) {
  const normalizedMethod = method.toUpperCase();

  if (path === '/v1/admin/projects' && normalizedMethod === 'GET') {
    return 'admin.projects.list';
  }

  if (path === '/v1/admin/projects' && normalizedMethod === 'POST') {
    return 'admin.projects.upsert';
  }

  if (path === '/v1/admin/keys' && normalizedMethod === 'GET') {
    return 'admin.keys.list';
  }

  if (path === '/v1/admin/keys' && normalizedMethod === 'POST') {
    return 'admin.keys.create';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/tables') && normalizedMethod === 'GET') {
    return 'admin.tables.list';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/tables') && normalizedMethod === 'POST') {
    return 'admin.tables.upsert';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/spreadsheet/tabs') && normalizedMethod === 'GET') {
    return 'admin.spreadsheet.tabs.list';
  }

  if (/\/v1\/admin\/projects\/[^/]+\/spreadsheet\/tabs\/[^/]+$/.test(path) && normalizedMethod === 'GET') {
    return 'admin.spreadsheet.tabs.inspect';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/cache') && normalizedMethod === 'GET') {
    return 'admin.cache.get';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/refresh') && normalizedMethod === 'POST') {
    return 'admin.cache.refresh';
  }

  if (path.startsWith('/v1/admin/projects/') && path.endsWith('/reindex') && normalizedMethod === 'POST') {
    return 'admin.cache.reindex';
  }

  if (path === '/v1/admin/system/google/drive/watches/register' && normalizedMethod === 'POST') {
    return 'admin.system.drive-watches.register';
  }

  if (path === '/v1/system/google/drive/notifications' && normalizedMethod === 'POST') {
    return 'system.google.drive.notifications';
  }

  if (path.startsWith('/v1/admin/keys/') && normalizedMethod === 'DELETE') {
    return 'admin.keys.revoke';
  }

  if (path.endsWith('/schema') && normalizedMethod === 'GET') {
    return 'rows.schema.get';
  }

  if (/\/v1\/projects\/[^/]+\/tables\/[^/]+\/rows\/[^/]+$/.test(path) && normalizedMethod === 'GET') {
    return 'rows.get';
  }

  if (/\/v1\/projects\/[^/]+\/tables\/[^/]+\/rows\/[^/]+$/.test(path) && normalizedMethod === 'PATCH') {
    return 'rows.update';
  }

  if (/\/v1\/projects\/[^/]+\/tables\/[^/]+\/rows\/[^/]+$/.test(path) && normalizedMethod === 'DELETE') {
    return 'rows.delete';
  }

  if (path.endsWith('/rows') && normalizedMethod === 'GET') {
    return 'rows.list';
  }

  if (path.endsWith('/rows') && normalizedMethod === 'POST') {
    return 'rows.create';
  }

  return `${getRateLimitRouteFamily(path)}.${normalizedMethod.toLowerCase()}`;
}

async function resolveRateLimitPrincipal(c: AppContext) {
  const authorization = c.req.header('authorization');
  if (authorization?.startsWith('Bearer ')) {
    const credential = authorization.slice('Bearer '.length).trim();
    if (c.env.ADMIN_BEARER_TOKEN && credential === c.env.ADMIN_BEARER_TOKEN) {
      return 'bootstrap-admin';
    }

    const record = await verifyApiKeyCredentialCached(c, credential);
    if (record) {
      return `api-key:${record.id}`;
    }
  }

  return getRateLimitPrincipal(c);
}

async function enforceRateLimit(c: AppContext) {
  const config = getRateLimitConfiguration(c.env);
  if (config.maxRequests <= 0) {
    return;
  }

  const principal = await resolveRateLimitPrincipal(c);
  const routeFamily = getRateLimitRouteFamily(c.req.path);
  const operationKey = getRateLimitOperationKey(c.req.path, c.req.method);
  const response = await doRpc<RateLimitDoResponse>(getRateLimitStub(c.env, `${routeFamily}:${principal}`), {
    type: 'rate-limit.check',
    key: operationKey,
    limit: config.maxRequests,
    windowSeconds: config.windowSeconds
  });

  const result = (response as {
    type: 'rate-limit.check.result';
    result: { allowed: boolean; remaining: number; resetAtMs: number };
  }).result;

  c.set('rateLimit', {
    limit: config.maxRequests,
    remaining: result.remaining,
    resetAtMs: result.resetAtMs
  });
  c.set('rateLimitContext', {
    principal,
    routeFamily,
    operationKey
  });

  if (!result.allowed) {
    throw new TooManyRequestsError('Rate limit exceeded.', {
      principal,
      routeFamily,
      operationKey,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds,
      resetAt: new Date(result.resetAtMs).toISOString()
    });
  }
}

async function hashApiKeySecret(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function touchApiKeyIfNeeded(env: Env, apiKeyId: string) {
  const nowMs = Date.now();
  const lastTouchedAtMs = recentApiKeyTouches.get(apiKeyId);
  if (lastTouchedAtMs !== undefined && nowMs - lastTouchedAtMs < apiKeyTouchIntervalMs) {
    return;
  }

  if (recentApiKeyTouches.size >= maxRecentApiKeyTouches) {
    const cutoffMs = nowMs - apiKeyTouchIntervalMs;
    for (const [cachedApiKeyId, cachedTouchedAtMs] of recentApiKeyTouches) {
      if (cachedTouchedAtMs < cutoffMs) {
        recentApiKeyTouches.delete(cachedApiKeyId);
      }
    }
  }

  recentApiKeyTouches.set(apiKeyId, nowMs);
  await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
    type: 'control.api-key.touch',
    apiKeyId,
    usedAt: new Date(nowMs).toISOString()
  });
}

function getRequestPrincipal(c: AppContext) {
  return c.get('authPrincipal') ?? 'anonymous';
}

function buildTableRequestContext(c: AppContext, route: string) {
  return {
    requestId: c.get('requestId'),
    route,
    principal: getRequestPrincipal(c)
  };
}

async function authenticateRequest(c: AppContext): Promise<AuthContext> {
  const authorization = c.req.header('authorization');
  if (!authorization) {
    c.set('authPrincipal', 'anonymous');
    return { kind: 'anonymous' };
  }

  if (!authorization.startsWith('Bearer ')) {
    throw new UnauthorizedError('Unsupported authorization scheme.');
  }

  const credential = authorization.slice('Bearer '.length).trim();
  if (!credential) {
    throw new UnauthorizedError();
  }

  if (c.env.ADMIN_BEARER_TOKEN && credential === c.env.ADMIN_BEARER_TOKEN) {
    c.set('authPrincipal', 'bootstrap-admin');
    return { kind: 'bootstrap-admin' };
  }

  const record = await verifyApiKeyCredentialCached(c, credential);
  if (!record) {
    throw new UnauthorizedError('Invalid API key.');
  }

  c.set('authPrincipal', `api-key:${record.id}`);
  await touchApiKeyIfNeeded(c.env, record.id);

  return {
    kind: 'api-key',
    record
  };
}

function hasScope(record: ApiKeyPrincipal, scope: ApiScope) {
  return record.scopes.includes(scope);
}

function assertAdminScope(auth: AuthContext, scope: ApiScope) {
  if (auth.kind === 'bootstrap-admin') {
    return;
  }

  if (auth.kind !== 'api-key' || !hasScope(auth.record, scope)) {
    throw new UnauthorizedError();
  }
}

function assertGlobalAdminScope(auth: AuthContext, scope: ApiScope) {
  assertAdminScope(auth, scope);

  if (auth.kind === 'api-key' && auth.record.projectSlug) {
    throw new UnauthorizedError('This operation requires a global admin key.');
  }
}

function assertProjectScope(auth: AuthContext, scope: ApiScope, projectSlug: string) {
  if (auth.kind === 'bootstrap-admin') {
    return;
  }

  if (auth.kind !== 'api-key') {
    throw new UnauthorizedError();
  }

  if (!hasScope(auth.record, scope)) {
    throw new UnauthorizedError();
  }

  if (auth.record.projectSlug && auth.record.projectSlug !== projectSlug) {
    throw new UnauthorizedError();
  }
}

async function loadProject(c: { env: Env }, projectSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.get',
    projectSlug
  });

  return (response as { type: 'project.get.result'; result: AdminGetProjectResult }).result;
}

async function loadProjectAccess(c: { env: Env }, projectSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.access.get',
    projectSlug
  });

  return (response as {
    type: 'project.access.get.result';
    result: { data: ProjectAccessResult };
  }).result.data;
}

async function requirePublicReadProject(c: { env: Env }, projectSlug: string) {
  try {
    const projectAccess = await loadProjectAccess(c, projectSlug);
    if (projectAccess.defaultAuthMode !== 'public-read') {
      throw new UnauthorizedError();
    }
  } catch (error) {
    if (error instanceof DurableRpcError && error.status === 404) {
      throw new UnauthorizedError();
    }

    throw error;
  }
}

async function loadProjectTable(c: { env: Env }, projectSlug: string, tableSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.table.resolve',
    projectSlug,
    tableSlug
  });

  return (response as {
    type: 'project.table.resolve.result';
    result: { data: ResolvedProjectTableResult };
  }).result.data;
}

async function getApiKeyRecord(c: { env: Env }, apiKeyId: string) {
  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
    type: 'control.api-key.get',
    apiKeyId
  });

  return (response as {
    type: 'control.api-key.get.result';
    result: { record: ApiKeyPrincipal | null };
  }).result.record;
}

function parsePathParams<TSchema extends z.ZodType>(c: { req: { param(): Record<string, string> } }, schema: TSchema): z.infer<TSchema> {
  return schema.parse(c.req.param());
}

async function parseJsonBody<TSchema extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: TSchema): Promise<z.infer<TSchema>> {
  return schema.parse(await c.req.json());
}

function parseListRowsQuery(c: { req: { query(name: string): string | undefined } }): ListRowsQuery {
  const rawFilter = c.req.query('filter');
  let filter: unknown = undefined;
  if (rawFilter !== undefined) {
    try {
      filter = JSON.parse(rawFilter);
    } catch {
      throw new BadRequestError('Query parameter "filter" must be valid JSON.');
    }
  }

  return listRowsQuerySchema.parse({
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor') ?? undefined,
    sort: c.req.query('sort') ?? undefined,
    fields: c.req.query('fields')
      ?.split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
    filter
  });
}

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['System'],
  responses: {
    200: {
      description: 'Health check',
      content: jsonContent(healthResponseSchema)
    }
  }
});

const readyRoute = createRoute({
  method: 'get',
  path: '/ready',
  tags: ['System'],
  responses: {
    200: {
      description: 'Readiness check',
      content: jsonContent(readyResponseSchema)
    }
  }
});

const adminListProjectsRoute = createRoute({
  method: 'get',
  path: '/v1/admin/projects',
  tags: ['Projects'],
  security: adminSecurity,
  request: {
    query: adminProjectsQuerySchema
  },
  responses: {
    200: {
      description: 'List all projects or get one project by slug',
      content: jsonContent(z.union([adminListProjectsResultSchema, adminGetProjectResultSchema]))
    },
    401: unauthorizedResponse
  }
});

const adminCreateProjectRoute = createRoute({
  method: 'post',
  path: '/v1/admin/projects',
  tags: ['Projects'],
  security: adminSecurity,
  request: {
    query: adminUpsertQuerySchema,
    body: {
      content: jsonContent(createProjectInputSchema),
      description: 'Project definition'
    }
  },
  responses: {
    200: {
      description: 'Replaced existing project through explicit upsert',
      content: jsonContent(adminGetProjectResultSchema)
    },
    201: {
      description: 'Created project',
      content: jsonContent(adminGetProjectResultSchema)
    },
    409: {
      description: 'Project already exists. Repeat the request with upsert=true to replace it intentionally.',
      content: jsonContent(errorResponseSchema)
    },
    400: badRequestResponse,
    401: unauthorizedResponse
  }
});

const adminListSpreadsheetTabsRoute = createRoute({
  method: 'get',
  path: '/v1/admin/projects/{project}/spreadsheet/tabs',
  tags: ['Projects'],
  security: adminSecurity,
  request: {
    params: adminProjectParamsSchema
  },
  responses: {
    200: {
      description: 'List spreadsheet tabs for a project',
      content: jsonContent(adminListSpreadsheetTabsResultSchema)
    },
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const adminInspectSpreadsheetTabRoute = createRoute({
  method: 'get',
  path: '/v1/admin/projects/{project}/spreadsheet/tabs/{tab}',
  tags: ['Projects'],
  security: adminSecurity,
  request: {
    params: adminProjectSpreadsheetTabParamsSchema,
    query: inspectSpreadsheetTabQuerySchema
  },
  responses: {
    200: {
      description: 'Inspect one spreadsheet tab and read its header row',
      content: jsonContent(adminInspectSpreadsheetTabResultSchema)
    },
    400: badRequestResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const adminListTablesRoute = createRoute({
  method: 'get',
  path: '/v1/admin/projects/{project}/tables',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectParamsSchema
  },
  responses: {
    200: {
      description: 'List configured tables for a project',
      content: jsonContent(listTablesResultSchema)
    },
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const adminCreateTableRoute = createRoute({
  method: 'post',
  path: '/v1/admin/projects/{project}/tables',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectParamsSchema,
    query: adminUpsertQuerySchema,
    body: {
      content: jsonContent(createTableInputSchema),
      description: 'Table definition'
    }
  },
  responses: {
    200: {
      description: 'Replaced existing table through explicit upsert',
      content: jsonContent(z.object({ data: tableConfigSchema }))
    },
    201: {
      description: 'Created table',
      content: jsonContent(z.object({ data: tableConfigSchema }))
    },
    409: {
      description: 'Table already exists. Repeat the request with upsert=true to replace it intentionally.',
      content: jsonContent(errorResponseSchema)
    },
    400: badRequestResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const listRowsRoute = createRoute({
  method: 'get',
  path: '/v1/projects/{project}/tables/{table}/rows',
  tags: ['Rows'],
  security: optionalBearerSecurity,
  request: {
    params: adminProjectTableParamsSchema,
    query: listRowsQueryOpenApiSchema
  },
  responses: {
    200: {
      description: 'List cached rows',
      content: jsonContent(listRowsResultSchema)
    },
    400: badRequestResponse,
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const getSchemaRoute = createRoute({
  method: 'get',
  path: '/v1/projects/{project}/tables/{table}/schema',
  tags: ['Rows'],
  security: optionalBearerSecurity,
  request: {
    params: adminProjectTableParamsSchema
  },
  responses: {
    200: {
      description: 'Get inferred table schema',
      content: jsonContent(getSchemaResultSchema)
    },
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const getCacheStatusRoute = createRoute({
  method: 'get',
  path: '/v1/admin/projects/{project}/tables/{table}/cache',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectTableParamsSchema
  },
  responses: {
    200: {
      description: 'Get table cache status',
      content: jsonContent(getTableCacheStatusResultSchema)
    },
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const reindexTableRoute = createRoute({
  method: 'post',
  path: '/v1/admin/projects/{project}/tables/{table}/reindex',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectTableParamsSchema
  },
  responses: {
    200: {
      description: 'Force a full cache sync from Google Sheets',
      content: jsonContent(reindexTableResultSchema)
    },
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const refreshTableCacheRoute = createRoute({
  method: 'post',
  path: '/v1/admin/projects/{project}/tables/{table}/refresh',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectTableParamsSchema
  },
  responses: {
    200: {
      description: 'Refresh the table cache if it is stale',
      content: jsonContent(refreshTableCacheResultSchema)
    },
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const registerSpreadsheetWatchesRoute = createRoute({
  method: 'post',
  path: '/v1/admin/system/google/drive/watches/register',
  tags: ['System'],
  security: adminSecurity,
  request: {
    body: {
      content: jsonContent(adminRegisterSpreadsheetWatchesInputSchema),
      description: 'Drive watch registration options'
    }
  },
  responses: {
    200: {
      description: 'Register or renew Google Drive spreadsheet watches',
      content: jsonContent(adminRegisterSpreadsheetWatchesResultSchema)
    },
    400: badRequestResponse,
    401: unauthorizedResponse
  }
});

const googleDriveNotificationRoute = createRoute({
  method: 'post',
  path: '/v1/system/google/drive/notifications',
  tags: ['System'],
  responses: {
    204: {
      description: 'Accept a Google Drive webhook notification'
    },
    400: badRequestResponse,
    401: unauthorizedResponse
  }
});

const getRowRoute = createRoute({
  method: 'get',
  path: '/v1/projects/{project}/tables/{table}/rows/{id}',
  tags: ['Rows'],
  security: optionalBearerSecurity,
  request: {
    params: rowParamsSchema
  },
  responses: {
    200: {
      description: 'Get one row by managed ID',
      content: jsonContent(getRowResultSchema)
    },
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const createRowRoute = createRoute({
  method: 'post',
  path: '/v1/projects/{project}/tables/{table}/rows',
  tags: ['Rows'],
  security: [{ bearerAuth: [] }],
  request: {
    params: adminProjectTableParamsSchema,
    body: {
      content: jsonContent(createRowInputSchema),
      description: 'Row values'
    }
  },
  responses: {
    201: {
      description: 'Create a row',
      content: jsonContent(createRowResultSchema)
    },
    400: badRequestResponse,
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const updateRowRoute = createRoute({
  method: 'patch',
  path: '/v1/projects/{project}/tables/{table}/rows/{id}',
  tags: ['Rows'],
  security: [{ bearerAuth: [] }],
  request: {
    params: rowParamsSchema,
    body: {
      content: jsonContent(updateRowInputSchema),
      description: 'Partial row values'
    }
  },
  responses: {
    200: {
      description: 'Update a row',
      content: jsonContent(updateRowResultSchema)
    },
    400: badRequestResponse,
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const deleteRowRoute = createRoute({
  method: 'delete',
  path: '/v1/projects/{project}/tables/{table}/rows/{id}',
  tags: ['Rows'],
  security: [{ bearerAuth: [] }],
  request: {
    params: rowParamsSchema
  },
  responses: {
    200: {
      description: 'Delete a row',
      content: jsonContent(deleteRowResultSchema)
    },
    403: forbiddenResponse,
    401: unauthorizedResponse,
    404: notFoundResponse
  }
});

const listApiKeysRoute = createRoute({
  method: 'get',
  path: '/v1/admin/keys',
  tags: ['API Keys'],
  security: adminSecurity,
  request: {
    query: listApiKeysQuerySchema
  },
  responses: {
    200: {
      description: 'List API keys',
      content: jsonContent(adminListApiKeysResultSchema)
    },
    401: unauthorizedResponse
  }
});

const createApiKeyRoute = createRoute({
  method: 'post',
  path: '/v1/admin/keys',
  tags: ['API Keys'],
  security: adminSecurity,
  request: {
    body: {
      content: jsonContent(adminCreateApiKeyInputSchema),
      description: 'API key definition'
    }
  },
  responses: {
    201: {
      description: 'Create an API key',
      content: jsonContent(adminCreateApiKeyResultSchema)
    },
    400: badRequestResponse,
    401: unauthorizedResponse
  }
});

const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/keys/{id}',
  tags: ['API Keys'],
  security: adminSecurity,
  request: {
    params: apiKeyParamsSchema
  },
  responses: {
    200: {
      description: 'Revoke an API key',
      content: jsonContent(okResultSchema)
    },
    401: unauthorizedResponse
  }
});

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    c.set('requestId', crypto.randomUUID());

    await next();

    c.res.headers.set('x-request-id', c.get('requestId'));
    const rateLimit = c.get('rateLimit');
    const rateLimitContext = c.get('rateLimitContext');
    if (rateLimit) {
      c.res.headers.set('x-ratelimit-limit', String(rateLimit.limit));
      c.res.headers.set('x-ratelimit-remaining', String(rateLimit.remaining));
      c.res.headers.set('x-ratelimit-reset', new Date(rateLimit.resetAtMs).toISOString());
    }

    console.info(
      JSON.stringify({
        event: 'request.complete',
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        requestId: c.get('requestId'),
        principal: c.get('authPrincipal') ?? 'anonymous',
        rateLimitPrincipal: rateLimitContext?.principal ?? null,
        rateLimitRouteFamily: rateLimitContext?.routeFamily ?? null,
        rateLimitOperationKey: rateLimitContext?.operationKey ?? null,
        rateLimitLimit: rateLimit?.limit ?? null,
        rateLimitRemaining: rateLimit?.remaining ?? null,
        rateLimitResetAt: rateLimit ? new Date(rateLimit.resetAtMs).toISOString() : null
      })
    );
  });

  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/system/google/drive/notifications') {
      await next();
      return;
    }

    await enforceRateLimit(c);
    await next();
  });

  app.onError((error, c) => {
    const rateLimitContext = c.get('rateLimitContext');
    const rateLimit = c.get('rateLimit');
    console.error(
      JSON.stringify({
        event: 'request.error',
        method: c.req.method,
        path: c.req.path,
        requestId: c.get('requestId'),
        principal: c.get('authPrincipal') ?? 'anonymous',
        rateLimitPrincipal: rateLimitContext?.principal ?? null,
        rateLimitRouteFamily: rateLimitContext?.routeFamily ?? null,
        rateLimitOperationKey: rateLimitContext?.operationKey ?? null,
        rateLimitLimit: rateLimit?.limit ?? null,
        rateLimitRemaining: rateLimit?.remaining ?? null,
        rateLimitResetAt: rateLimit ? new Date(rateLimit.resetAtMs).toISOString() : null,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorDetails: error instanceof AppError ? error.details ?? null : null,
        errorStack: error instanceof Error ? error.stack ?? null : null
      })
    );
    const rpcErrorResponse = error instanceof DurableRpcError ? parseDurableRpcErrorResponse(error) : null;
    const { status, body } = rpcErrorResponse ?? toErrorResponse(error);
    const response = new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': c.get('requestId')
      }
    });
    if (rateLimit) {
      response.headers.set('x-ratelimit-limit', String(rateLimit.limit));
      response.headers.set('x-ratelimit-remaining', String(rateLimit.remaining));
      response.headers.set('x-ratelimit-reset', new Date(rateLimit.resetAtMs).toISOString());
    }
    return response;
  });

  app.openapi(healthRoute, (c) =>
    c.json({
      ok: true,
      service: 'sheetflare-api'
    })
  );

  app.openapi(readyRoute, async (c) => {
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.projects.list'
    });
    await doRpc<RateLimitDoResponse>(getRateLimitStub(c.env, 'ready:system'), {
      type: 'rate-limit.check',
      key: c.get('requestId'),
      limit: 1,
      windowSeconds: 1
    });

    const hasDefaultGoogleCredential = Boolean(
      c.env.GOOGLE_CLIENT_EMAIL?.trim() && c.env.GOOGLE_PRIVATE_KEY?.trim()
    );
    const hasBootstrapAdmin = Boolean(c.env.ADMIN_BEARER_TOKEN?.trim());
    const notes: string[] = [];

    if (!hasDefaultGoogleCredential) {
      notes.push('Default Google service-account credential is not configured. Project-specific credentials may still work.');
    }

    if (!hasBootstrapAdmin) {
      notes.push('Bootstrap admin bearer token is not configured. Admin access must use API keys.');
    }

    notes.push('This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.');

    return c.json({
      ok: true,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: hasDefaultGoogleCredential ? 'configured' : 'missing',
        bootstrapAdmin: hasBootstrapAdmin ? 'configured' : 'missing'
      },
      notes
    });
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key or bootstrap admin token'
  });

  app.doc('/doc', {
    openapi: '3.0.0',
    info: {
      title: 'Sheetflare API',
      version: '1.0.0',
      description: 'Self-hosted Google Sheets gateway with cached query execution on Cloudflare Durable Objects.'
    }
  });

  app.get(
    '/docs',
    Scalar({
      url: '/doc',
      pageTitle: 'Sheetflare API Docs',
      theme: 'default'
    })
  );

  app.openapi(adminListProjectsRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = adminProjectsQuerySchema.parse({
      project: c.req.query('project')
    });

    if (project) {
      assertProjectScope(auth, 'admin:projects', project);
      return c.json(await loadProject(c, project));
    }

    assertGlobalAdminScope(auth, 'admin:projects');

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.projects.list'
    });

    return c.json(
      (response as { type: 'control.projects.list.result'; result: AdminListProjectsResult }).result
    );
  });

  app.openapi(adminCreateProjectRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertGlobalAdminScope(auth, 'admin:projects');
    const { upsert } = adminUpsertQuerySchema.parse({
      upsert: c.req.query('upsert')
    });
    const input = await parseJsonBody(c, createProjectInputSchema) satisfies CreateProjectInput;
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, input.slug), {
      type: 'project.create',
      input,
      ...(upsert ? { allowExisting: true } : {})
    });

    const result = (response as {
      type: 'project.create.result';
      result: { data: AdminGetProjectResult; created: boolean };
    }).result;
    return c.json(result.data, result.created ? 201 : 200);
  });

  app.openapi(adminListSpreadsheetTabsRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = parsePathParams(c, adminProjectParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.spreadsheet.tabs.list',
      projectSlug: project
    });

    return c.json(
      (response as { type: 'project.spreadsheet.tabs.list.result'; result: AdminListSpreadsheetTabsResult }).result
    );
  });

  app.openapi(adminInspectSpreadsheetTabRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, tab } = parsePathParams(c, adminProjectSpreadsheetTabParamsSchema);
    const { headerRow } = inspectSpreadsheetTabQuerySchema.parse({
      headerRow: c.req.query('headerRow')
    });
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.spreadsheet.tab.inspect',
      projectSlug: project,
      tab,
      ...(headerRow !== undefined ? { headerRow } : {})
    });

    return c.json(
      (response as { type: 'project.spreadsheet.tab.inspect.result'; result: AdminInspectSpreadsheetTabResult }).result
    );
  });

  app.openapi(adminListTablesRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = parsePathParams(c, adminProjectParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.table.list',
      projectSlug: project
    });

    return c.json(
      (response as { type: 'project.table.list.result'; result: { data: UpsertTableResult['data'][] } }).result
    );
  });

  app.openapi(adminCreateTableRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = parsePathParams(c, adminProjectParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const { upsert } = adminUpsertQuerySchema.parse({
      upsert: c.req.query('upsert')
    });
    const input = await parseJsonBody(c, createTableInputSchema) satisfies CreateTableInput;
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.table.create',
      projectSlug: project,
      input,
      ...(upsert ? { allowExisting: true } : {})
    });

    const result = (response as {
      type: 'project.table.create.result';
      result: { data: UpsertTableResult['data']; created: boolean };
    }).result;
    return c.json(
      { data: result.data },
      result.created ? 201 : 200
    );
  });

  app.openapi(listRowsRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const auth = await authenticateRequest(c);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    const query = parseListRowsQuery(c);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, params.project, params.table), {
      type: 'table.rows.list',
      projectSlug: params.project,
      tableSlug: params.table,
      query,
      resolvedConfig: tableAccess.resolvedConfig,
      requestContext: buildTableRequestContext(c, 'rows.list')
    });

    return c.json((response as { type: 'table.rows.list.result'; result: ListRowsResult }).result);
  });

  app.openapi(getSchemaRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const auth = await authenticateRequest(c);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, params.project, params.table), {
      type: 'table.schema.get',
      projectSlug: params.project,
      tableSlug: params.table,
      resolvedConfig: tableAccess.resolvedConfig,
      requestContext: buildTableRequestContext(c, 'rows.schema.get')
    });

    return c.json((response as { type: 'table.schema.get.result'; result: GetSchemaResult }).result);
  });

  app.openapi(getCacheStatusRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.cache.get',
      projectSlug: project,
      tableSlug: table
    });

    return c.json((response as { type: 'table.cache.get.result'; result: GetTableCacheStatusResult }).result);
  });

  app.openapi(refreshTableCacheRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.cache.refresh',
      projectSlug: project,
      tableSlug: table,
      requestContext: buildTableRequestContext(c, 'admin.cache.refresh')
    });

    return c.json((response as { type: 'table.cache.refresh.result'; result: RefreshTableCacheResult }).result);
  });

  app.openapi(reindexTableRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.reindex',
      projectSlug: project,
      tableSlug: table,
      requestContext: buildTableRequestContext(c, 'admin.cache.reindex')
    });

    return c.json((response as { type: 'table.reindex.result'; result: ReindexTableResult }).result);
  });

  app.openapi(registerSpreadsheetWatchesRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertGlobalAdminScope(auth, 'admin:projects');
    const input = await parseJsonBody(c, adminRegisterSpreadsheetWatchesInputSchema) satisfies AdminRegisterSpreadsheetWatchesInput;
    const webhookToken = c.env.GOOGLE_DRIVE_WEBHOOK_SECRET?.trim();
    if (!webhookToken) {
      throw new ServiceUnavailableError('GOOGLE_DRIVE_WEBHOOK_SECRET is not configured.');
    }

    const webhookUrl = new URL('/v1/system/google/drive/notifications', c.req.url).toString();
    const debounceSeconds = input.debounceSeconds ?? 30;
    const expirationHours = input.expirationHours ?? 24 * 7;
    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watches.register',
      webhookUrl,
      webhookToken,
      debounceSeconds,
      expirationMs: Date.now() + expirationHours * 60 * 60 * 1000
    });

    return c.json(
      (response as {
        type: 'control.spreadsheet-watches.register.result';
        result: AdminRegisterSpreadsheetWatchesResult;
      }).result
    );
  });

  app.openapi(googleDriveNotificationRoute, async (c) => {
    const webhookToken = c.env.GOOGLE_DRIVE_WEBHOOK_SECRET?.trim();
    if (!webhookToken) {
      throw new ServiceUnavailableError('GOOGLE_DRIVE_WEBHOOK_SECRET is not configured.');
    }

    const channelId = c.req.header('x-goog-channel-id')?.trim();
    const resourceId = c.req.header('x-goog-resource-id')?.trim();
    const resourceState = c.req.header('x-goog-resource-state')?.trim();
    const providedToken = c.req.header('x-goog-channel-token')?.trim();

    if (!channelId || !resourceId || !resourceState) {
      throw new BadRequestError('Missing required Google Drive notification headers.');
    }

    if (providedToken !== webhookToken) {
      throw new UnauthorizedError('Invalid Google Drive webhook token.');
    }

    c.set('authPrincipal', 'system:google-drive');
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watch.notify',
      channelId,
      resourceId,
      resourceState,
      messageNumber: c.req.header('x-goog-message-number')?.trim() ?? null,
      changedAt: new Date().toISOString(),
      channelExpiration: c.req.header('x-goog-channel-expiration')?.trim() ?? null
    });

    return new Response(null, { status: 204 });
  });

  app.openapi(getRowRoute, async (c) => {
    const params = parsePathParams(c, rowParamsSchema);
    const auth = await authenticateRequest(c);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, params.project, params.table), {
      type: 'table.row.get',
      projectSlug: params.project,
      tableSlug: params.table,
      rowId: params.id,
      resolvedConfig: tableAccess.resolvedConfig,
      requestContext: buildTableRequestContext(c, 'rows.get')
    });

    return c.json((response as { type: 'table.row.get.result'; result: GetRowResult }).result);
  });

  app.openapi(createRowRoute, async (c) => {
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    const auth = await authenticateRequest(c);
    assertProjectScope(auth, 'table:create', project);
    const input = await parseJsonBody(c, createRowInputSchema) satisfies CreateRowInput;
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.row.create',
      projectSlug: project,
      tableSlug: table,
      input,
      requestContext: buildTableRequestContext(c, 'rows.create')
    });

    return c.json((response as { type: 'table.row.create.result'; result: CreateRowResult }).result, 201);
  });

  app.openapi(updateRowRoute, async (c) => {
    const { project, table, id } = parsePathParams(c, rowParamsSchema);
    const auth = await authenticateRequest(c);
    assertProjectScope(auth, 'table:update', project);
    const input = await parseJsonBody(c, updateRowInputSchema) satisfies UpdateRowInput;
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.row.update',
      projectSlug: project,
      tableSlug: table,
      rowId: id,
      input,
      requestContext: buildTableRequestContext(c, 'rows.update')
    });

    return c.json((response as { type: 'table.row.update.result'; result: UpdateRowResult }).result);
  });

  app.openapi(deleteRowRoute, async (c) => {
    const { project, table, id } = parsePathParams(c, rowParamsSchema);
    const auth = await authenticateRequest(c);
    assertProjectScope(auth, 'table:delete', project);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.row.delete',
      projectSlug: project,
      tableSlug: table,
      rowId: id,
      requestContext: buildTableRequestContext(c, 'rows.delete')
    });

    return c.json(
      (response as {
        type: 'table.row.delete.result';
        result: { ok: true; deletedId: string };
      }).result
    );
  });

  app.openapi(listApiKeysRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const requestedProjectSlug = listApiKeysQuerySchema.parse({
      project: c.req.query('project')
    }).project ?? null;
    const projectSlug =
      auth.kind === 'api-key' && auth.record.projectSlug
        ? auth.record.projectSlug
        : requestedProjectSlug;

    if (auth.kind === 'api-key' && auth.record.projectSlug && requestedProjectSlug && requestedProjectSlug !== auth.record.projectSlug) {
      throw new UnauthorizedError('This key cannot list API keys for another project.');
    }

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-keys.list',
      projectSlug
    });

    return c.json(
      (response as { type: 'control.api-keys.list.result'; result: AdminListApiKeysResult }).result
    );
  });

  app.openapi(createApiKeyRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const input = await parseJsonBody(c, adminCreateApiKeyInputSchema);
    if (auth.kind === 'api-key' && auth.record.projectSlug) {
      if (!input.projectSlug || input.projectSlug !== auth.record.projectSlug) {
        throw new UnauthorizedError('This key can only create API keys for its own project.');
      }
    }
    if (input.projectSlug) {
      await loadProject(c, input.projectSlug);
    }

    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-key.create',
      input
    });

    return c.json(
      (response as { type: 'control.api-key.create.result'; result: AdminCreateApiKeyResult }).result,
      201
    );
  });

  app.openapi(revokeApiKeyRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertAdminScope(auth, 'admin:keys');
    const { id } = parsePathParams(c, apiKeyParamsSchema);
    const record = await getApiKeyRecord(c, id);

    if (auth.kind === 'api-key' && auth.record.projectSlug) {
      if (!record || record.projectSlug !== auth.record.projectSlug) {
        throw new UnauthorizedError('This key cannot revoke API keys for another project.');
      }
    }

    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-key.revoke',
      apiKeyId: id,
      revokedAt: new Date().toISOString()
    });

    return c.json({ ok: true });
  });

  return app;
}

const app = createApp();

export { ControlPlaneDO, ProjectDO, TableDO, RateLimitDO, createApp };
export default app;
