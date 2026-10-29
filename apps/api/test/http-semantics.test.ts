import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { projectDoRequestSchema, toErrorResponse } from '@sheetflare/contracts';
import { __resetGatewayStateForTests, createApp } from '../src/index';
import { apiKeys, forgedApiKey, withWrongSecret } from './support/api-keys';
import { createEnv, probesOf } from './support/harness';
import { readJsonLogs } from './support/logs';

const rowsPath = '/v1/projects/demo/tables/users/rows';
const missingTableRowsPath = '/v1/projects/demo/tables/missing/rows';

const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown() })
});

async function readError(response: Response) {
  return errorBodySchema.parse(await response.json()).error;
}

function request(path: string, authorization?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (authorization !== undefined) {
    headers.set('authorization', authorization);
  }
  return { path, init: { ...init, headers } };
}

beforeEach(() => {
  __resetGatewayStateForTests();
});

describe('403 for insufficient scope, 401 only for missing or invalid credentials', () => {
  it.each([
    {
      name: 'a project-scoped admin key on a global admin route',
      call: request('/v1/admin/projects', apiKeys.projectAdmin.authorization)
    },
    {
      name: 'a data key without admin scopes on an admin route',
      call: request('/v1/admin/projects/demo/tables', apiKeys.project.authorization)
    },
    {
      name: 'a read-only key creating a row',
      call: request(rowsPath, apiKeys.touch.authorization, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { name: 'Ada' } })
      })
    },
    {
      name: 'a write-only key reading a private table',
      call: request(rowsPath, apiKeys.writeOnly.authorization)
    },
    {
      name: 'a key scoped to another project reading a table',
      call: request(rowsPath, apiKeys.otherProject.authorization)
    },
    {
      name: 'a key without admin:keys scope listing keys',
      call: request('/v1/admin/keys', apiKeys.project.authorization)
    }
  ])('returns 403 FORBIDDEN for $name', async ({ call }) => {
    const response = await createApp().request(call.path, call.init, createEnv());

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe('FORBIDDEN');
  });

  it.each([
    { name: 'no credentials on an admin route', call: request('/v1/admin/projects'), message: 'Unauthorized' },
    { name: 'no credentials on a private data route', call: request(rowsPath), message: 'Unauthorized' },
    {
      name: 'an unknown key',
      call: request('/v1/admin/projects', forgedApiKey.authorization),
      message: 'Invalid API key.'
    },
    {
      name: 'a real key id with the wrong secret',
      call: request('/v1/admin/projects', `Bearer ${withWrongSecret(apiKeys.globalAdmin)}`),
      message: 'Invalid API key.'
    }
  ])('returns 401 UNAUTHORIZED for $name', async ({ call, message }) => {
    const response = await createApp().request(call.path, call.init, createEnv());

    expect(response.status).toBe(401);
    expect(await readError(response)).toEqual({ code: 'UNAUTHORIZED', message, details: null });
  });

  it('returns 401 for a revoked key', async () => {
    const env = createEnv();
    probesOf(env).revokeApiKey(apiKeys.globalAdmin.id);

    const response = await createApp().request(
      '/v1/admin/projects',
      { headers: { authorization: apiKeys.globalAdmin.authorization } },
      env
    );

    expect(response.status).toBe(401);
  });
});

