import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { WorkerEntrypoint, exports as workerExports } from 'cloudflare:workers';
import {
  AppError,
  adminSessionPath,
  buildAdminUiHeaders,
  type AdminSessionResponse,
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
  spreadsheetWatchNotifyResultSchema,
  tableDataGenerationSchema,
  BadRequestError,
  ForbiddenError,
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
  type DeleteTableResult,
  type GetTableCacheStatusResult,
  type ListRowsQuery,
  type ProjectDoResponse,
  type ResolvedProjectTableResult,
  type ResolvedTableConfigSnapshot,
  type RateLimitDoResponse,
  type TableDataGeneration,
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
  retryAfterSeconds?: number;
  preserveAdminAssetCache?: boolean;
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

const readySummarySchema = z.object({
  ok: z.boolean(),
  service: z.string()
});

const readyResponseSchema = readySummarySchema.extend({
  checks: z.object({
    controlPlane: z.literal('ok'),
    rateLimit: z.literal('ok'),
    defaultGoogleCredential: z.enum(['configured', 'missing']),
    namedGoogleCredentials: z.enum(['configured', 'missing', 'invalid']),
    googleDriveWebhookSecret: z.enum(['configured', 'missing']),
    bootstrapAdmin: z.enum(['configured', 'missing']),
    adminUi: z.enum(['enabled', 'disabled', 'invalid', 'assets-missing'])
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

// A string-typed media type makes zod-openapi accept a raw Response, so a cache hit can pass its body through.
function cachedReadJsonContent(schema: z.ZodTypeAny): { [mediaType: string]: { schema: z.ZodTypeAny } } {
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
  description: 'Unauthorized. The credential is missing, malformed, unknown, or revoked.',
  content: jsonContent(errorResponseSchema)
} as const;

const badRequestResponse = {
  description: 'Bad request',
  content: jsonContent(errorResponseSchema)
} as const;

const forbiddenResponse = {
  description: 'Forbidden. The credential is valid but lacks the required scope or project access.',
  content: jsonContent(errorResponseSchema)
} as const;

const rateLimitedResponse = {
  description: 'Too many requests. Wait the number of seconds in the Retry-After header before retrying.',
  headers: z.object({
    'Retry-After': z.string().openapi({ description: 'Seconds until the rate limit window resets.', example: '30' })
  }),
  content: jsonContent(errorResponseSchema)
} as const;

const protectedRouteErrorResponses = {
  401: unauthorizedResponse,
  403: forbiddenResponse,
  429: rateLimitedResponse
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
// Each Worker isolate remembers what the control plane said about a credential for this long, so a revoked key can
// keep working for up to this long on isolates that verified it earlier. The isolate that handles the revoke request
// forgets the key immediately.
const principalCacheTtlMs = 10_000;
const maxPrincipalCacheEntries = 10_000;
type CachedPrincipal = { record: ApiKeyPrincipal | null; expiresAtMs: number };
const principalCache = new Map<string, CachedPrincipal>();
// /ready would otherwise cost a control plane call per request, so each isolate probes it once per window and reports
// the same outcome, failure included, until the window ends.
const readinessProbeTtlMs = 10_000;
type ReadinessProbe = { outcome: { ok: true } | { ok: false; error: unknown }; expiresAtMs: number };
let readinessProbe: ReadinessProbe | null = null;
const webhookFailureOperationKey = 'webhook-failure';
const maxWebhookFailureBlocks = 10_000;
type WebhookFailureBlock = {
  principal: string;
  routeFamily: string;
  operationKey: string;
  maxRequests: number;
  windowSeconds: number;
  resetAtMs: number;
};
const webhookFailureBlocks = new Map<string, WebhookFailureBlock>();
const corsAllowedMethods = 'GET, POST, PATCH, DELETE, OPTIONS';
const corsAllowedHeaders = 'Authorization, Content-Type';
const cacheStatusHeaderName = 'x-sheetflare-cache-status';
const corsExposedHeaders = [
  'X-Request-Id',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'Retry-After',
  cacheStatusHeaderName
].join(', ');

// Makes room for one more entry: drops expired entries first, then the oldest ones.
function evictForInsert<T>(entries: Map<string, T>, maxEntries: number, isExpired: (entry: T) => boolean) {
  if (entries.size < maxEntries) {
    return;
  }

  for (const [key, entry] of entries) {
    if (isExpired(entry)) {
      entries.delete(key);
    }
  }

  while (entries.size >= maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) {
      break;
    }

    entries.delete(oldest.value);
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

// Keys are minted as `sfk_<uuid>.<64 hex characters>` by ControlPlaneDO.createApiKey. Any other shape cannot be a real
// key, so it is rejected here instead of reaching the control plane and its RPC validation errors.
const apiKeyPattern = /^sfk_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

function parseApiKey(value: string) {
  const match = apiKeyPattern.exec(value);
  const apiKeyId = match?.[1];
  const secret = match?.[2];
  return apiKeyId !== undefined && secret !== undefined ? { apiKeyId, secret } : null;
}

async function verifyApiKeyCredential(env: Env, credential: string): Promise<ApiKeyPrincipal | null> {
  const apiKey = parseApiKey(credential);
  if (!apiKey) {
    return null;
  }

  const hash = await hashCredentialMaterial(apiKey.secret);
  const cacheKey = `${apiKey.apiKeyId}.${hash}`;
  const nowMs = Date.now();
  const cached = principalCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.record;
  }

  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
    type: 'control.api-key.verify',
    apiKeyId: apiKey.apiKeyId,
    hash
  });
  if (response.type !== 'control.api-key.verify.result') {
    throw new ServiceUnavailableError('Unexpected control plane api key verify response.');
  }

  // Only answers from the control plane are remembered. A failed lookup is retried, never cached as a rejection.
  principalCache.delete(cacheKey);
  evictForInsert(principalCache, maxPrincipalCacheEntries, (entry) => entry.expiresAtMs <= nowMs);
  principalCache.set(cacheKey, { record: response.result.record, expiresAtMs: nowMs + principalCacheTtlMs });
  return response.result.record;
}

function forgetCachedPrincipals(apiKeyId: string) {
  for (const cacheKey of principalCache.keys()) {
    if (cacheKey.startsWith(`${apiKeyId}.`)) {
      principalCache.delete(cacheKey);
    }
  }
}

function getRateLimitConfiguration(env: Env) {
  const maxRequests = Number.parseInt(env.RATE_LIMIT_MAX_REQUESTS ?? '300', 10);
  const windowSeconds = Number.parseInt(env.RATE_LIMIT_WINDOW_SECONDS ?? '60', 10);

  return {
    maxRequests: Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 300,
    windowSeconds: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 60
  };
}

// One IPv6 /64 is one network (typically one subscriber), so the whole prefix shares a bucket. The address is expanded
// and lowercased first, which makes `2001:db8:abcd:12::1` and `2001:0DB8:ABCD:0012:ffff::` the same principal.
// Anything that is not eight hextets is left unchanged, including IPv4.
function bucketClientAddress(ipAddress: string) {
  const normalized = ipAddress.trim().toLowerCase();
  if (!normalized.includes(':') || normalized.includes('.')) {
    return normalized;
  }

  const sides = normalized.split('::');
  if (sides.length > 2) {
    return normalized;
  }
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (sides.length === 2 && missing < 0) {
    return normalized;
  }
  const groups = sides.length === 2 ? [...head, ...Array<string>(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return normalized;
  }

  return `${groups.slice(0, 4).map((group) => group.replace(/^0+/, '') || '0').join(':')}::`;
}

function getRateLimitPrincipal(c: { req: { header(name: string): string | undefined; method: string; path: string } ; env: Env }) {
  const ipAddress = c.req.header('cf-connecting-ip')?.trim();
  return ipAddress ? `client:${bucketClientAddress(ipAddress)}` : 'client:anonymous';
}

function getRateLimitRouteFamily(path: string) {
  if (path.startsWith('/v1/system/') || path === '/ready') {
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

  if (path === '/ready' && normalizedMethod === 'GET') {
    return 'system.ready';
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

type PresentedAuthorization =
  | { kind: 'none' }
  | { kind: 'bearer'; credential: string }
  | { kind: 'unusable'; message: string };

// RFC 9110: the authentication scheme is case-insensitive and separated from the credential by whitespace.
function readAuthorization(header: string | undefined): PresentedAuthorization {
  if (!header) {
    return { kind: 'none' };
  }

  const match = /^(\S+)\s*([\s\S]*)$/.exec(header.trim());
  const scheme = match?.[1] ?? '';
  const credential = match?.[2]?.trim() ?? '';
  if (scheme.toLowerCase() !== 'bearer') {
    return { kind: 'unusable', message: 'Unsupported authorization scheme.' };
  }

  return credential ? { kind: 'bearer', credential } : { kind: 'unusable', message: 'Unauthorized' };
}

async function resolveRateLimitPrincipal(c: AppContext) {
  const presented = readAuthorization(c.req.header('authorization'));
  const bootstrapAdminCredential = getBootstrapAdminCredential(c.env);
  if (
    presented.kind === 'bearer'
    && bootstrapAdminCredential
    && await timingSafeEqualSecret(presented.credential, bootstrapAdminCredential)
  ) {
    return 'bootstrap-admin';
  }

  return getRateLimitPrincipal(c);
}

function createRateLimitError(
  c: AppContext,
  details: {
    principal: string;
    routeFamily: string;
    operationKey: string;
    maxRequests: number;
    windowSeconds: number;
    resetAtMs: number;
  }
) {
  const { resetAtMs, ...publicDetails } = details;
  c.set('retryAfterSeconds', Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000)));
  return new TooManyRequestsError('Rate limit exceeded.', {
    ...publicDetails,
    resetAt: new Date(resetAtMs).toISOString()
  });
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

  const { result } = response;

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
    throw createRateLimitError(c, {
      principal,
      routeFamily,
      operationKey,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds,
      resetAtMs: result.resetAtMs
    });
  }
}

async function hashCredentialMaterial(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

// Compare SHA-256 digests so the loop runs for a fixed length even when the secrets differ in length.
function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const leftByte = index < left.length ? left[index] ?? 0 : 0;
    const rightByte = index < right.length ? right[index] ?? 0 : 0;
    mismatch |= leftByte ^ rightByte;
  }
  return mismatch === 0;
}

async function timingSafeEqualSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right))
  ]);
  return timingSafeEqualBytes(new Uint8Array(leftDigest), new Uint8Array(rightDigest));
}

