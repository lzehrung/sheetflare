export const adminCredentialStorageKey = 'sheetflare.adminCredential';
export const adminCredentialHeaderName = 'x-sheetflare-admin-credential';

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

export function buildAdminHeaders(credential: string | null): HeadersInit | undefined {
  if (!credential) {
    return undefined;
  }

  return {
    [adminCredentialHeaderName]: credential
  };
}
