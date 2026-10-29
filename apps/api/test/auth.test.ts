import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import {
  __getPrincipalCacheSizeForTests,
  __resetGatewayStateForTests,
  __verifyApiKeyCredentialForTests,
  createApp
} from '../src/index';
import { apiKeys, forgedApiKey, withWrongSecret } from './support/api-keys';
import { createEnv, probesOf } from './support/harness';
import { readJsonLogs } from './support/logs';

const rowsPath = '/v1/projects/demo/tables/users/rows';

function readAs(env: Env, credential: string, path = rowsPath) {
  return createApp().request(path, { headers: { authorization: `Bearer ${credential}` } }, env);
}

function countControlPlaneCalls(env: Env, type: string) {
  return probesOf(env).controlPlaneRequests.filter((request) => request.type === type).length;
}

function controlPlaneUnavailableResponse() {
  return Response.json(
    { error: { code: 'SERVICE_UNAVAILABLE', message: 'Control plane unavailable.', details: null } },
    { status: 503 }
  );
}

describe('api key last-used touch', () => {
  beforeEach(() => {
    __resetGatewayStateForTests();
  });

  it.each([
    { name: 'a Durable Object error response', fail: controlPlaneUnavailableResponse },
    {
      name: 'a failed stub call',
      fail: () => {
        throw new Error('connect ECONNRESET');
      }
    }
  ])('serves the request and logs when the last-used touch fails with $name', async ({ fail }) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const env = createEnv({
        hooks: { controlPlane: ({ body }) => (body.type === 'control.api-key.touch' ? fail() : undefined) }
      });
      const response = await readAs(env, apiKeys.touch.credential);

      expect(response.status).toBe(200);
      expect(readJsonLogs(errorSpy)).toContainEqual(
        expect.objectContaining({
          event: 'api_key.touch.failed',
          apiKeyId: apiKeys.touch.id,
          requestId: response.headers.get('x-request-id')
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('retries a failed touch on the next request and throttles only after a success', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      let failuresLeft = 1;
      const env = createEnv({
        hooks: {
          controlPlane: ({ body }) => {
            if (body.type !== 'control.api-key.touch' || failuresLeft === 0) {
              return undefined;
            }
            failuresLeft -= 1;
            return controlPlaneUnavailableResponse();
          }
        }
      });

      expect((await readAs(env, apiKeys.touch.credential)).status).toBe(200);
      expect(countControlPlaneCalls(env, 'control.api-key.touch')).toBe(1);

      // The failed attempt must not have started the five minute throttle.
      expect((await readAs(env, apiKeys.touch.credential)).status).toBe(200);
      expect(countControlPlaneCalls(env, 'control.api-key.touch')).toBe(2);

      // The successful attempt does.
      expect((await readAs(env, apiKeys.touch.credential)).status).toBe(200);
      expect(countControlPlaneCalls(env, 'control.api-key.touch')).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('verified principal cache', () => {
  const startedAt = Date.parse('2026-04-26T00:00:00.000Z');

  beforeEach(() => {
    __resetGatewayStateForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(startedAt);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a key with the control plane once and serves repeat requests from memory', async () => {
    const env = createEnv();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);
    }

    expect(probesOf(env).verifyApiKeyCallCount).toBe(1);
  });

  it('still charges the per-key rate limit on every cached request', async () => {
    const env = createEnv();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await readAs(env, apiKeys.project.credential);
    }

    const keyChecks = probesOf(env).rateLimitRequests.filter((request) => request.name.includes(':api-key:'));
    expect(keyChecks).toHaveLength(3);
  });

  it('remembers rejected credentials too', async () => {
    const env = createEnv();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await readAs(env, forgedApiKey.credential)).status).toBe(401);
    }

    expect(probesOf(env).verifyApiKeyCallCount).toBe(1);
  });

  it('does not let a verified entry vouch for the same key id with a different secret', async () => {
    const env = createEnv();

    expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);
    expect((await readAs(env, withWrongSecret(apiKeys.project))).status).toBe(401);
    expect(probesOf(env).verifyApiKeyCallCount).toBe(2);

    expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);
    expect(probesOf(env).verifyApiKeyCallCount).toBe(2);
  });

  it('verifies again once the ten second lifetime has passed', async () => {
    const env = createEnv();

    await readAs(env, apiKeys.project.credential);
    vi.setSystemTime(startedAt + 9_900);
    await readAs(env, apiKeys.project.credential);
    expect(probesOf(env).verifyApiKeyCallCount).toBe(1);

    vi.setSystemTime(startedAt + 10_100);
    await readAs(env, apiKeys.project.credential);
    expect(probesOf(env).verifyApiKeyCallCount).toBe(2);
  });

  it('lets a revoked key keep working for at most the cache lifetime', async () => {
    const env = createEnv();

    expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);
    probesOf(env).revokeApiKey(apiKeys.project.id);

    // Documented revocation lag: isolates that already verified the key accept it until their entry expires.
    vi.setSystemTime(startedAt + 5_000);
    expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);

    vi.setSystemTime(startedAt + 10_100);
    expect((await readAs(env, apiKeys.project.credential)).status).toBe(401);
  });

  it('stops accepting a key immediately on the isolate that revokes it', async () => {
    const env = createEnv();

    expect((await readAs(env, apiKeys.globalAdmin.credential, '/v1/admin/keys')).status).toBe(200);
    const revoked = await createApp().request(
      `/v1/admin/keys/${apiKeys.globalAdmin.id}`,
      { method: 'DELETE', headers: { authorization: 'Bearer secret' } },
      env
    );
    expect(revoked.status).toBe(200);

    expect((await readAs(env, apiKeys.globalAdmin.credential, '/v1/admin/keys')).status).toBe(401);
  });

  it('does not cache control plane failures as rejections', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      let failuresLeft = 1;
      const env = createEnv({
        hooks: {
          controlPlane: ({ body }) => {
            if (body.type !== 'control.api-key.verify' || failuresLeft === 0) {
              return undefined;
            }
            failuresLeft -= 1;
            return controlPlaneUnavailableResponse();
          }
        }
      });

      expect((await readAs(env, apiKeys.project.credential)).status).toBe(503);
      expect((await readAs(env, apiKeys.project.credential)).status).toBe(200);
      expect(probesOf(env).verifyApiKeyCallCount).toBe(1);
      expect(countControlPlaneCalls(env, 'control.api-key.verify')).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stays bounded when a flood of distinct credentials arrives', async () => {
    const env = createEnv();

    for (let index = 0; index <= 10_000; index += 1) {
      await __verifyApiKeyCredentialForTests(env, `sfk_${crypto.randomUUID()}.${'a'.repeat(64)}`);
    }

    expect(__getPrincipalCacheSizeForTests()).toBeLessThanOrEqual(10_000);
  });
});