function readWebhookFailureBlock(clientKey: string, nowMs: number) {
  const block = webhookFailureBlocks.get(clientKey);
  if (block === undefined) {
    return null;
  }
  if (block.resetAtMs <= nowMs) {
    webhookFailureBlocks.delete(clientKey);
    return null;
  }
  return block;
}

function rememberWebhookFailureBlock(clientKey: string, block: WebhookFailureBlock) {
  evictForInsert(webhookFailureBlocks, maxWebhookFailureBlocks, (entry) => entry.resetAtMs <= Date.now());
  webhookFailureBlocks.set(clientKey, block);
}

function throwWebhookFailureLimit(c: AppContext, block: WebhookFailureBlock): never {
  c.set('rateLimit', {
    limit: block.maxRequests,
    remaining: 0,
    resetAtMs: block.resetAtMs
  });
  c.set('rateLimitContext', {
    principal: block.principal,
    routeFamily: block.routeFamily,
    operationKey: block.operationKey
  });
  throw createRateLimitError(c, {
    principal: block.principal,
    routeFamily: block.routeFamily,
    operationKey: block.operationKey,
    maxRequests: block.maxRequests,
    windowSeconds: block.windowSeconds,
    resetAtMs: block.resetAtMs
  });
}

async function assertWebhookToken(c: AppContext, webhookToken: string, providedToken: string | undefined) {
  const clientKey = getRateLimitPrincipal(c);
  const blocked = readWebhookFailureBlock(clientKey, Date.now());
  if (blocked) {
    throwWebhookFailureLimit(c, blocked);
  }

  const matches = await timingSafeEqualSecret(providedToken ?? '', webhookToken);
  if (matches) {
    return;
  }

  const config = getRateLimitConfiguration(c.env);
  const principal = `system:${clientKey}`;
  const routeFamily = 'system';
  const response = await doRpc<RateLimitDoResponse>(getRateLimitStub(c.env, `${routeFamily}:${clientKey}`), {
    type: 'rate-limit.check',
    key: webhookFailureOperationKey,
    limit: config.maxRequests,
    windowSeconds: config.windowSeconds
  });
  const { result } = response;
  c.set('rateLimit', {
    limit: config.maxRequests,
    remaining: result.remaining,
    resetAtMs: result.resetAtMs
  });
  c.set('rateLimitContext', {
    principal,
    routeFamily,
    operationKey: webhookFailureOperationKey
  });

  if (!result.allowed) {
    rememberWebhookFailureBlock(clientKey, {
      principal,
      routeFamily,
      operationKey: webhookFailureOperationKey,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds,
      resetAtMs: result.resetAtMs
    });
    throw createRateLimitError(c, {
      principal,
      routeFamily,
      operationKey: webhookFailureOperationKey,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds,
      resetAtMs: result.resetAtMs
    });
  }

  throw new UnauthorizedError('Invalid Google Drive webhook token.');
}

