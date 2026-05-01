import { describe, expect, it } from 'vitest';
import { handleAuthenticatedRequest } from './security';

function createBasicAuthorizationHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

describe('handleAuthenticatedRequest', () => {
  it('challenges anonymous requests with a basic-auth response', async () => {
    const response = await handleAuthenticatedRequest({
      env: {
        ADMIN_UI_PASSWORD: 'secret-password',
        ADMIN_UI_USERNAME: 'admin-user'
      },
      next: async () => new Response('ok'),
      request: new Request('https://sheetflare-admin.example.pages.dev/')
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Basic realm="Sheetflare Admin"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
  });

  it('rejects invalid credentials without calling the downstream handler', async () => {
    let nextCalled = false;
    const response = await handleAuthenticatedRequest({
      env: {
        ADMIN_UI_PASSWORD: 'secret-password',
        ADMIN_UI_USERNAME: 'admin-user'
      },
      next: async () => {
        nextCalled = true;
        return new Response('ok');
      },
      request: new Request('https://sheetflare-admin.example.pages.dev/', {
        headers: {
          authorization: createBasicAuthorizationHeader('admin-user', 'wrong-password')
        }
      })
    });

    expect(response.status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('returns a configuration error when the auth gate secrets are missing', async () => {
    const response = await handleAuthenticatedRequest({
      env: {},
      next: async () => new Response('ok'),
      request: new Request('https://sheetflare-admin.example.pages.dev/')
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('Admin UI auth is not configured.');
  });

  it('passes authenticated requests through and adds security headers', async () => {
    const response = await handleAuthenticatedRequest({
      env: {
        ADMIN_UI_PASSWORD: 'secret-password',
        ADMIN_UI_USERNAME: 'admin-user'
      },
      next: async () =>
        new Response('<html><body>Sheetflare Admin</body></html>', {
          headers: {
            'content-type': 'text/html; charset=utf-8'
          }
        }),
      request: new Request('https://sheetflare-admin.example.pages.dev/', {
        headers: {
          authorization: createBasicAuthorizationHeader('admin-user', 'secret-password')
        }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    await expect(response.text()).resolves.toContain('Sheetflare Admin');
  });

  it('relaxes the docs CSP just enough for Scalar to load and initialize', async () => {
    const response = await handleAuthenticatedRequest({
      env: {
        ADMIN_UI_PASSWORD: 'secret-password',
        ADMIN_UI_USERNAME: 'admin-user'
      },
      next: async () =>
        new Response(`<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/doc' });
    </script>
  </body>
</html>`, {
          headers: {
            'content-type': 'text/html; charset=utf-8'
          }
        }),
      request: new Request('https://sheetflare-admin.example.pages.dev/docs', {
        headers: {
          authorization: createBasicAuthorizationHeader('admin-user', 'secret-password')
        }
      })
    });

    const contentSecurityPolicy = response.headers.get('content-security-policy');
    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'");
    expect(contentSecurityPolicy).toContain("style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'");
  });
});
