// @vitest-environment node

import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite';
import { describe, expect, it } from 'vitest';
import viteConfig from './vite.config';
import { adminCredentialHeaderName } from './src/auth';
import {
  adminResponseHeaders,
  resolveAdminApiTarget,
  rewriteAdminProxyRequest,
  rewriteAdminProxyResponse
} from './vite-proxy';

type ProxyHeaderValue = Parameters<ClientRequest['setHeader']>[1];
const apiProxyRoutes = ['/v1', '/health', '/ready', '/doc', '/docs'];
const configEnv: ConfigEnv = {
  command: 'serve',
  mode: 'test',
  isSsrBuild: false,
  isPreview: false
};

async function evaluateViteConfig(config: UserConfigExport): Promise<UserConfig> {
  if (typeof config === 'function') {
    return config(configEnv);
  }

  return config;
}


function createProxyRequest(initialHeaders: Readonly<Record<string, ProxyHeaderValue>>) {
  const headers = new Map<string, ProxyHeaderValue>(
    Object.entries(initialHeaders).map(([name, value]) => [name.toLowerCase(), value])
  );
  const setHeader: ClientRequest['setHeader'] = function (
    this: ClientRequest,
    name,
    value
  ) {
    headers.set(name.toLowerCase(), value);
    return this;
  };
  const proxyRequest: Pick<ClientRequest, 'setHeader' | 'removeHeader'> = {
    setHeader,
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    }
  };

  return { headers, proxyRequest };
}

function createIncomingRequest(headers: IncomingHttpHeaders): Pick<IncomingMessage, 'headers'> {
  return { headers };
}

describe('Vite config', () => {
  it('uses the target origin for every API proxy route', async () => {
    const config = await evaluateViteConfig(viteConfig);
    const proxy = config.server?.proxy;

    expect(proxy).toBeDefined();
    if (proxy === undefined) {
      throw new TypeError('Expected the Vite dev server proxy configuration');
    }

    expect(Object.keys(proxy).sort()).toEqual([...apiProxyRoutes].sort());
    for (const [route, proxyOptions] of Object.entries(proxy)) {
      if (typeof proxyOptions === 'string') {
        throw new TypeError(`Expected proxy options for ${route}`);
      }

      expect(proxyOptions.changeOrigin, `${route} must change the proxy origin`).toBe(true);
    }
  });
});

describe('resolveAdminApiTarget', () => {
  it('prefers a trimmed environment target over persisted local state', () => {
    expect(
      resolveAdminApiTarget(
        '  https://env-api.example.test  ',
        JSON.stringify({ apiUrl: 'https://state-api.example.test' })
      )
    ).toBe('https://env-api.example.test');
  });

  it('uses persisted local state when the environment target is blank', () => {
    expect(
      resolveAdminApiTarget(
        '  \t ',
        JSON.stringify({ apiUrl: '  https://state-api.example.test/base  ' })
      )
    ).toBe('https://state-api.example.test/base');
  });

  it('uses the local Worker target when neither explicit source supplies a target', () => {
    expect(resolveAdminApiTarget(undefined, null)).toBe('http://127.0.0.1:8787');
  });

  it.each([
    { name: 'malformed JSON', localStateText: '{"apiUrl":' },
    { name: 'JSON null', localStateText: 'null' },
    { name: 'a non-object JSON value', localStateText: '"legacy-state"' },
    { name: 'an object without apiUrl', localStateText: '{}' },
    { name: 'a non-string apiUrl', localStateText: JSON.stringify({ apiUrl: 8787 }) },
    { name: 'a blank apiUrl', localStateText: JSON.stringify({ apiUrl: ' \n\t ' }) }
  ])('tolerates $name in persisted local state by using the local Worker target', ({ localStateText }) => {
    expect(resolveAdminApiTarget(undefined, localStateText)).toBe('http://127.0.0.1:8787');
  });

  it.each([
    { name: 'remote HTTPS with a base path', target: 'https://api.example.test/base' },
    { name: 'localhost HTTP', target: 'http://localhost:8787' },
    { name: 'IPv4 loopback HTTP', target: 'http://127.0.0.1:8787' },
    { name: 'IPv6 loopback HTTP', target: 'http://[::1]:8787' }
  ])('accepts $name targets', ({ target }) => {
    expect(resolveAdminApiTarget(target, null)).toBe(target);
  });

  it.each([
    { name: 'a username', target: 'https://admin@api.example.test' },
    { name: 'a password', target: 'https://:secret@api.example.test' },
    { name: 'a query string', target: 'https://api.example.test?tenant=one' },
    { name: 'a fragment', target: 'https://api.example.test/#admin' }
  ])('rejects a target containing $name from every source', ({ target }) => {
    const expectedMessage = 'credentials, query strings, and fragments are not allowed';

    expect(() => resolveAdminApiTarget(target, null)).toThrow(expectedMessage);
    expect(() => resolveAdminApiTarget(undefined, JSON.stringify({ apiUrl: target }))).toThrow(expectedMessage);
  });

  it.each([
    {
      name: 'a malformed environment target',
      envValue: 'not a URL',
      localStateText: null,
      expectedMessage:
        'Invalid admin API target from SHEETFLARE_API_BASE_URL ("not a URL"): expected an absolute URL. Remote targets require HTTPS because the proxy forwards the admin credential as Bearer.'
    },
    {
      name: 'an insecure remote environment target',
      envValue: 'http://api.example.test',
      localStateText: null,
      expectedMessage:
        'Invalid admin API target from SHEETFLARE_API_BASE_URL ("http://api.example.test"): remote targets require HTTPS because the proxy forwards the admin credential as Bearer.'
    },
    {
      name: 'a malformed persisted target',
      envValue: undefined,
      localStateText: JSON.stringify({ apiUrl: 'not a URL' }),
      expectedMessage:
        'Invalid admin API target from local state apiUrl ("not a URL"): expected an absolute URL. Remote targets require HTTPS because the proxy forwards the admin credential as Bearer.'
    },
    {
      name: 'an insecure remote persisted target',
      envValue: undefined,
      localStateText: JSON.stringify({ apiUrl: 'http://api.example.test' }),
      expectedMessage:
        'Invalid admin API target from local state apiUrl ("http://api.example.test"): remote targets require HTTPS because the proxy forwards the admin credential as Bearer.'
    }
  ])('rejects $name', ({ envValue, localStateText, expectedMessage }) => {
    expect(() => resolveAdminApiTarget(envValue, localStateText)).toThrow(expectedMessage);
  });
});