async function touchApiKeyIfNeeded(env: Env, apiKeyId: string, requestId?: string) {
  const nowMs = Date.now();
  const lastTouchedAtMs = recentApiKeyTouches.get(apiKeyId);
  if (lastTouchedAtMs !== undefined && nowMs - lastTouchedAtMs < apiKeyTouchIntervalMs) {
    return;
  }

  // Last-used is audit telemetry, so a failed touch must not fail an otherwise valid request. The throttle starts only
  // after the control plane accepted the update, so the next request retries a failed touch.
  try {
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
      type: 'control.api-key.touch',
      apiKeyId,
      usedAt: new Date(nowMs).toISOString()
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: 'api_key.touch.failed',
      apiKeyId,
      requestId: requestId ?? null,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error)
    }));
    return;
  }

  evictForInsert(recentApiKeyTouches, maxRecentApiKeyTouches, (touchedAtMs) => touchedAtMs < nowMs - apiKeyTouchIntervalMs);
  recentApiKeyTouches.set(apiKeyId, nowMs);
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

  const { result } = response;

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
    throw createRateLimitError(c, {
      principal,
      routeFamily,
      operationKey,
      maxRequests: config.maxRequests,
      windowSeconds: config.windowSeconds,
      resetAtMs: result.resetAtMs
    });
  }
}