describe('table read round trips', () => {
  beforeEach(() => {
    __resetGatewayStateForTests();
  });

  it('resolves the table once for anonymous reads of a public-read project', async () => {
    const env = createEnv({ defaultAuthMode: 'public-read' });

    const response = await createApp().request(rowsPath, {}, env);

    expect(response.status).toBe(200);
    expect(probesOf(env).projectRequests).toEqual(['project.table.resolve']);
  });

  it('uses the same single project call whether or not a private table exists', async () => {
    const existingEnv = createEnv();
    const missingEnv = createEnv();

    const existing = await createApp().request(rowsPath, {}, existingEnv);
    const missing = await createApp().request('/v1/projects/demo/tables/missing/rows', {}, missingEnv);

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(probesOf(existingEnv).projectRequests).toEqual(['project.table.resolve']);
    expect(probesOf(missingEnv).projectRequests).toEqual(['project.table.resolve']);
  });

  it('does not reveal whether a table exists in a public-read project to callers who may not read it', async () => {
    const env = createEnv({ defaultAuthMode: 'public-read' });

    const response = await createApp().request('/v1/projects/demo/tables/missing/rows', {}, env);

    // Without read access the gateway cannot tell a missing table from a private one, so both are denied alike.
    expect(response.status).toBe(401);
  });

  it('resolves the table while the per-key rate limit check is still in flight', async () => {
    const events: string[] = [];
    const env = createEnv({
      hooks: {
        rateLimit: async ({ name }) => {
          if (!name.includes(':api-key:')) {
            return undefined;
          }
          events.push('key-limit:start');
          // Stay in flight across a few event loop turns: a concurrent table resolution begins within them, a
          // sequential one cannot.
          for (let turn = 0; turn < 5; turn += 1) {
            await nextEventLoopTurn();
          }
          events.push('key-limit:end');
          return undefined;
        },
        project: ({ body }) => {
          if (body.type === 'project.table.resolve') {
            events.push('resolve:start');
          }
          return undefined;
        }
      }
    });

    const response = await readAs(env, apiKeys.project.credential);

    expect(response.status).toBe(200);
    // The two calls overlap: the table lookup begins before the key's rate limit check has finished.
    expect(events).toEqual(expect.arrayContaining(['key-limit:start', 'resolve:start', 'key-limit:end']));
    expect(events.indexOf('resolve:start')).toBeLessThan(events.indexOf('key-limit:end'));
  });
});
