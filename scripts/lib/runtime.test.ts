import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptError, requestJson } from './runtime';

describe('requestJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes status, request id, and body details when the response status is unexpected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', {
      status: 503,
      headers: {
        'x-request-id': 'req-123'
      }
    })));

    await expect(
      requestJson({
        baseUrl: 'https://example.com',
        path: '/ready',
        expectedStatus: 200
      })
    ).rejects.toThrow(
      'Expected GET /ready to return 200, received 503. requestId=req-123 body=upstream unavailable'
    );
  });

  it('throws a script error when a successful response body is not valid JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', {
      status: 200,
      headers: {
        'content-type': 'text/html'
      }
    })));

    await expect(
      requestJson({
        baseUrl: 'https://example.com',
        path: '/health',
        expectedStatus: 200
      })
    ).rejects.toBeInstanceOf(ScriptError);

    await expect(
      requestJson({
        baseUrl: 'https://example.com',
        path: '/health',
        expectedStatus: 200
      })
    ).rejects.toThrow(
      'Expected GET /health to return JSON, received invalid JSON body: <html>oops</html>'
    );
  });
});