// A primary-key lookup of an id that never exists: it proves the control plane answers without scanning the registry
// or writing anything.
async function probeControlPlane(env: Env): Promise<ReadinessProbe['outcome']> {
  try {
    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(env), {
      type: 'control.api-key.get',
      apiKeyId: 'readiness-probe'
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function assertControlPlaneReachable(env: Env) {
  const nowMs = Date.now();
  let probe = readinessProbe;
  if (probe === null || probe.expiresAtMs <= nowMs) {
    probe = { outcome: await probeControlPlane(env), expiresAtMs: nowMs + readinessProbeTtlMs };
    readinessProbe = probe;
  }

  if (!probe.outcome.ok) {
    throw probe.outcome.error;
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

// Who is calling? Verifies the credential but does not yet charge the key's rate limit or record its use.
async function identifyCaller(c: AppContext): Promise<AuthContext> {
  const presented = readAuthorization(c.req.header('authorization'));
  if (presented.kind === 'none') {
    c.set('authPrincipal', 'anonymous');
    return { kind: 'anonymous' };
  }

  if (presented.kind === 'unusable') {
    throw new UnauthorizedError(presented.message);
  }

  const bootstrapAdminCredential = getBootstrapAdminCredential(c.env);
  if (bootstrapAdminCredential && await timingSafeEqualSecret(presented.credential, bootstrapAdminCredential)) {
    c.set('authPrincipal', 'bootstrap-admin');
    return { kind: 'bootstrap-admin' };
  }

  const record = await verifyApiKeyCredential(c.env, presented.credential);
  if (!record) {
    throw new UnauthorizedError('Invalid API key.');
  }

  c.set('authPrincipal', `api-key:${record.id}`);
  return {
    kind: 'api-key',
    record
  };
}

// The per-key rate limit and the last-used touch only need the key id, so they do not wait for each other.
async function completeAuthentication(c: AppContext, auth: AuthContext) {
  if (auth.kind !== 'api-key') {
    return;
  }

  await Promise.all([
    enforceVerifiedApiKeyRateLimit(c, auth.record.id),
    touchApiKeyIfNeeded(c.env, auth.record.id, c.get('requestId'))
  ]);
}

async function authenticateRequest(c: AppContext): Promise<AuthContext> {
  const auth = await identifyCaller(c);
  await completeAuthentication(c, auth);
  return auth;
}

function hasScope(record: ApiKeyPrincipal, scope: ApiScope) {
  return record.scopes.includes(scope);
}

const wrongProjectMessage = 'This API key is scoped to a different project.';

// Missing or invalid credentials are 401; a valid credential that lacks access is 403.
function missingScopeError(scope: ApiScope) {
  return new ForbiddenError(`This API key does not have the "${scope}" scope.`);
}

function assertAdminScope(auth: AuthContext, scope: ApiScope) {
  if (auth.kind === 'bootstrap-admin') {
    return;
  }

  if (auth.kind !== 'api-key') {
    throw new UnauthorizedError();
  }

  if (!hasScope(auth.record, scope)) {
    throw missingScopeError(scope);
  }
}

function assertGlobalAdminScope(auth: AuthContext, scope: ApiScope) {
  assertAdminScope(auth, scope);

  if (auth.kind === 'api-key' && auth.record.projectSlug) {
    throw new ForbiddenError('This operation requires a global admin key.');
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
    throw missingScopeError(scope);
  }

  if (auth.record.projectSlug && auth.record.projectSlug !== projectSlug) {
    throw new ForbiddenError(wrongProjectMessage);
  }
}

function keyCrossesProjectBoundary(auth: AuthContext, projectSlug: string) {
  return auth.kind === 'api-key' && Boolean(auth.record.projectSlug) && auth.record.projectSlug !== projectSlug;
}

function assertCredentialProjectBoundary(auth: AuthContext, projectSlug: string) {
  if (keyCrossesProjectBoundary(auth, projectSlug)) {
    throw new ForbiddenError(wrongProjectMessage);
  }
}

function assertApiKeyCanDelegateScopes(auth: AuthContext, requestedScopes: readonly ApiScope[]) {
  if (auth.kind !== 'api-key') {
    return;
  }

  const callerScopes = new Set(auth.record.scopes);
  const unauthorizedScopes = requestedScopes.filter((scope) => !callerScopes.has(scope));
  if (unauthorizedScopes.length > 0) {
    throw new ForbiddenError('API keys can only delegate scopes they already have.');
  }
}

async function loadProject(c: { env: Env }, projectSlug: string) {
  const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, projectSlug), {
    type: 'project.get',
    projectSlug
  });

  return (response as { type: 'project.get.result'; result: AdminGetProjectResult }).result;
}

type Settled<T> = { ok: true; value: T } | { ok: false; reason: unknown };

// Starting work early and then abandoning it (for a rejected credential, say) must not leave an unhandled rejection
// behind, so such work is awaited through a copy that never rejects.
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (reason: unknown): Settled<T> => ({ ok: false, reason })
  );
}

function isNotFound(error: unknown) {
  return error instanceof NotFoundError || (error instanceof DurableRpcError && error.status === 404);
}

function grantsTableRead(auth: AuthContext) {
  return auth.kind === 'bootstrap-admin' || (auth.kind === 'api-key' && hasScope(auth.record, 'table:read'));
}

type TableReadTarget = {
  tableAccess: ResolvedProjectTableResult;
  /** The table's data generation just before the read. Cached reads are keyed by it. */
  generation: TableDataGeneration;
};

type TableLookup = { readable: true; target: TableReadTarget } | { readable: false };

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

// Cheap and free of Google calls: the table answers from its own metadata without syncing. It carries the resolved
// config so the table notices a configuration change before the cache key is built.
async function loadTableDataGeneration(
  env: Env,
  projectSlug: string,
  tableSlug: string,
  resolvedConfig: ResolvedTableConfigSnapshot
): Promise<TableDataGeneration> {
  const response = await doRpc<TableDoResponse>(getTableStub(env, projectSlug, tableSlug), {
    type: 'table.generation.get',
    projectSlug,
    tableSlug,
    resolvedConfig
  });
  if (response.type !== 'table.generation.get.result') {
    throw new ServiceUnavailableError('Unexpected table generation response.');
  }

  const generation = tableDataGenerationSchema.safeParse(response.result);
  if (!generation.success) {
    throw new ServiceUnavailableError('Unexpected table generation response.');
  }

  return generation.data;
}

// A key minted for another project has no grant here. On a public-read project it may still read, the same way an
// anonymous caller can, and it keeps its own per-key rate-limit budget rather than spending the anonymous one.
function readAuthForProject(auth: AuthContext, projectSlug: string, defaultAuthMode: string): AuthContext {
  if (keyCrossesProjectBoundary(auth, projectSlug) && defaultAuthMode === 'public-read') {
    return { kind: 'anonymous' };
  }
  return auth;
}

// The table lookup and, only when this caller may read the table (a read grant, or a public-read project), the table's
// data generation. A caller that may not read it never causes a table call.
async function lookupTableForCaller(
  c: AppContext,
  auth: AuthContext,
  projectSlug: string,
  tableSlug: string
): Promise<TableLookup> {
  const tableAccess = await loadProjectTable(c, projectSlug, tableSlug);
  const readAuth = readAuthForProject(auth, projectSlug, tableAccess.project.defaultAuthMode);
  const crossesProject = keyCrossesProjectBoundary(auth, projectSlug);
  const publicRead = tableAccess.project.defaultAuthMode === 'public-read';
  if ((!grantsTableRead(readAuth) || crossesProject) && !publicRead) {
    return { readable: false };
  }

  const generation = await loadTableDataGeneration(c.env, projectSlug, tableSlug, tableAccess.resolvedConfig);
  return { readable: true, target: { tableAccess, generation } };
}

// Table reads wait on the caller's rate limit and on the table lookup. Neither depends on the other, so once the
// caller is known both run together, and the generation lookup rides along with the table lookup instead of queueing
// behind the rate limit. Whether a key scoped to another project may read is decided from the project the lookup
// returns: a public-read project allows it as an anonymous caller, and anything else is 403. Writes and admin routes
// never come here, so they keep rejecting that key with 403.
async function authorizeTableRead(c: AppContext, projectSlug: string, tableSlug: string): Promise<TableReadTarget> {
  const auth = await identifyCaller(c);

  const lookup = settle(lookupTableForCaller(c, auth, projectSlug, tableSlug));
  await completeAuthentication(c, auth);
  const looked = await lookup;

  if (looked.ok) {
    if (looked.value.readable) {
      return looked.value.target;
    }
    if (keyCrossesProjectBoundary(auth, projectSlug)) {
      throw new ForbiddenError(wrongProjectMessage);
    }
  } else if (grantsTableRead(auth) || !isNotFound(looked.reason)) {
    throw looked.reason;
  }

  // Callers without a read grant may only read public-read projects. Private projects, missing projects, and missing
  // tables all get the same denial, so the response never reveals which of them exist.
  throw auth.kind === 'api-key' ? missingScopeError('table:read') : new UnauthorizedError();
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

// Hono throws when a request was dispatched without an ExecutionContext, as unit tests calling `app.request` do. The
// Workers runtime always supplies one.
function getExecutionContext(c: AppContext) {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

type CachePurgeLogContext = { method: string; path: string; requestId: string };

// A purge failure never reaches the client. It is logged for operators, and the next request is served as usual.
async function purgeCachedEntriesQuietly(context: CachePurgeLogContext, targets: readonly CachePurgeTarget[]) {
  try {
    await workerExports.CachedTableReads.purge(targets);
  } catch (error) {
    const normalizedError = normalizeRequestError(error);
    console.warn(JSON.stringify({
      event: 'cache.invalidation.failed',
      ...context,
      errorName: normalizedError instanceof Error ? normalizedError.name : 'UnknownError',
      errorMessage: normalizedError instanceof Error ? normalizedError.message : String(normalizedError)
    }));
  }
}

// Cached reads are keyed by the table's data generation, so an edge entry a committed change superseded can no longer be
// served, and freshness never depends on this purge. It only frees edge storage ahead of the entry's TTL. That makes it
// best-effort: one batched call per request, started after the change is committed and finished through waitUntil so the
// response never waits for it. Workers Cache purge always uses Free-tier limits (a burst of 25 requests, then 5 a
// minute), so on a busy table most of these calls are expected to be rejected.
async function purgeCachedEntries(c: AppContext, targets: readonly CachePurgeTarget[]) {
  if (targets.length === 0) {
    return;
  }

  const purge = purgeCachedEntriesQuietly(
    { method: c.req.method, path: c.req.path, requestId: c.get('requestId') },
    targets
  );
  const executionCtx = getExecutionContext(c);
  if (executionCtx) {
    executionCtx.waitUntil(purge);
    return;
  }

  await purge;
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

async function listProjectApiKeyIds(c: { env: Env }, projectSlug: string) {
  const response = await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
    type: 'control.api-keys.list',
    projectSlug
  });

  if (response.type !== 'control.api-keys.list.result') {
    throw new ServiceUnavailableError('Unexpected control plane api key list response.');
  }

  return response.result.data.map((record) => record.id);
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

// A Durable Object answers a payload its shared RPC schema rejects with one of these 400s
// (parseDurableObjectRpcRequest). The gateway built that payload, so the failure is a server bug, not a client mistake.
function isDurableObjectBoundaryRejection(error: unknown) {
  return error instanceof BadRequestError && (
    error.message === 'Request validation failed.'
    || error.message === 'Malformed JSON in Durable Object RPC request.'
  );
}

const durableObjectOverloadRetryAfterSeconds = 2;

// Durable Object stubs reject with `overloaded: true` while an object is shedding load.
function isDurableObjectOverloaded(error: unknown) {
  return error instanceof Error && 'overloaded' in error && error.overloaded === true;
}

// Only intentional contract errors reach clients; everything else becomes the generic INTERNAL_ERROR body.
function toPublicErrorResponse(error: unknown) {
  if (isDurableObjectBoundaryRejection(error)) {
    return toErrorResponse(new Error('A Durable Object rejected a gateway-built RPC payload.'));
  }

  if (isDurableObjectOverloaded(error)) {
    return toErrorResponse(new ServiceUnavailableError('The service is temporarily overloaded. Retry shortly.'));
  }

  const rpcErrorResponse = error instanceof DurableRpcError ? parseDurableRpcErrorResponse(error) : null;
  return rpcErrorResponse ?? toErrorResponse(error);
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
  security: optionalBearerSecurity,
  responses: {
    200: {
      description: 'Ready. Anonymous callers receive only `ok` and `service`; a global admin credential also receives the checks and notes.',
      content: jsonContent(z.union([readyResponseSchema, readySummarySchema]))
    },
    503: {
      description: 'Not ready. Same shape as the 200 response.',
      content: jsonContent(z.union([readyResponseSchema, readySummarySchema]))
    },
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
      description: 'Project already exists. Repeat the request with upsert=true to replace it intentionally. Also returned when another project already uses the spreadsheet with a different Google credential ref: projects that share a spreadsheet must use the same credential ref.',
      content: jsonContent(errorResponseSchema)
    },
    400: badRequestResponse,
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses
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
      content: cachedReadJsonContent(listRowsResultSchema)
    },
    400: badRequestResponse,
    ...protectedRouteErrorResponses,
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
      content: cachedReadJsonContent(getSchemaResultSchema)
    },
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
      content: cachedReadJsonContent(getRowResultSchema)
    },
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses,
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses
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
    ...protectedRouteErrorResponses,
    404: {
      description: 'The API key does not exist. Project-scoped admin keys get 403 instead for keys outside their project, whether or not the id exists.',
      content: jsonContent(errorResponseSchema)
    }
  }
});

