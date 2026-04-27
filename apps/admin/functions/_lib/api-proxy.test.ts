import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminCredentialHeaderName } from '../../src/auth';
import { proxyToApi } from './api-proxy';

describe('proxyToApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the dedicated admin header to a bearer auth header for upstream requests', async () => {
    const fetchMock = vi.fn(async (request: Request) =>
      Response.json({
        authorization: request.headers.get('authorization'),
        leakedBasicAuth: request.headers.get('x-basic-auth-test'),
        proxiedUrl: request.url
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await proxyToApi({
      env: {
        SHEETFLARE_API_BASE_URL: 'https://sheetflare-staging-api.lzehrung.workers.dev'
      },
      request: new Request('https://sheetflare-staging-admin.pages.dev/v1/admin/projects?project=demo', {
        headers: {
          accept: 'application/json',
          [adminCredentialHeaderName]: 'secret-token',
          authorization: `Basic ${btoa('staging-admin:secret-password')}`,
          'x-basic-auth-test': 'should-not-leak'
        }
      })
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwardedRequest = fetchMock.mock.calls[0]?.[0];
    expect(forwardedRequest).toBeInstanceOf(Request);
    expect((forwardedRequest as Request).url).toBe(
      'https://sheetflare-staging-api.lzehrung.workers.dev/v1/admin/projects?project=demo'
    );
    expect((forwardedRequest as Request).headers.get('authorization')).toBe('Bearer secret-token');
    expect((forwardedRequest as Request).headers.get(adminCredentialHeaderName)).toBeNull();
    expect((forwardedRequest as Request).headers.get('x-basic-auth-test')).toBeNull();

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      authorization: 'Bearer secret-token',
      leakedBasicAuth: null,
      proxiedUrl: 'https://sheetflare-staging-api.lzehrung.workers.dev/v1/admin/projects?project=demo'
    });
  });

  it('fails clearly when the Pages project is missing its upstream API configuration', async () => {
    await expect(
      proxyToApi({
        env: {},
        request: new Request('https://sheetflare-staging-admin.pages.dev/v1/admin/projects')
      })
    ).rejects.toThrow('SHEETFLARE_API_BASE_URL is not configured for the admin Pages project.');
  });
});
