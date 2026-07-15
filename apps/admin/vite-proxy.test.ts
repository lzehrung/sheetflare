// @vitest-environment node

import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { adminCredentialHeaderName } from './src/auth';
import {
  adminResponseHeaders,
  resolveAdminApiTarget,
  rewriteAdminProxyRequest
} from './vite-proxy';

type ProxyHeaderValue = Parameters<ClientRequest['setHeader']>[1];

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
    { name: 'remote HTTPS', target: 'https://api.example.test' },
    { name: 'localhost HTTP', target: 'http://localhost:8787' },
    { name: 'IPv4 loopback HTTP', target: 'http://127.0.0.1:8787' },
    { name: 'IPv6 loopback HTTP', target: 'http://[::1]:8787' }
  ])('accepts $name targets', ({ target }) => {
    expect(resolveAdminApiTarget(target, null)).toBe(target);
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
  it('replaces inbound authorization with a bearer credential and removes the private header', () => {
    const { headers, proxyRequest } = createProxyRequest({
      authorization: 'Basic attacker-controlled',
      [adminCredentialHeaderName]: 'admin-secret'
    });

    rewriteAdminProxyRequest(
      proxyRequest,
      createIncomingRequest({ [adminCredentialHeaderName]: 'admin-secret' })
    );

    expect(Object.fromEntries(headers)).toEqual({ authorization: 'Bearer admin-secret' });
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

describe('adminResponseHeaders', () => {
  it('enforces the local admin security-header contract', () => {
    expect(adminResponseHeaders).toEqual({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    });
  });
});