describe('Authorization header parsing', () => {
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])('accepts the %s scheme for API keys and the bootstrap token', async (scheme) => {
    const app = createApp();

    const withKey = await app.request(
      '/v1/admin/projects',
      { headers: { authorization: `${scheme} ${apiKeys.globalAdmin.credential}` } },
      createEnv()
    );
    const withBootstrap = await app.request(
      '/v1/admin/projects',
      { headers: { authorization: `${scheme} secret` } },
      createEnv()
    );

    expect(withKey.status).toBe(200);
    expect(withBootstrap.status).toBe(200);
  });

  it('tolerates repeated spaces between the scheme and the credential', async () => {
    const response = await createApp().request(
      '/v1/admin/projects',
      { headers: { authorization: 'Bearer    secret' } },
      createEnv()
    );

    expect(response.status).toBe(200);
  });

  it.each([
    { name: 'Basic credentials', authorization: 'Basic c2VjcmV0', message: 'Unsupported authorization scheme.' },
    { name: 'a bare token without a scheme', authorization: 'secret', message: 'Unsupported authorization scheme.' },
    { name: 'a scheme without a credential', authorization: 'Bearer', message: 'Unauthorized' }
  ])('rejects $name with 401', async ({ authorization, message }) => {
    const response = await createApp().request('/v1/admin/projects', { headers: { authorization } }, createEnv());

    expect(response.status).toBe(401);
    expect(await readError(response)).toEqual({ code: 'UNAUTHORIZED', message, details: null });
  });
});

describe('API key format is validated before any Durable Object call', () => {
  const validId = apiKeys.global.id;
  const validSecret = apiKeys.global.secret;

  it.each([
    { name: 'an empty id', credential: `sfk_.${validSecret}` },
    { name: 'an empty secret', credential: `sfk_${validId}.` },
    { name: 'no separator', credential: `sfk_${validId}` },
    { name: 'only the prefix', credential: 'sfk_' },
    { name: 'a short id and secret', credential: 'sfk_.x' },
    { name: 'an id that is not a UUID', credential: `sfk_not-a-uuid.${validSecret}` },
    { name: 'a short secret', credential: `sfk_${validId}.${'a'.repeat(63)}` },
    { name: 'a long secret', credential: `sfk_${validId}.${'a'.repeat(65)}` },
    { name: 'a non-hex secret', credential: `sfk_${validId}.${'g'.repeat(64)}` },
    { name: 'a second separator', credential: `sfk_${validId}.${validSecret}.extra` },
    { name: 'the wrong prefix', credential: `key_${validId}.${validSecret}` },
    { name: 'an uppercase prefix', credential: `SFK_${validId}.${validSecret}` }
  ])('answers $name with a uniform 401 and never calls the control plane', async ({ credential }) => {
    const env = createEnv();

    const response = await createApp().request(
      '/v1/admin/keys',
      { headers: { authorization: `Bearer ${credential}` } },
      env
    );

    expect(response.status).toBe(401);
    expect(await readError(response)).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid API key.', details: null });
    expect(probesOf(env).controlPlaneRequests).toEqual([]);
  });
});

describe('scope is checked before the table is resolved', () => {
  async function read(path: string, authorization: string | undefined, env = createEnv()) {
    const call = request(path, authorization);
    return createApp().request(call.path, call.init, env);
  }

  it('answers a key without read scope identically for existing and missing tables on a private project', async () => {
    const existing = await read(rowsPath, apiKeys.writeOnly.authorization);
    const missing = await read(missingTableRowsPath, apiKeys.writeOnly.authorization);

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(existing.status);
    expect(await readError(missing)).toEqual(await readError(existing));
  });

  it('answers anonymous callers identically for existing tables, missing tables, and missing projects', async () => {
    const existing = await read(rowsPath, undefined);
    const missingTable = await read(missingTableRowsPath, undefined);
    const missingProject = await read('/v1/projects/absent/tables/users/rows', undefined);

    expect(existing.status).toBe(401);
    const expectedError = await readError(existing);
    for (const response of [missingTable, missingProject]) {
      expect(response.status).toBe(401);
      expect(await readError(response)).toEqual(expectedError);
    }
  });

  it('lets callers with read scope learn that a table is missing', async () => {
    const bootstrap = await read(missingTableRowsPath, 'Bearer secret');
    const reader = await read(missingTableRowsPath, apiKeys.project.authorization);

    expect(bootstrap.status).toBe(404);
    expect(reader.status).toBe(404);
  });

  it('lets any caller read a public-read table, including keys without read scope', async () => {
    const anonymous = await read(rowsPath, undefined, createEnv({ defaultAuthMode: 'public-read' }));
    const writeOnly = await read(rowsPath, apiKeys.writeOnly.authorization, createEnv({ defaultAuthMode: 'public-read' }));

    expect(anonymous.status).toBe(200);
    expect(writeOnly.status).toBe(200);
  });
});

