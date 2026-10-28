export const adminCredentialStorageKey = 'sheetflare.adminCredential';
export const adminRequestHeaderName = 'x-sheetflare-admin-request';
export const adminSessionPath = '/__sheetflare/admin-session';

export type AdminAccess =
  | { source: 'local-server' }
  | { source: 'browser'; credential: string };

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

export function buildAdminHeaders(access: AdminAccess): Record<string, string> {
  if (access.source === 'local-server') {
    return { [adminRequestHeaderName]: '1' };
  }

  return {
    [adminRequestHeaderName]: '1',
    authorization: `Bearer ${access.credential}`
  };
}