const cachedTableReadPrefixSegments = ['internal', 'cache', 'v1', 'projects'] as const;

type CachedTableReadOperation =
  | { kind: 'listRows'; projectSlug: string; tableSlug: string; query: ListRowsQuery }
  | { kind: 'getRow'; projectSlug: string; tableSlug: string; rowId: string }
  | { kind: 'getSchema'; projectSlug: string; tableSlug: string };

export type CachedTableReadProps = Readonly<{
  resolvedConfig: ResolvedTableConfigSnapshot;
  // The table's data generation when the gateway built the cache key. A read that finds the table at another
  // generation must not be stored, because no later request would look under this key.
  dataGeneration: number;
}>;

function noStoreJsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...headers,
      'cache-control': 'no-store'
    }
  });
}

function applyDefaultGatewayCacheSafetyHeaders(response: Response, preserveCacheControl = false) {
  if (!preserveCacheControl) {
    const cacheControl = response.headers.get('cache-control');
    const hasNoStore = cacheControl?.split(',').some((directive) => directive.trim().toLowerCase() === 'no-store');
    if (!hasNoStore) {
      response.headers.set('cache-control', 'no-store');
    }
  }
  response.headers.delete('cloudflare-cdn-cache-control');
  response.headers.delete('cache-tag');
}