describe('Retry-After on rate limit responses', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-26T00:00:30.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the client how many seconds remain until the window resets', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await createApp().request(
        '/v1/admin/projects',
        { headers: { authorization: 'Bearer secret' } },
        createEnv({ rateLimitAllowed: false })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('30');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rounds up to a whole second and never advertises zero', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      vi.setSystemTime(new Date('2026-04-26T00:00:59.200Z'));
      const almostReset = await createApp().request(
        '/v1/admin/projects',
        { headers: { authorization: 'Bearer secret' } },
        createEnv({ rateLimitAllowed: false })
      );
      vi.setSystemTime(new Date('2026-04-26T00:01:00.000Z'));
      const reset = await createApp().request(
        '/v1/admin/projects',
        { headers: { authorization: 'Bearer secret' } },
        createEnv({ rateLimitAllowed: false })
      );

      expect(almostReset.headers.get('retry-after')).toBe('1');
      expect(reset.headers.get('retry-after')).toBe('1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('also covers the per-key limit and is readable by allowed browser origins', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const env = createEnv({
        allowedOrigins: 'https://client.example',
        hooks: {
          rateLimit: ({ name }) =>
            name.includes(':api-key:')
              ? Response.json({ type: 'rate-limit.check.result', result: { allowed: false, remaining: 0, resetAtMs: Date.parse('2026-04-26T00:00:45.000Z') } })
              : undefined
        }
      });

      const response = await createApp().request(
        rowsPath,
        { headers: { authorization: apiKeys.project.authorization, origin: 'https://client.example' } },
        env
      );

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('15');
      expect(response.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('retry-after');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('Durable Object RPC validation failures are internal errors', () => {
  function rpcBoundaryRejection() {
    const parsed = projectDoRequestSchema.safeParse({ type: 'project.table.resolve', projectSlug: 'demo', tableSlug: '' });
    if (parsed.success) {
      throw new Error('Expected the RPC schema to reject the payload.');
    }
    const { status, body } = toErrorResponse(parsed.error);
    return Response.json(body, { status });
  }

  it('returns 500 INTERNAL_ERROR without leaking RPC field errors and logs the details', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await createApp().request(
        rowsPath,
        { headers: { authorization: apiKeys.project.authorization } },
        createEnv({
          hooks: { project: ({ body }) => (body.type === 'project.table.resolve' ? rpcBoundaryRejection() : undefined) }
        })
      );

      expect(response.status).toBe(500);
      expect(await readError(response)).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: null
      });
      expect(readJsonLogs(errorSpy)).toContainEqual(
        expect.objectContaining({
          event: 'request.error',
          errorDetails: expect.objectContaining({ fieldErrors: expect.objectContaining({ tableSlug: expect.any(Array) }) })
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps the gateway own request validation errors as client 400s', async () => {
    // Without a JSON content type the route validator steps aside, so the handler's own schema parse rejects the body.
    const response = await createApp().request(
      rowsPath,
      {
        method: 'POST',
        headers: { authorization: apiKeys.project.authorization },
        body: JSON.stringify({})
      },
      createEnv()
    );

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Request validation failed.');
    expect(error.details).toEqual(expect.objectContaining({ fieldErrors: expect.objectContaining({ values: expect.any(Array) }) }));
  });

  it('keeps documented Durable Object contract errors as client errors', async () => {
    const response = await createApp().request(
      `${rowsPath}?filter=${encodeURIComponent(JSON.stringify({ email: { eq: 'a@example.com' } }))}`,
      { headers: { authorization: apiKeys.project.authorization } },
      createEnv({
        hooks: {
          table: ({ body }) =>
            body.type === 'table.rows.list'
              ? Response.json(
                  { error: { code: 'BAD_REQUEST', message: 'Field "email" is not indexed.', details: { field: 'email' } } },
                  { status: 400 }
                )
              : undefined
        }
      })
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Field "email" is not indexed.',
      details: { field: 'email' }
    });
  });
});

