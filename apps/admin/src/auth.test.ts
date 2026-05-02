import { describe, expect, it } from 'vitest';
import {
  adminCredentialHeaderName,
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
  it('builds the dedicated proxy credential header when a credential exists', () => {
    expect(buildAdminHeaders('secret-token')).toEqual({
      [adminCredentialHeaderName]: 'secret-token'
    });
  });

  it('returns undefined when no credential is configured', () => {
    expect(buildAdminHeaders(null)).toBeUndefined();
  });
});