function noStoreErrorResponse(error: unknown) {
  const normalizedError = normalizeRequestError(error);
  const { status, body } = toPublicErrorResponse(normalizedError);
  if (body.error.code === 'INTERNAL_ERROR') {
    // The gateway only sees the generic body, so the cause is logged here.
    console.error(JSON.stringify({
      event: 'cached_table_read.error',
      errorName: normalizedError instanceof Error ? normalizedError.name : 'UnknownError',
      errorMessage: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      errorDetails: normalizedError instanceof AppError ? normalizedError.details ?? null : null,
      errorStack: normalizedError instanceof Error ? normalizedError.stack ?? null : null
    }));
  }
  const retryAfter = isDurableObjectOverloaded(normalizedError)
    ? { 'retry-after': String(durableObjectOverloadRetryAfterSeconds) }
    : {};
  return noStoreJsonResponse(body, status, retryAfter);
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

  const status = getTableCacheStatusResultSchema.safeParse(response.result);
  if (!status.success) {
    throw new ServiceUnavailableError('Unexpected table cache status response.');
  }

  return status.data.data;
}

// An edge entry may live only as long as the table itself would keep serving this data without a resync, which is its
// TTL counted from the last sync and not from the moment the entry is stored. A table that is stale, not ready, or out
// of freshness stores nothing. TableDO reports a pending external change as stale (`external-change`), so nothing is
// stored from a Drive notification until the change has been reindexed.
function getCachedTableReadEdgeTtlSeconds(
  cacheStatus: GetTableCacheStatusResult['data'],
  keyedDataGeneration: number,
  nowMs: number
) {
  if (cacheStatus.cacheTtlSeconds <= 0 || cacheStatus.status !== 'ready' || cacheStatus.stale) {
    return 0;
  }

  // The table moved on while this read ran (a write, a sync, a config change), so the key was built for an earlier
  // generation and no later request would look under it.
  if (cacheStatus.dataGeneration !== keyedDataGeneration || cacheStatus.lastSyncCompletedAt === null) {
    return 0;
  }

  const lastSyncMs = Date.parse(cacheStatus.lastSyncCompletedAt);
  if (Number.isNaN(lastSyncMs)) {
    return 0;
  }

  const remainingSeconds = Math.floor(cacheStatus.cacheTtlSeconds - (nowMs - lastSyncMs) / 1000);
  return Math.min(cacheStatus.cacheTtlSeconds, Math.max(0, remainingSeconds));
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

function cachedTableReadSuccessHeaders(operation: CachedTableReadOperation, edgeTtlSeconds: number) {
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
  props: CachedTableReadProps
) {
  const result = await runCachedTableRead(env, operation, props.resolvedConfig);
  const parsed = parseCachedTableReadResult(operation, result);
  const cacheStatus = await getCachedTableReadCacheStatus(env, operation, props.resolvedConfig);
  return Response.json(parsed, {
    headers: cachedTableReadSuccessHeaders(
      operation,
      getCachedTableReadEdgeTtlSeconds(cacheStatus, props.dataGeneration, Date.now())
    )
  });
}

function parseCachedTableReadResult(operation: CachedTableReadOperation, result: unknown) {
  if (operation.kind === 'listRows') {
    return listRowsResultSchema.parse(result);
  }
  if (operation.kind === 'getRow') {
    return getRowResultSchema.parse(result);
  }
  return getSchemaResultSchema.parse(result);
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

type CachedTableReadFetchOptions = TableReadTarget & {
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
  // A committed change moves the table to a new generation, which makes every older entry unreachable without a purge.
  cacheKey.searchParams.set('__sf_gen', String(options.generation.dataGeneration));

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
      resolvedConfig: options.tableAccess.resolvedConfig,
      dataGeneration: options.generation.dataGeneration
    }
  }).fetch(request, {
    cf: {
      cacheKey
    }
  });
}

function passThroughCachedReadResponse(response: Response) {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    headers.set('cache-control', cacheControl);
  }
  const cacheStatus = response.headers.get('cf-cache-status')?.trim();
  if (cacheStatus) {
    headers.set(cacheStatusHeaderName, cacheStatus);
  }
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    headers.set('retry-after', retryAfter);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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

// Workers Cache accepts at most this many tags in one purge request.
const maxPurgeTagsPerRequest = 100;

export type CachePurgeTarget =
  | { kind: 'project'; projectSlug: string }
  | { kind: 'table'; projectSlug: string; tableSlug: string }
  | { kind: 'row'; projectSlug: string; tableSlug: string; rowId: string };

// The tags the targets cover, once each. A row whose tag cannot be a valid Cache-Tag has no entry stored under it, so
// its table tag alone covers it.
function collectPurgeTags(targets: readonly CachePurgeTarget[]) {
  const tags = new Set<string>();
  for (const target of targets) {
    if (target.kind === 'project') {
      tags.add(getProjectCacheTag(target.projectSlug));
      continue;
    }

    tags.add(getTableCacheTag(target.projectSlug, target.tableSlug));
    if (target.kind === 'row') {
      const rowTag = getRowCacheTag(target.projectSlug, target.tableSlug, target.rowId);
      if (isValidCacheTag(rowTag)) {
        tags.add(rowTag);
      }
    }
  }

  return [...tags];
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
        this.ctx.props
      );
    } catch (error) {
      return noStoreErrorResponse(error);
    }
  }

  // Deletes the edge entries the targets superseded. The gateway calls it over RPC as best-effort cleanup: reads are
  // keyed by the table's data generation, so freshness never depends on a purge. Tags go out in as few purge requests
  // as the limit of 100 tags per request allows.
  async purge(targets: readonly CachePurgeTarget[]): Promise<void> {
    const tags = collectPurgeTags(targets);
    if (tags.length === 0) {
      return;
    }

    const workerCache = this.ctx.cache;
    if (!workerCache) {
      throw new ServiceUnavailableError('Workers Cache purge API is unavailable.');
    }

    for (let start = 0; start < tags.length; start += maxPurgeTagsPerRequest) {
      const result = await workerCache.purge({ tags: tags.slice(start, start + maxPurgeTagsPerRequest) });
      if (!result.success) {
        const failures = result.errors.map(({ code, message }) => `${code}: ${message}`).join('; ');
        const suffix = failures ? `: ${failures}` : '.';
        throw new Error(`Workers Cache purge was unsuccessful${suffix}`);
      }
    }
  }
}