describe('Durable Object overload', () => {
  function overloadedStubError() {
    return Object.assign(new Error('Durable Object is overloaded. Requests queued for too long.'), {
      overloaded: true,
      retryable: true
    });
  }

  const overloadedBody = {
    code: 'SERVICE_UNAVAILABLE',
    message: 'The service is temporarily overloaded. Retry shortly.',
    details: null
  };

  it.each([
    {
      name: 'the control plane',
      path: '/v1/admin/projects',
      authorization: 'Bearer secret',
      createTestEnv: () =>
        createEnv({
          hooks: {
            controlPlane: ({ body }) => {
              if (body.type === 'control.projects.list') {
                throw overloadedStubError();
              }
              return undefined;
            }
          }
        })
    },
    {
      name: 'the rate limiter',
      path: '/v1/admin/projects',
      authorization: 'Bearer secret',
      createTestEnv: () =>
        createEnv({
          hooks: {
            rateLimit: () => {
              throw overloadedStubError();
            }
          }
        })
    },
    {
      name: 'a project object',
      path: rowsPath,
      authorization: apiKeys.project.authorization,
      createTestEnv: () =>
        createEnv({
          hooks: {
            project: ({ body }) => {
              if (body.type === 'project.table.resolve') {
                throw overloadedStubError();
              }
              return undefined;
            }
          }
        })
    },
    {
      name: 'a table object behind the cached read entrypoint',
      path: rowsPath,
      authorization: apiKeys.project.authorization,
      createTestEnv: () =>
        createEnv({
          hooks: {
            table: ({ body }) => {
              if (body.type === 'table.rows.list') {
                throw overloadedStubError();
              }
              return undefined;
            }
          }
        })
    }
  ])('answers 503 with Retry-After when $name is overloaded', async ({ path, authorization, createTestEnv }) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await createApp().request(path, { headers: { authorization } }, createTestEnv());

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('2');
      expect(await readError(response)).toEqual(overloadedBody);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps other stub failures as generic 500s without Retry-After', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await createApp().request(
        '/v1/admin/projects',
        { headers: { authorization: 'Bearer secret' } },
        createEnv({
          hooks: {
            controlPlane: ({ body }) => {
              if (body.type === 'control.projects.list') {
                throw Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true });
              }
              return undefined;
            }
          }
        })
      );

      expect(response.status).toBe(500);
      expect(response.headers.get('retry-after')).toBeNull();
      expect(await readError(response)).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Internal server error.',
        details: null
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('OpenAPI error contract', () => {
  const operationSchema = z.object({
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    responses: z.record(z.string(), z.object({ headers: z.record(z.string(), z.unknown()).optional() }))
  });
  const documentSchema = z.object({ paths: z.record(z.string(), z.record(z.string(), operationSchema)) });

  it('declares 401, 403, and 429 with Retry-After on every operation that takes a bearer credential', async () => {
    const response = await createApp().request('/doc', {}, createEnv());
    const document = documentSchema.parse(await response.json());

    const protectedOperations = Object.entries(document.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, operation]) => operation.security?.some((requirement) => 'bearerAuth' in requirement))
        .map(([method, operation]) => ({ label: `${method.toUpperCase()} ${path}`, operation }))
    );

    expect(protectedOperations.length).toBeGreaterThan(10);
    for (const { label, operation } of protectedOperations) {
      expect(Object.keys(operation.responses), label).toEqual(expect.arrayContaining(['401', '403', '429']));
      expect(Object.keys(operation.responses['429']?.headers ?? {}), label).toContain('Retry-After');
    }
  });
});
