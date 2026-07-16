import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers';
import {
  AppError,
  adminCreateApiKeyInputSchema,
  adminCreateApiKeyResultSchema,
  adminGetProjectResultSchema,
  adminInspectSpreadsheetTabResultSchema,
  adminListSpreadsheetWatchesResultSchema,
  adminRegisterSpreadsheetWatchesInputSchema,
  adminListSpreadsheetWatchRetryAdviceResultSchema,
  adminStopSpreadsheetWatchesInputSchema,
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
  deleteProjectResultSchema,
  deleteRowResultSchema,
  deleteTableResultSchema,
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
  NotFoundError,
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
  type AdminListSpreadsheetWatchesResult,
  type AdminRegisterSpreadsheetWatchesInput,
  type AdminListSpreadsheetWatchRetryAdviceResult,
  type AdminStopSpreadsheetWatchesInput,
  type AdminRegisterSpreadsheetWatchesResult,
  type AdminListSpreadsheetTabsResult,
  type ApiKeyPrincipal,
  type ApiScope,
  type ControlPlaneDoResponse,
  type CreateProjectInput,
  type CreateRowInput,
  type CreateTableInput,
  type DeleteProjectResult,
  type DeleteTableResult,
  type GetTableCacheStatusResult,
  type ListRowsQuery,
  type ProjectAccessResult,
  type ProjectDoResponse,
  type ResolvedProjectTableResult,
  type ResolvedTableConfigSnapshot,
  type RateLimitDoResponse,
  type TableDoResponse,
  TooManyRequestsError,
  type UpdateRowInput,
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
  verifiedApiKeyRateLimitApplied?: boolean;
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
  ok: z.boolean(),
  service: z.string(),
  checks: z.object({
    controlPlane: z.literal('ok'),
    rateLimit: z.literal('ok'),
    defaultGoogleCredential: z.enum(['configured', 'missing']),
    namedGoogleCredentials: z.enum(['configured', 'missing', 'invalid']),
    googleDriveWebhookSecret: z.enum(['configured', 'missing']),
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
const corsAllowedMethods = 'GET, POST, PATCH, DELETE, OPTIONS';
const corsAllowedHeaders = 'Authorization, Content-Type';
const cacheStatusHeaderName = 'x-sheetflare-cache-status';
const cacheInvalidationHeaderName = 'x-sheetflare-cache-invalidation';
const corsExposedHeaders = [
  'X-Request-Id',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  cacheStatusHeaderName,
  cacheInvalidationHeaderName
].join(', ');

function pruneRecentApiKeyTouches(nowMs: number) {
  if (recentApiKeyTouches.size < maxRecentApiKeyTouches) {
    return;
  }

  const cutoffMs = nowMs - apiKeyTouchIntervalMs;
  for (const [cachedApiKeyId, cachedTouchedAtMs] of recentApiKeyTouches) {
    if (cachedTouchedAtMs < cutoffMs) {
      recentApiKeyTouches.delete(cachedApiKeyId);
    }
  }

  while (recentApiKeyTouches.size >= maxRecentApiKeyTouches) {
    const oldestEntry = recentApiKeyTouches.entries().next().value;
    if (!oldestEntry) {
      break;
    }

    recentApiKeyTouches.delete(oldestEntry[0]);
  }
}

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

function getAllowedCorsOrigin(request: Request, env: Env) {
  const origin = request.headers.get('origin')?.trim();
  const configuredOrigins = env.SHEETFLARE_ALLOWED_ORIGINS?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) ?? [];

  if (!origin || configuredOrigins.length === 0) {
    return null;
  }

  if (configuredOrigins.includes('*')) {
    return '*';
  }

  return configuredOrigins.includes(origin) ? origin : null;
}

function applyCorsHeaders(response: Response, request: Request, env: Env) {
  const allowedOrigin = getAllowedCorsOrigin(request, env);
  if (!allowedOrigin) {
    return;
  }

  response.headers.set('access-control-allow-origin', allowedOrigin);
  response.headers.set('access-control-expose-headers', corsExposedHeaders);
  response.headers.append('vary', 'Origin');
}

function createCorsPreflightResponse(request: Request, env: Env) {
  const allowedOrigin = getAllowedCorsOrigin(request, env);
  if (!allowedOrigin) {
    return new Response(JSON.stringify({
      error: {
        code: 'FORBIDDEN',
        message: 'CORS origin is not allowed.',
        details: null
      }
    }), {
      status: 403,
      headers: {
        'content-type': 'application/json'
      }
    });
  }

  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': allowedOrigin,
      'access-control-allow-methods': corsAllowedMethods,
      'access-control-allow-headers': corsAllowedHeaders,
      'access-control-max-age': '600',
      'vary': 'Origin'
    }
  });
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
    hash: await hashCredentialMaterial(parsed.secret)
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

  if (/\/v1\/admin\/projects\/[^/]+$/.test(path) && normalizedMethod === 'DELETE') {
    return 'admin.projects.delete';
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

  if (/\/v1\/admin\/projects\/[^/]+\/tables\/[^/]+$/.test(path) && normalizedMethod === 'DELETE') {
    return 'admin.tables.delete';
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

  if (path === '/v1/admin/system/google/drive/watches' && normalizedMethod === 'GET') {
    return 'admin.system.drive-watches.list';
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
    const bootstrapAdminCredential = getBootstrapAdminCredential(c.env);
    if (bootstrapAdminCredential && credential === bootstrapAdminCredential) {
      return 'bootstrap-admin';
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

async function hashCredentialMaterial(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function touchApiKeyIfNeeded(env: Env, apiKeyId: string) {
  const nowMs = Date.now();
  const lastTouchedAtMs = recentApiKeyTouches.get(apiKeyId);
  if (lastTouchedAtMs !== undefined && nowMs - lastTouchedAtMs < apiKeyTouchIntervalMs) {
    return;
  }

  pruneRecentApiKeyTouches(nowMs);
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

async function enforceVerifiedApiKeyRateLimit(c: AppContext, apiKeyId: string) {
  if (c.get('verifiedApiKeyRateLimitApplied')) {
    return;
  }

  const config = getRateLimitConfiguration(c.env);
  if (config.maxRequests <= 0) {
    c.set('verifiedApiKeyRateLimitApplied', true);
    return;
  }

  const existingContext = c.get('rateLimitContext');
  const routeFamily = existingContext?.routeFamily ?? getRateLimitRouteFamily(c.req.path);
  const operationKey = existingContext?.operationKey ?? getRateLimitOperationKey(c.req.path, c.req.method);
  const principal = `api-key:${apiKeyId}`;
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
  c.set('verifiedApiKeyRateLimitApplied', true);

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

function getBootstrapAdminCredential(env: Env) {
  const credential = env.ADMIN_BEARER_TOKEN?.trim();
  return credential && credential.length > 0 ? credential : null;
}

function hasConfiguredDefaultGoogleCredential(env: Env) {
  const clientEmail = env.GOOGLE_CLIENT_EMAIL?.trim();
  const privateKey = env.GOOGLE_PRIVATE_KEY?.trim();
  return Boolean(
    clientEmail &&
    privateKey &&
    clientEmail !== 'service-account@your-gcp-project.iam.gserviceaccount.com'
  );
}

function getNamedGoogleCredentialsStatus(env: Env) {
  const rawValue = env.GOOGLE_CREDENTIALS_JSON?.trim();
  if (!rawValue) {
    return 'missing' as const;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return 'invalid' as const;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'invalid' as const;
  }

  const entries = Object.values(parsed);
  if (entries.length === 0) {
    return 'invalid' as const;
  }

  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry)
    ) {
      return 'invalid' as const;
    }

    const hasSnakeCaseCredential =
      'client_email' in entry &&
      'private_key' in entry &&
      typeof entry.client_email === 'string' &&
      entry.client_email.trim().length > 0 &&
      typeof entry.private_key === 'string' &&
      entry.private_key.trim().length > 0;
    const hasCamelCaseCredential =
      'clientEmail' in entry &&
      'privateKey' in entry &&
      typeof entry.clientEmail === 'string' &&
      entry.clientEmail.trim().length > 0 &&
      typeof entry.privateKey === 'string' &&
      entry.privateKey.trim().length > 0;

    if (!hasSnakeCaseCredential && !hasCamelCaseCredential) {
      return 'invalid' as const;
    }
  }

  return 'configured' as const;
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

  const bootstrapAdminCredential = getBootstrapAdminCredential(c.env);
  if (bootstrapAdminCredential && credential === bootstrapAdminCredential) {
    c.set('authPrincipal', 'bootstrap-admin');
    return { kind: 'bootstrap-admin' };
  }

  const record = await verifyApiKeyCredentialCached(c, credential);
  if (!record) {
    throw new UnauthorizedError('Invalid API key.');
  }

  await enforceVerifiedApiKeyRateLimit(c, record.id);
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

function assertCredentialProjectBoundary(auth: AuthContext, projectSlug: string) {
  if (auth.kind !== 'api-key') {
    return;
  }

  if (auth.record.projectSlug && auth.record.projectSlug !== projectSlug) {
    throw new UnauthorizedError();
  }
}

function assertApiKeyCanDelegateScopes(auth: AuthContext, requestedScopes: readonly ApiScope[]) {
  if (auth.kind !== 'api-key') {
    return;
  }

  const callerScopes = new Set(auth.record.scopes);
  const unauthorizedScopes = requestedScopes.filter((scope) => !callerScopes.has(scope));
  if (unauthorizedScopes.length > 0) {
    throw new UnauthorizedError('API keys can only delegate scopes they already have.');
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
    if (error instanceof NotFoundError) {
      throw new UnauthorizedError();
    }

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

async function loadProjectTables(c: { env: Env }, projectSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.table.list',
    projectSlug
  });

  return (response as {
    type: 'project.table.list.result';
    result: { data: UpsertTableResult['data'][] };
  }).result.data;
}

async function loadProjectTablesForDelete(c: { env: Env }, projectSlug: string) {
  try {
    return await loadProjectTables(c, projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return [];
    }

    throw error;
  }
}

async function clearTableCacheState(c: AppContext, projectSlug: string, tableSlug: string, route: string) {
  await doRpc<TableDoResponse>(getTableStub(c.env, projectSlug, tableSlug), {
    type: 'table.cache.clear',
    projectSlug,
    tableSlug,
    requestContext: buildTableRequestContext(c, route)
  });
}

async function getTableCacheStatusData(c: AppContext, projectSlug: string, tableSlug: string) {
  const response = await doRpc<TableDoResponse>(getTableStub(c.env, projectSlug, tableSlug), {
    type: 'table.cache.get',
    projectSlug,
    tableSlug
  });

  if (response.type !== 'table.cache.get.result') {
    throw new ServiceUnavailableError('Unexpected table cache status response.');
  }

  return response.result.data;
}

async function invalidateCachedProject(projectSlug: string) {
  await workerExports.CachedTableReads.invalidateProject(projectSlug);
}

async function invalidateCachedTable(projectSlug: string, tableSlug: string) {
  await workerExports.CachedTableReads.invalidateTable(projectSlug, tableSlug);
}

async function invalidateCachedRow(projectSlug: string, tableSlug: string, rowId: string) {
  await workerExports.CachedTableReads.invalidateRow(projectSlug, tableSlug, rowId);
}

async function invalidateAfterCommittedChange(c: AppContext, invalidate: () => Promise<void>) {
  try {
    await invalidate();
  } catch (error) {
    const normalizedError = normalizeRequestError(error);
    c.header(cacheInvalidationHeaderName, 'failed');
    console.error(JSON.stringify({
      event: 'cache.invalidation.failed',
      method: c.req.method,
      path: c.req.path,
      requestId: c.get('requestId'),
      errorName: normalizedError instanceof Error ? normalizedError.name : 'UnknownError',
      errorMessage: normalizedError instanceof Error ? normalizedError.message : String(normalizedError)
    }));
  }
}

async function invalidateCachedProjectsForSpreadsheet(c: AppContext, spreadsheetId: string) {
  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
    type: 'control.projects.list'
  });
  if (response.type !== 'control.projects.list.result') {
    throw new ServiceUnavailableError('Unexpected control plane projects list response.');
  }
  const result = response.result;

  for (const project of result.data) {
    if (project.spreadsheetId === spreadsheetId) {
      await invalidateAfterCommittedChange(c, () => invalidateCachedProject(project.slug));
    }
  }
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
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestError('Malformed JSON in request body.');
  }

  return schema.parse(body);
}

function normalizeRequestError(error: unknown) {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error && error.message.startsWith('Malformed JSON in request body')) {
    return new BadRequestError('Malformed JSON in request body.');
  }

  return error;
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
    },
    503: {
      description: 'Readiness check failed',
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

const adminDeleteProjectRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/projects/{project}',
  tags: ['Projects'],
  security: adminSecurity,
  request: {
    params: adminProjectParamsSchema
  },
  responses: {
    200: {
      description: 'Delete a configured project, or confirm it is already absent, and clear caches for its tables',
      content: jsonContent(deleteProjectResultSchema)
    },
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

const adminDeleteTableRoute = createRoute({
  method: 'delete',
  path: '/v1/admin/projects/{project}/tables/{table}',
  tags: ['Tables'],
  security: adminSecurity,
  request: {
    params: adminProjectTableParamsSchema
  },
  responses: {
    200: {
      description: 'Delete a configured table, or confirm it is already absent, and clear its local cache',
      content: jsonContent(deleteTableResultSchema)
    },
    401: unauthorizedResponse
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

const listSpreadsheetWatchesRoute = createRoute({
  method: 'get',
  path: '/v1/admin/system/google/drive/watches',
  tags: ['System'],
  security: adminSecurity,
  responses: {
    200: {
      description: 'List Google Drive spreadsheet watches',
      content: jsonContent(adminListSpreadsheetWatchesResultSchema)
    },
    401: unauthorizedResponse
  }
});

const listSpreadsheetWatchRetryAdviceRoute = createRoute({
  method: 'get',
  path: '/v1/admin/system/google/drive/watches/retry-advice',
  tags: ['System'],
  security: adminSecurity,
  responses: {
    200: {
      description: 'List Drive watch retry guidance derived from active watches and recently stopped watches',
      content: jsonContent(adminListSpreadsheetWatchRetryAdviceResultSchema)
    },
    401: unauthorizedResponse
  }
});

const stopSpreadsheetWatchesRoute = createRoute({
  method: 'post',
  path: '/v1/admin/system/google/drive/watches/stop',
  tags: ['System'],
  security: adminSecurity,
  request: {
    body: {
      content: jsonContent(adminStopSpreadsheetWatchesInputSchema),
      description: 'Stop one known spreadsheet watch or all known spreadsheet watches'
    }
  },
  responses: {
    200: {
      description: 'Stop and remove known Google Drive spreadsheet watches',
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

const cachedTableReadPrefixSegments = ['internal', 'cache', 'v1', 'projects'] as const;

type CachedTableReadOperation =
  | { kind: 'listRows'; projectSlug: string; tableSlug: string; query: ListRowsQuery }
  | { kind: 'getRow'; projectSlug: string; tableSlug: string; rowId: string }
  | { kind: 'getSchema'; projectSlug: string; tableSlug: string };

export type CachedTableReadProps = Readonly<{
  resolvedConfig: ResolvedTableConfigSnapshot;
}>;

function noStoreJsonResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store'
    }
  });
}

function applyDefaultGatewayCacheSafetyHeaders(response: Response) {
  const cacheControl = response.headers.get('cache-control');
  const hasNoStore = cacheControl?.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store');
  if (!hasNoStore) {
    response.headers.set('cache-control', 'no-store');
  }
  response.headers.delete('cloudflare-cdn-cache-control');
  response.headers.delete('cache-tag');
}

function noStoreErrorResponse(error: unknown) {
  const normalizedError = normalizeRequestError(error);
  const rpcErrorResponse = normalizedError instanceof DurableRpcError ? parseDurableRpcErrorResponse(normalizedError) : null;
  const { status, body } = rpcErrorResponse ?? toErrorResponse(normalizedError);
  return noStoreJsonResponse(body, status);
}

function decodeCachedPathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BadRequestError('Malformed cached table read path.');
  }
}

function parseListRowsQueryFromUrl(url: URL) {
  return parseListRowsQuery({
    req: {
      query: (name) => url.searchParams.get(name) ?? undefined
    }
  });
}

function parseCachedTableReadRequest(request: Request): CachedTableReadOperation {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const hasPrefix = cachedTableReadPrefixSegments.every((segment, index) => segments[index] === segment);
  if (!hasPrefix || segments[5] !== 'tables') {
    throw new NotFoundError('Cached table read route is not configured.');
  }

  const projectSlug = decodeCachedPathSegment(segments[4] ?? '');
  const tableSlug = decodeCachedPathSegment(segments[6] ?? '');

  if (segments.length === 8 && segments[7] === 'schema') {
    const params = adminProjectTableParamsSchema.parse({ project: projectSlug, table: tableSlug });
    return { kind: 'getSchema', projectSlug: params.project, tableSlug: params.table };
  }

  if (segments.length === 8 && segments[7] === 'rows') {
    const params = adminProjectTableParamsSchema.parse({ project: projectSlug, table: tableSlug });
    return {
      kind: 'listRows',
      projectSlug: params.project,
      tableSlug: params.table,
      query: parseListRowsQueryFromUrl(url)
    };
  }

  if (segments.length === 9 && segments[7] === 'rows') {
    const rowId = decodeCachedPathSegment(segments[8] ?? '');
    const params = rowParamsSchema.parse({ project: projectSlug, table: tableSlug, id: rowId });
    return { kind: 'getRow', projectSlug: params.project, tableSlug: params.table, rowId: params.id };
  }

  throw new NotFoundError('Cached table read route is not configured.');
}

async function runCachedTableRead(
  env: Env,
  operation: CachedTableReadOperation,
  resolvedConfig: ResolvedTableConfigSnapshot
) {
  if (operation.kind === 'listRows') {
    const response = await doRpc<TableDoResponse>(getTableStub(env, operation.projectSlug, operation.tableSlug), {
      type: 'table.rows.list',
      projectSlug: operation.projectSlug,
      tableSlug: operation.tableSlug,
      query: operation.query,
      resolvedConfig
    });
    if (response.type !== 'table.rows.list.result') {
      throw new ServiceUnavailableError('Unexpected table rows list response.');
    }

    return response.result;
  }

  if (operation.kind === 'getRow') {
    const response = await doRpc<TableDoResponse>(getTableStub(env, operation.projectSlug, operation.tableSlug), {
      type: 'table.row.get',
      projectSlug: operation.projectSlug,
      tableSlug: operation.tableSlug,
      rowId: operation.rowId,
      resolvedConfig
    });
    if (response.type !== 'table.row.get.result') {
      throw new ServiceUnavailableError('Unexpected table row get response.');
    }

    return response.result;
  }

  const response = await doRpc<TableDoResponse>(getTableStub(env, operation.projectSlug, operation.tableSlug), {
    type: 'table.schema.get',
    projectSlug: operation.projectSlug,
    tableSlug: operation.tableSlug,
    resolvedConfig
  });
  if (response.type !== 'table.schema.get.result') {
    throw new ServiceUnavailableError('Unexpected table schema get response.');
  }

  return response.result;
}

async function getCachedTableReadCacheStatus(
  env: Env,
  operation: CachedTableReadOperation,
  resolvedConfig: ResolvedTableConfigSnapshot
) {
  const response = await doRpc<TableDoResponse>(getTableStub(env, operation.projectSlug, operation.tableSlug), {
    type: 'table.cache.get',
    projectSlug: operation.projectSlug,
    tableSlug: operation.tableSlug,
    resolvedConfig
  });
  if (response.type !== 'table.cache.get.result') {
    throw new ServiceUnavailableError('Unexpected table cache status response.');
  }

  return response.result.data;
}

function getExternalChangeDebounceSeconds(cacheStatus: GetTableCacheStatusResult['data']) {
  if (!cacheStatus.externalChange.pending || !cacheStatus.externalChange.debounceUntil) {
    return null;
  }

  const debounceUntilMs = Date.parse(cacheStatus.externalChange.debounceUntil);
  if (!Number.isFinite(debounceUntilMs)) {
    return null;
  }

  return Math.max(0, Math.floor((debounceUntilMs - Date.now()) / 1000));
}

function getCachedTableReadEdgeTtlSeconds(cacheStatus: GetTableCacheStatusResult['data']) {
  if (cacheStatus.cacheTtlSeconds <= 0 || cacheStatus.status !== 'ready' || cacheStatus.stale) {
    return 0;
  }

  const debounceSeconds = getExternalChangeDebounceSeconds(cacheStatus);
  if (debounceSeconds === null) {
    return cacheStatus.cacheTtlSeconds;
  }

  return Math.min(cacheStatus.cacheTtlSeconds, debounceSeconds);
}

function getCachedTableReadTags(operation: CachedTableReadOperation) {
  const projectTag = getProjectCacheTag(operation.projectSlug);
  const tableTag = getTableCacheTag(operation.projectSlug, operation.tableSlug);
  if (operation.kind !== 'getRow') {
    return [projectTag, tableTag];
  }

  return [
    projectTag,
    tableTag,
    getRowCacheTag(operation.projectSlug, operation.tableSlug, operation.rowId)
  ];
}

function cachedTableReadSuccessHeaders(operation: CachedTableReadOperation, cacheStatus: GetTableCacheStatusResult['data']) {
  const edgeTtlSeconds = getCachedTableReadEdgeTtlSeconds(cacheStatus);
  const cacheTags = serializeCacheTags(getCachedTableReadTags(operation));
  const headers = new Headers({
    'cache-control': 'private, no-store'
  });

  if (cacheTags !== null) {
    headers.set('cache-tag', cacheTags);
  }

  headers.set(
    'cloudflare-cdn-cache-control',
    edgeTtlSeconds > 0 && cacheTags !== null
      ? `public, max-age=${edgeTtlSeconds}, stale-if-error=0`
      : 'no-store'
  );

  return headers;
}

async function cachedTableReadSuccessResponse(
  env: Env,
  operation: CachedTableReadOperation,
  resolvedConfig: ResolvedTableConfigSnapshot
) {
  const result = await runCachedTableRead(env, operation, resolvedConfig);
  const cacheStatus = await getCachedTableReadCacheStatus(env, operation, resolvedConfig);
  return Response.json(result, {
    headers: cachedTableReadSuccessHeaders(operation, cacheStatus)
  });
}

function compareStableJsonKeys(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => compareStableJsonKeys(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function canonicalListRowsSearch(query?: ListRowsQuery) {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();
  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.cursor) {
    params.set('cursor', query.cursor);
  }
  if (query.sort) {
    params.set('sort', query.sort);
  }
  if (query.fields && query.fields.length > 0) {
    params.set('fields', query.fields.join(','));
  }
  if (query.filter) {
    params.set('filter', stableJson(query.filter));
  }

  const search = params.toString();
  return search ? `?${search}` : '';
}

async function buildCachedTableReadConfigVersion(tableAccess: ResolvedProjectTableResult) {
  return sha256Hex(stableJson({
    project: tableAccess.project,
    table: tableAccess.table,
    resolvedConfig: tableAccess.resolvedConfig
  }));
}

type CachedTableReadFetchOptions = {
  tableAccess: ResolvedProjectTableResult;
  query?: ListRowsQuery;
};

function cachedTableReadBasePath(projectSlug: string, tableSlug: string) {
  return `/internal/cache/v1/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}`;
}

function createCachedTableReadHeaders(request: Request) {
  const headers = new Headers();
  const accept = request.headers.get('accept');
  if (accept) {
    headers.set('accept', accept);
  }

  return headers;
}

async function createCachedTableReadRequest(c: AppContext, pathname: string, options: CachedTableReadFetchOptions) {
  const url = new URL(pathname, c.req.url);
  url.search = canonicalListRowsSearch(options.query);

  const cacheKey = new URL(pathname, 'https://sheetflare-cache.internal');
  cacheKey.search = url.search;
  cacheKey.searchParams.set('__sf_auth', options.tableAccess.project.defaultAuthMode);
  cacheKey.searchParams.set('__sf_config', await buildCachedTableReadConfigVersion(options.tableAccess));

  return {
    request: new Request(url, {
      method: 'GET',
      headers: createCachedTableReadHeaders(c.req.raw)
    }),
    cacheKey: cacheKey.toString()
  };
}

async function fetchCachedTableRead(c: AppContext, pathname: string, options: CachedTableReadFetchOptions) {
  const { request, cacheKey } = await createCachedTableReadRequest(c, pathname, options);
  return workerExports.CachedTableReads({
    props: {
      resolvedConfig: options.tableAccess.resolvedConfig
    }
  }).fetch(request, {
    cf: {
      cacheKey
    }
  });
}

async function parseCachedTableReadResponse<TSchema extends z.ZodType>(
  c: AppContext,
  response: Response,
  schema: TSchema
): Promise<z.infer<TSchema>> {
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    c.header('cache-control', cacheControl);
  }

  const cacheStatus = response.headers.get('cf-cache-status')?.trim();
  if (cacheStatus) {
    c.header(cacheStatusHeaderName, cacheStatus);
  }

  const body: unknown = await response.json();
  if (response.ok) {
    return schema.parse(body);
  }

  const errorBody = errorResponseSchema.parse(body);
  throw new AppError(errorBody.error.message, errorBody.error.code, response.status, errorBody.error.details);
}

async function fetchCachedTableReadJson<TSchema extends z.ZodType>(
  c: AppContext,
  schema: TSchema,
  pathname: string,
  options: CachedTableReadFetchOptions
): Promise<z.infer<TSchema>> {
  return parseCachedTableReadResponse(c, await fetchCachedTableRead(c, pathname, options), schema);
}

const maxPurgeCacheTagLength = 1024;
const maxCacheTagHeaderLength = 16 * 1024;

function encodeCacheTagPart(value: string) {
  return encodeURIComponent(value);
}

function isPrintableAsciiCacheTag(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }

  return value.length > 0;
}

function isValidCacheTag(value: string) {
  return value.length <= maxPurgeCacheTagLength && isPrintableAsciiCacheTag(value);
}

function serializeCacheTags(tags: string[]) {
  let headerLength = 0;
  let first = true;
  for (const tag of tags) {
    if (!isValidCacheTag(tag)) {
      return null;
    }

    headerLength += tag.length;
    if (!first) {
      headerLength += 1;
    }
    first = false;
    if (headerLength > maxCacheTagHeaderLength) {
      return null;
    }
  }

  return tags.join(',');
}

function getProjectCacheTag(projectSlug: string) {
  return `project:${encodeCacheTagPart(projectSlug)}`;
}

function getTableCacheTag(projectSlug: string, tableSlug: string) {
  return `table:${encodeCacheTagPart(projectSlug)}:${encodeCacheTagPart(tableSlug)}`;
}

function getRowCacheTag(projectSlug: string, tableSlug: string, rowId: string) {
  return `row:${encodeCacheTagPart(projectSlug)}:${encodeCacheTagPart(tableSlug)}:${encodeCacheTagPart(rowId)}`;
}

export class CachedTableReads extends WorkerEntrypoint<Env, CachedTableReadProps> {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 405,
        headers: {
          allow: 'GET',
          'cache-control': 'no-store'
        }
      });
    }

    if (request.method !== 'GET') {
      return noStoreJsonResponse(
        {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'Cached table reads only support GET requests.',
            details: null
          }
        },
        405
      );
    }

    try {
      return await cachedTableReadSuccessResponse(
        this.env,
        parseCachedTableReadRequest(request),
        this.ctx.props.resolvedConfig
      );
    } catch (error) {
      return noStoreErrorResponse(error);
    }
  }

  private async purgeTags(tags: string[]): Promise<void> {
    const workerCache = this.ctx.cache;
    if (!workerCache) {
      throw new ServiceUnavailableError('Workers Cache purge API is unavailable.');
    }

    const result = await workerCache.purge({ tags });
    if (!result.success) {
      const failures = result.errors.map(({ code, message }) => `${code}: ${message}`).join('; ');
      const suffix = failures ? `: ${failures}` : '.';
      throw new Error(`Workers Cache purge was unsuccessful${suffix}`);
    }
  }

  async invalidateProject(projectSlug: string): Promise<void> {
    await this.purgeTags([getProjectCacheTag(projectSlug)]);
  }

  async invalidateTable(projectSlug: string, tableSlug: string): Promise<void> {
    await this.purgeTags([getTableCacheTag(projectSlug, tableSlug)]);
  }

  async invalidateRow(projectSlug: string, tableSlug: string, rowId: string): Promise<void> {
    const tags = [getTableCacheTag(projectSlug, tableSlug)];
    const rowTag = getRowCacheTag(projectSlug, tableSlug, rowId);
    if (isValidCacheTag(rowTag)) {
      tags.push(rowTag);
    }

    await this.purgeTags(tags);
  }
}

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    c.set('requestId', crypto.randomUUID());

    if (c.req.method === 'OPTIONS' && c.req.path.startsWith('/v1/')) {
      c.res = createCorsPreflightResponse(c.req.raw, c.env);
    } else {
      await next();
      applyCorsHeaders(c.res, c.req.raw, c.env);
    }

    applyDefaultGatewayCacheSafetyHeaders(c.res);
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
    const normalizedError = normalizeRequestError(error);
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
        errorName: normalizedError instanceof Error ? normalizedError.name : 'UnknownError',
        errorMessage: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
        errorDetails: normalizedError instanceof AppError ? normalizedError.details ?? null : null,
        errorStack: normalizedError instanceof Error ? normalizedError.stack ?? null : null
      })
    );
    const rpcErrorResponse = normalizedError instanceof DurableRpcError ? parseDurableRpcErrorResponse(normalizedError) : null;
    const { status, body } = rpcErrorResponse ?? toErrorResponse(normalizedError);
    const response = new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-request-id': c.get('requestId')
      }
    });
    applyCorsHeaders(response, c.req.raw, c.env);
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

    const hasDefaultGoogleCredential = hasConfiguredDefaultGoogleCredential(c.env);
    const namedGoogleCredentials = getNamedGoogleCredentialsStatus(c.env);
    const hasAnyGoogleCredential = hasDefaultGoogleCredential || namedGoogleCredentials === 'configured';
    const hasDriveWebhookSecret = Boolean(c.env.GOOGLE_DRIVE_WEBHOOK_SECRET?.trim());
    const hasBootstrapAdmin = Boolean(c.env.ADMIN_BEARER_TOKEN?.trim());
    const notes: string[] = [];

    if (!hasDefaultGoogleCredential && namedGoogleCredentials === 'missing') {
      notes.push('Neither the default Google service-account credential nor named GOOGLE_CREDENTIALS_JSON entries are configured.');
    } else if (!hasDefaultGoogleCredential && namedGoogleCredentials === 'configured') {
      notes.push('Default Google service-account credential is not configured, but named GOOGLE_CREDENTIALS_JSON entries are available for project-specific refs.');
    } else if (namedGoogleCredentials === 'invalid') {
      notes.push('GOOGLE_CREDENTIALS_JSON is present but invalid. Each named credential must include non-empty client_email/private_key or clientEmail/privateKey fields.');
    }

    if (!hasBootstrapAdmin) {
      notes.push('Bootstrap admin bearer token is not configured. Admin access must use API keys.');
    }

    if (!hasDriveWebhookSecret) {
      notes.push('GOOGLE_DRIVE_WEBHOOK_SECRET is not configured. Automatic Drive-watch reindexing is unavailable.');
    }

    notes.push('This endpoint validates internal worker dependencies only. Table access is verified separately through route-level smoke checks.');

    return c.json({
      ok: hasAnyGoogleCredential,
      service: 'sheetflare-api',
      checks: {
        controlPlane: 'ok',
        rateLimit: 'ok',
        defaultGoogleCredential: hasDefaultGoogleCredential ? 'configured' : 'missing',
        namedGoogleCredentials,
        googleDriveWebhookSecret: hasDriveWebhookSecret ? 'configured' : 'missing',
        bootstrapAdmin: hasBootstrapAdmin ? 'configured' : 'missing'
      },
      notes
    }, hasAnyGoogleCredential ? 200 : 503);
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
    if (!result.created) {
      await invalidateAfterCommittedChange(c, () => invalidateCachedProject(result.data.project.slug));
    }
    return c.json(result.data, result.created ? 201 : 200);
  });

  app.openapi(adminDeleteProjectRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project } = parsePathParams(c, adminProjectParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const tables = await loadProjectTablesForDelete(c, project);
    for (const table of tables) {
      await clearTableCacheState(c, project, table.tableSlug, 'admin.projects.delete');
    }

    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.delete',
      projectSlug: project
    });
    const result = (response as {
      type: 'project.delete.result';
      result: DeleteProjectResult;
    }).result;
    await invalidateAfterCommittedChange(c, () => invalidateCachedProject(project));

    return c.json(result);
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
    if (!result.created) {
      await invalidateAfterCommittedChange(c, () => invalidateCachedTable(project, result.data.tableSlug));
    }
    return c.json(
      { data: result.data },
      result.created ? 201 : 200
    );
  });

  app.openapi(adminDeleteTableRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    await clearTableCacheState(c, project, table, 'admin.tables.delete');
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.table.delete',
      projectSlug: project,
      tableSlug: table
    });
    const result = (response as {
      type: 'project.table.delete.result';
      result: DeleteTableResult;
    }).result;
    await invalidateAfterCommittedChange(c, () => invalidateCachedTable(project, table));

    return c.json(result);
  });

  app.openapi(listRowsRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const auth = await authenticateRequest(c);
    assertCredentialProjectBoundary(auth, params.project);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    const query = parseListRowsQuery(c);
    return c.json(await fetchCachedTableReadJson(
      c,
      listRowsResultSchema,
      `${cachedTableReadBasePath(params.project, params.table)}/rows`,
      { tableAccess, query }
    ));
  });

  app.openapi(getSchemaRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const auth = await authenticateRequest(c);
    assertCredentialProjectBoundary(auth, params.project);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    return c.json(await fetchCachedTableReadJson(
      c,
      getSchemaResultSchema,
      `${cachedTableReadBasePath(params.project, params.table)}/schema`,
      { tableAccess }
    ));
  });

  app.openapi(getCacheStatusRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    return c.json({
      data: await getTableCacheStatusData(c, project, table)
    });
  });

  app.openapi(refreshTableCacheRoute, async (c) => {
    const auth = await authenticateRequest(c);
    const { project, table } = parsePathParams(c, adminProjectTableParamsSchema);
    assertProjectScope(auth, 'admin:projects', project);
    const cacheStatusBeforeRefresh = await getTableCacheStatusData(c, project, table);
    const response = await doRpc<TableDoResponse>(getTableStub(c.env, project, table), {
      type: 'table.cache.refresh',
      projectSlug: project,
      tableSlug: table,
      requestContext: buildTableRequestContext(c, 'admin.cache.refresh')
    });

    if (response.type !== 'table.cache.refresh.result') {
      throw new ServiceUnavailableError('Unexpected table cache refresh response.');
    }
    if (cacheStatusBeforeRefresh.status !== 'ready' || cacheStatusBeforeRefresh.stale) {
      await invalidateAfterCommittedChange(c, () => invalidateCachedTable(project, table));
    }
    return c.json(response.result);
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

    if (response.type !== 'table.reindex.result') {
      throw new ServiceUnavailableError('Unexpected table reindex response.');
    }
    await invalidateAfterCommittedChange(c, () => invalidateCachedTable(project, table));
    return c.json(response.result);
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

  app.openapi(listSpreadsheetWatchesRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertGlobalAdminScope(auth, 'admin:projects');
    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watches.list'
    });

    return c.json(
      (response as {
        type: 'control.spreadsheet-watches.list.result';
        result: AdminListSpreadsheetWatchesResult;
      }).result
    );
  });

  app.openapi(listSpreadsheetWatchRetryAdviceRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertGlobalAdminScope(auth, 'admin:projects');
    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watches.retry-advice.list'
    });

    return c.json(
      (response as {
        type: 'control.spreadsheet-watches.retry-advice.list.result';
        result: AdminListSpreadsheetWatchRetryAdviceResult;
      }).result
    );
  });

  app.openapi(stopSpreadsheetWatchesRoute, async (c) => {
    const auth = await authenticateRequest(c);
    assertGlobalAdminScope(auth, 'admin:projects');
    const input = await parseJsonBody(c, adminStopSpreadsheetWatchesInputSchema) satisfies AdminStopSpreadsheetWatchesInput;
    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watches.stop',
      input
    });

    return c.json(
      (response as {
        type: 'control.spreadsheet-watches.stop.result';
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
    const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.spreadsheet-watch.notify',
      channelId,
      resourceId,
      resourceState,
      messageNumber: c.req.header('x-goog-message-number')?.trim() ?? null,
      changedAt: new Date().toISOString(),
      channelExpiration: c.req.header('x-goog-channel-expiration')?.trim() ?? null
    });
    if (response.type !== 'control.spreadsheet-watch.notify.result') {
      throw new ServiceUnavailableError('Unexpected control plane spreadsheet watch notify response.');
    }
    const result = response.result;
    if (result.accepted && result.spreadsheetId && result.debounceUntil) {
      await invalidateCachedProjectsForSpreadsheet(c, result.spreadsheetId);
    }

    return new Response(null, { status: 204 });
  });

  app.openapi(getRowRoute, async (c) => {
    const params = parsePathParams(c, rowParamsSchema);
    const auth = await authenticateRequest(c);
    assertCredentialProjectBoundary(auth, params.project);
    if (auth.kind === 'anonymous') {
      await requirePublicReadProject(c, params.project);
    }
    const tableAccess = await loadProjectTable(c, params.project, params.table);
    if (auth.kind !== 'anonymous' && tableAccess.project.defaultAuthMode !== 'public-read') {
      assertProjectScope(auth, 'table:read', params.project);
    }
    return c.json(await fetchCachedTableReadJson(
      c,
      getRowResultSchema,
      `${cachedTableReadBasePath(params.project, params.table)}/rows/${encodeURIComponent(params.id)}`,
      { tableAccess }
    ));
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

    if (response.type !== 'table.row.create.result') {
      throw new ServiceUnavailableError('Unexpected table row create response.');
    }
    await invalidateAfterCommittedChange(c, () => invalidateCachedTable(project, table));
    return c.json(response.result, 201);
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

    if (response.type !== 'table.row.update.result') {
      throw new ServiceUnavailableError('Unexpected table row update response.');
    }
    await invalidateAfterCommittedChange(c, () => invalidateCachedRow(project, table, id));
    return c.json(response.result);
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

    if (response.type !== 'table.row.delete.result') {
      throw new ServiceUnavailableError('Unexpected table row delete response.');
    }
    await invalidateAfterCommittedChange(c, () => invalidateCachedRow(project, table, id));
    return c.json(response.result);
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
    assertApiKeyCanDelegateScopes(auth, input.scopes);
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

function resetRecentApiKeyTouchesForTests() {
  recentApiKeyTouches.clear();
}

function getRecentApiKeyTouchCacheSizeForTests() {
  return recentApiKeyTouches.size;
}

export {
  ControlPlaneDO,
  ProjectDO,
  TableDO,
  RateLimitDO,
  createApp,
  touchApiKeyIfNeeded as __touchApiKeyIfNeededForTests,
  resetRecentApiKeyTouchesForTests as __resetRecentApiKeyTouchesForTests,
  getRecentApiKeyTouchCacheSizeForTests as __getRecentApiKeyTouchCacheSizeForTests
};
export default app;
