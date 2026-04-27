import { describe, expect, it } from 'vitest';
import {
  adminCredentialHeaderName,
  adminCredentialStorageKey,
  buildAdminHeaders,
  normalizeAdminCredential,
  readStoredAdminCredential,
  writeStoredAdminCredential,
  type StorageLike
} from './auth';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

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

describe('stored admin credential helpers', () => {
  it('persists and reloads normalized credentials', () => {
    const storage = new MemoryStorage();
    writeStoredAdminCredential(storage, 'secret-token');

    expect(storage.getItem(adminCredentialStorageKey)).toBe('secret-token');
    expect(readStoredAdminCredential(storage)).toBe('secret-token');
  });

  it('removes stored credentials when cleared', () => {
    const storage = new MemoryStorage();
    writeStoredAdminCredential(storage, 'secret-token');
    writeStoredAdminCredential(storage, null);

    expect(readStoredAdminCredential(storage)).toBeNull();
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