const adminUiHeaders = buildAdminUiHeaders();
const immutableAdminAssetHeaders = buildAdminUiHeaders({ cache: 'immutable' });

type AdminUiStatus = 'enabled' | 'disabled' | 'invalid' | 'assets-missing';

const minimumSecretLength = 32;

// Length only. The note names the binding, never the secret or how many characters short it is.
function weakConfiguredSecret(value: string | undefined) {
  const configured = value?.trim() ?? '';
  return configured.length > 0 && configured.length < minimumSecretLength;
}

function getAdminUiStatus(env: Env): AdminUiStatus {
  const mode = env.ADMIN_UI?.trim() ?? '';
  if (mode === '' || mode === 'disabled') {
    return 'disabled';
  }
  if (mode !== 'enabled') {
    return 'invalid';
  }
  return env.ASSETS ? 'enabled' : 'assets-missing';
}

async function serveAdminUi(c: AppContext): Promise<Response> {
  const status = getAdminUiStatus(c.env);
  if (status === 'disabled') {
    throw new NotFoundError('The admin UI is disabled for this deployment.');
  }
  if (status === 'invalid') {
    throw new ServiceUnavailableError('ADMIN_UI must be "enabled" or "disabled".');
  }
  if (status === 'assets-missing' || !c.env.ASSETS) {
    throw new ServiceUnavailableError('The admin UI is enabled but its assets are not deployed.');
  }

  if (c.req.path === '/admin') {
    return c.redirect('/admin/', 308);
  }

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const response = new Response(assetResponse.body, assetResponse);
  const immutableAsset = shouldCacheAdminAssetImmutably(c.req.path, assetResponse);
  const headers = immutableAsset ? immutableAdminAssetHeaders : adminUiHeaders;
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  if (immutableAsset) {
    c.set('preserveAdminAssetCache', true);
  }
  return response;
}

function isHtmlContentType(contentType: string | null) {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'text/html';
}

