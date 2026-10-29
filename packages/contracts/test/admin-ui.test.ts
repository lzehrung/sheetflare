import { describe, expect, it } from 'vitest';
import { buildAdminUiHeaders } from '../src/admin-ui';

describe('buildAdminUiHeaders', () => {
  it('restricts hosted admin connections to its own origin', () => {
    expect(buildAdminUiHeaders()).toEqual({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    });
  });

  it('adds only the hot-reload origin for local development', () => {
    const hosted = buildAdminUiHeaders();
    const local = buildAdminUiHeaders({ hotReloadOrigin: 'ws://127.0.0.1:4173' });

    expect(local['Content-Security-Policy']).toBe(
      hosted['Content-Security-Policy'].replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:4173")
    );
    expect({ ...local, 'Content-Security-Policy': '' }).toEqual({ ...hosted, 'Content-Security-Policy': '' });
  });
});
