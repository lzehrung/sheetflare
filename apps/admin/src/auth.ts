import { adminCredentialHeaderName } from '../shared/admin-credential';

export const adminCredentialStorageKey = 'sheetflare.adminCredential';
export { adminCredentialHeaderName };

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function normalizeAdminCredential(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('Bearer ')) {
    const bearerValue = trimmed.slice('Bearer '.length).trim();
    return bearerValue.length > 0 ? bearerValue : null;
  }

  return trimmed;
}

export function readStoredAdminCredential(storage: StorageLike): string | null {
  const value = storage.getItem(adminCredentialStorageKey);
  return value ? normalizeAdminCredential(value) : null;
}

export function canPersistAdminCredential(credential: string | null) {
  return Boolean(credential?.startsWith('sfk_'));
}

export function writeStoredAdminCredential(storage: StorageLike, credential: string | null) {
  if (!credential) {
    storage.removeItem(adminCredentialStorageKey);
    return;
  }

  if (!canPersistAdminCredential(credential)) {
    storage.removeItem(adminCredentialStorageKey);
    return;
  }

  storage.setItem(adminCredentialStorageKey, credential);
}

export function buildAdminHeaders(credential: string | null): HeadersInit | undefined {
  if (!credential) {
    return undefined;
  }

  return {
    [adminCredentialHeaderName]: credential
  };
}