describe('rewriteAdminProxyRequest', () => {
  it('forwards only required request headers and synthesized bearer authorization', () => {
    const browserHeaders = {
      host: '127.0.0.1:4173',
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': '17',
      'transfer-encoding': 'chunked',
      connection: 'upgrade',
      upgrade: 'websocket',
      forwarded: 'for=attacker;host=attacker.example',
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
      cookie: 'session=browser-secret',
      origin: 'http://127.0.0.1:4173',
      referer: 'http://127.0.0.1:4173/admin',
      'x-arbitrary-client-header': 'untrusted',
      authorization: 'Basic caller-controlled',
      [adminCredentialHeaderName]: 'admin-secret'
    } satisfies IncomingHttpHeaders;
    const { headers, proxyRequest } = createProxyRequest({
      ...browserHeaders,
      host: 'api.example.test'
    });

    rewriteAdminProxyRequest(proxyRequest, createIncomingRequest(browserHeaders));

    expect(Object.fromEntries(headers)).toEqual({
      host: 'api.example.test',
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': '17',
      authorization: 'Bearer admin-secret'
    });
  });

  it.each([
    { name: 'missing', requestHeaders: {} },
    { name: 'empty', requestHeaders: { [adminCredentialHeaderName]: '' } },
    { name: 'an array', requestHeaders: { [adminCredentialHeaderName]: ['first', 'second'] } }
  ] satisfies ReadonlyArray<{ name: string; requestHeaders: IncomingHttpHeaders }>) (
    'removes both sensitive headers when the private credential is $name',
    ({ requestHeaders }) => {
      const { headers, proxyRequest } = createProxyRequest({
        authorization: 'Basic attacker-controlled',
        [adminCredentialHeaderName]: 'attacker-controlled'
      });

      rewriteAdminProxyRequest(proxyRequest, createIncomingRequest(requestHeaders));

      expect(Object.fromEntries(headers)).toEqual({});
    }
  );
});

describe('rewriteAdminProxyResponse', () => {
  it('removes upstream cookies and replaces cache policy with no-store', () => {
    const response = {
      headers: {
        'cache-control': 'public, max-age=3600',
        'set-cookie': ['session=secret; HttpOnly'],
        'x-upstream': 'kept'
      }
    } satisfies Pick<IncomingMessage, 'headers'>;

    rewriteAdminProxyResponse(response);

    expect(response.headers).toEqual({
      'cache-control': 'no-store',
      'x-upstream': 'kept'
    });
  });
});

describe('adminResponseHeaders', () => {
  it('enforces the local admin security-header contract', () => {
    expect(adminResponseHeaders).toEqual({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:4173; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    });
  });
});