function shouldCacheAdminAssetImmutably(path: string, assetResponse: Response) {
  if (assetResponse.status !== 200 && assetResponse.status !== 304) {
    return false;
  }
  if (!path.startsWith('/admin/assets/')) {
    return false;
  }
  return !isHtmlContentType(assetResponse.headers.get('content-type'));
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

    applyDefaultGatewayCacheSafetyHeaders(c.res, c.get('preserveAdminAssetCache') === true);
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

  // Readiness is public, so it sits behind the same per-client limiter as the API.
  app.use('/ready', async (c, next) => {
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
    const { status, body } = toPublicErrorResponse(normalizedError);
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
    const retryAfterSeconds = c.get('retryAfterSeconds')
      ?? (isDurableObjectOverloaded(normalizedError) ? durableObjectOverloadRetryAfterSeconds : undefined);
    if (retryAfterSeconds !== undefined) {
      response.headers.set('retry-after', String(retryAfterSeconds));
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
    // Anonymous callers learn only whether the service is ready. Configuration state needs a global admin credential.
    const auth = await authenticateRequest(c);
    if (auth.kind !== 'anonymous') {
      assertGlobalAdminScope(auth, 'admin:projects');
    }
    await assertControlPlaneReachable(c.env);

    const hasDefaultGoogleCredential = hasConfiguredDefaultGoogleCredential(c.env);
    const namedGoogleCredentials = getNamedGoogleCredentialsStatus(c.env);
    const hasAnyGoogleCredential = hasDefaultGoogleCredential || namedGoogleCredentials === 'configured';
    const status = hasAnyGoogleCredential ? 200 : 503;
    if (auth.kind === 'anonymous') {
      return c.json({ ok: hasAnyGoogleCredential, service: 'sheetflare-api' }, status);
    }

    const hasDriveWebhookSecret = Boolean(c.env.GOOGLE_DRIVE_WEBHOOK_SECRET?.trim());
    const hasBootstrapAdmin = Boolean(c.env.ADMIN_BEARER_TOKEN?.trim());
    const adminUi = getAdminUiStatus(c.env);
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
    } else if (weakConfiguredSecret(c.env.ADMIN_BEARER_TOKEN)) {
      notes.push('ADMIN_BEARER_TOKEN is shorter than 32 characters.');
    }

    if (!hasDriveWebhookSecret) {
      notes.push('GOOGLE_DRIVE_WEBHOOK_SECRET is not configured. Automatic Drive-watch reindexing is unavailable.');
    } else if (weakConfiguredSecret(c.env.GOOGLE_DRIVE_WEBHOOK_SECRET)) {
      notes.push('GOOGLE_DRIVE_WEBHOOK_SECRET is shorter than 32 characters.');
    }

    if (adminUi === 'invalid') {
      notes.push('ADMIN_UI must be "enabled" or "disabled". The hosted admin UI returns 503 until it is fixed.');
    } else if (adminUi === 'assets-missing') {
      notes.push('ADMIN_UI is enabled but the ASSETS binding is missing. Build the admin UI and redeploy.');
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
        bootstrapAdmin: hasBootstrapAdmin ? 'configured' : 'missing',
        adminUi
      },
      notes
    }, status);
  });

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'API key or bootstrap admin token',
    description: [
      'Send `Authorization: Bearer <credential>`; the scheme name is case-insensitive.',
      'Each Worker isolate caches API key verification results for up to 10 seconds, so a revoked key can keep working',
      'for up to 10 seconds on isolates that verified it earlier. The isolate that handles the revoke request stops',
      'accepting the key immediately.'
    ].join(' ')
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

  app.get('/admin', serveAdminUi);
  app.get('/admin/*', serveAdminUi);
  app.get(adminSessionPath, (c) => {
    const body: AdminSessionResponse = { serverCredential: false };
    return c.json(body);
  });

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
      await purgeCachedEntries(c, [{ kind: 'project', projectSlug: result.data.project.slug }]);
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

    // Collected before the delete revokes them. The control plane keeps the rows, but the isolate that handled this
    // request would otherwise keep serving them from its verified-principal cache until that entry expired.
    const projectApiKeyIds = await listProjectApiKeyIds(c, project);
    const response = await doRpc<ProjectDoResponse>(getProjectStub(c.env, project), {
      type: 'project.delete',
      projectSlug: project
    });
    if (response.type !== 'project.delete.result') {
      throw new ServiceUnavailableError('Unexpected project delete response.');
    }
    for (const apiKeyId of projectApiKeyIds) {
      forgetCachedPrincipals(apiKeyId);
    }
    await purgeCachedEntries(c, [{ kind: 'project', projectSlug: project }]);

    return c.json(response.result);
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
      await purgeCachedEntries(c, [{ kind: 'table', projectSlug: project, tableSlug: result.data.tableSlug }]);
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
    await purgeCachedEntries(c, [{ kind: 'table', projectSlug: project, tableSlug: table }]);

    return c.json(result);
  });

  app.openapi(listRowsRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const target = await authorizeTableRead(c, params.project, params.table);
    const query = parseListRowsQuery(c);
    return passThroughCachedReadResponse(await fetchCachedTableRead(
      c,
      `${cachedTableReadBasePath(params.project, params.table)}/rows`,
      { ...target, query }
    ));
  });

  app.openapi(getSchemaRoute, async (c) => {
    const params = parsePathParams(c, adminProjectTableParamsSchema);
    const target = await authorizeTableRead(c, params.project, params.table);
    return passThroughCachedReadResponse(await fetchCachedTableRead(
      c,
      `${cachedTableReadBasePath(params.project, params.table)}/schema`,
      target
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
      await purgeCachedEntries(c, [{ kind: 'table', projectSlug: project, tableSlug: table }]);
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
    await purgeCachedEntries(c, [{ kind: 'table', projectSlug: project, tableSlug: table }]);
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

    await assertWebhookToken(c, webhookToken, providedToken);

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
    const notified = spreadsheetWatchNotifyResultSchema.safeParse(response.result);
    if (!notified.success) {
      throw new ServiceUnavailableError('Unexpected control plane spreadsheet watch notify response.');
    }
    // Only a notification that recorded a new content change can have superseded cached reads. Sync messages and
    // replayed or out-of-order deliveries change nothing, so they cost no purge. The result names the projects on the
    // spreadsheet, which spares the registry scan.
    if (notified.data.changed) {
      await purgeCachedEntries(
        c,
        notified.data.projectSlugs.map((projectSlug): CachePurgeTarget => ({ kind: 'project', projectSlug }))
      );
    }

    return new Response(null, { status: 204 });
  });

  app.openapi(getRowRoute, async (c) => {
    const params = parsePathParams(c, rowParamsSchema);
    const target = await authorizeTableRead(c, params.project, params.table);
    return passThroughCachedReadResponse(await fetchCachedTableRead(
      c,
      `${cachedTableReadBasePath(params.project, params.table)}/rows/${encodeURIComponent(params.id)}`,
      target
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
    await purgeCachedEntries(c, [{ kind: 'table', projectSlug: project, tableSlug: table }]);
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
    await purgeCachedEntries(c, [{ kind: 'row', projectSlug: project, tableSlug: table, rowId: id }]);
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
    await purgeCachedEntries(c, [{ kind: 'row', projectSlug: project, tableSlug: table, rowId: id }]);
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
      throw new ForbiddenError('This key cannot list API keys for another project.');
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
        throw new ForbiddenError('This key can only create API keys for its own project.');
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
        throw new ForbiddenError('This key cannot revoke API keys for another project.');
      }
    }

    await doRpc<ControlPlaneDoResponse>(getControlPlaneStub(c.env), {
      type: 'control.api-key.revoke',
      apiKeyId: id,
      revokedAt: new Date().toISOString()
    });
    forgetCachedPrincipals(id);

    return c.json({ ok: true });
  });

  return app;
}

const app = createApp();

// Isolate-level caches survive between requests, which is the point in production but leaks state between tests.
function resetGatewayStateForTests() {
  recentApiKeyTouches.clear();
  principalCache.clear();
  webhookFailureBlocks.clear();
  readinessProbe = null;
}

function getRecentApiKeyTouchCacheSizeForTests() {
  return recentApiKeyTouches.size;
}

function getPrincipalCacheSizeForTests() {
  return principalCache.size;
}

export {
  ControlPlaneDO,
  ProjectDO,
  TableDO,
  RateLimitDO,
  createApp,
  touchApiKeyIfNeeded as __touchApiKeyIfNeededForTests,
  verifyApiKeyCredential as __verifyApiKeyCredentialForTests,
  resetGatewayStateForTests as __resetGatewayStateForTests,
  getRecentApiKeyTouchCacheSizeForTests as __getRecentApiKeyTouchCacheSizeForTests,
  getPrincipalCacheSizeForTests as __getPrincipalCacheSizeForTests,
  timingSafeEqualSecret as __timingSafeEqualSecretForTests
};
export default app;
