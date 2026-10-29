import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { __resetRecentApiKeyTouchesForTests, createApp } from '../src/index';
import { apiKeys } from './support/api-keys';
import { createEnv, probesOf } from './support/harness';
import { readJsonLogs } from './support/logs';

const rowsPath = '/v1/projects/demo/tables/users/rows';

function countTouchAttempts(env: Env) {
  return probesOf(env).controlPlaneRequests.filter((request) => request.type === 'control.api-key.touch').length;
}

function touchUnavailableResponse() {
  return Response.json(
    { error: { code: 'SERVICE_UNAVAILABLE', message: 'Control plane unavailable.', details: null } },
    { status: 503 }
  );
}

describe('api key last-used touch', () => {
  beforeEach(() => {
    __resetRecentApiKeyTouchesForTests();
  });

  it.each([
    { name: 'a Durable Object error response', fail: touchUnavailableResponse },
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
      const response = await createApp().request(
        rowsPath,
        { headers: { authorization: apiKeys.touch.authorization } },
        env
      );

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
            return touchUnavailableResponse();
          }
        }
      });
      const app = createApp();
      const read = () => app.request(rowsPath, { headers: { authorization: apiKeys.touch.authorization } }, env);

      expect((await read()).status).toBe(200);
      expect(countTouchAttempts(env)).toBe(1);

      // The failed attempt must not have started the five minute throttle.
      expect((await read()).status).toBe(200);
      expect(countTouchAttempts(env)).toBe(2);

      // The successful attempt does.
      expect((await read()).status).toBe(200);
      expect(countTouchAttempts(env)).toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
