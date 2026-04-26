import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptError, getFirstEnv, requestJson, requireAdminCredential } from './runtime';

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

describe('admin credential helpers', () => {
  afterEach(() => {
    delete process.env.SHEETFLARE_ADMIN_CREDENTIAL;
    delete process.env.SHEETFLARE_ADMIN_BEARER;
  });

  it('prefers the generic admin credential env var', () => {
    process.env.SHEETFLARE_ADMIN_CREDENTIAL = 'sfk_admin.secret';
    process.env.SHEETFLARE_ADMIN_BEARER = 'legacy-token';

    expect(requireAdminCredential()).toBe('sfk_admin.secret');
  });

  it('falls back to the legacy bootstrap env var', () => {
    process.env.SHEETFLARE_ADMIN_BEARER = 'legacy-token';

    expect(requireAdminCredential()).toBe('legacy-token');
  });

  it('returns the first configured env var', () => {
    process.env.A = '';
    process.env.B = 'value-b';

    expect(getFirstEnv('A', 'B', 'C')).toBe('value-b');
  });

  it('throws when no admin credential env var exists', () => {
    expect(() => requireAdminCredential()).toThrow(
      'Missing required environment variable SHEETFLARE_ADMIN_CREDENTIAL (or legacy SHEETFLARE_ADMIN_BEARER).'
    );
  });
});
