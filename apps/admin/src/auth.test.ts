import { describe, expect, it } from 'vitest';
import {
  adminRequestHeaderName,
  buildAdminHeaders,
  normalizeAdminCredential
} from './auth';

describe('normalizeAdminCredential', () => {
  it('trims plain credentials', () => {
    expect(normalizeAdminCredential('  sfk_demo.secret  ')).toBe('sfk_demo.secret');
  });

  it('strips a bearer prefix when present', () => {
    expect(normalizeAdminCredential('Bearer secret-token')).toBe('secret-token');
  });

  it('returns null for empty input', () => {
    expect(normalizeAdminCredential('   ')).toBeNull();
  });
});

describe('buildAdminHeaders', () => {
  it('sends the browser credential as bearer authorization with the admin request marker', () => {
    expect(buildAdminHeaders({ source: 'browser', credential: 'secret-token' })).toEqual({
      [adminRequestHeaderName]: '1',
      authorization: 'Bearer secret-token'
    });
  });

  it('sends only the admin request marker when the local server owns the credential', () => {
    expect(buildAdminHeaders({ source: 'local-server' })).toEqual({
      [adminRequestHeaderName]: '1'
    });
  });
});
