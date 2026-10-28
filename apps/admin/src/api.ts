import type {
  AdminListApiKeysResult,
  AdminCreateApiKeyResult,
  AdminGetProjectResult,
  AdminInspectSpreadsheetTabResult,
  AdminListProjectsResult,
  AdminListSpreadsheetWatchesResult,
  AdminListSpreadsheetTabsResult,
  ApiKeyPrincipal,
  CreateProjectInput,
  CreateTableInput,
  DeleteProjectResult,
  DeleteTableResult,
  GetTableCacheStatusResult,
  RefreshTableCacheResult,
  ReindexTableResult
} from '@sheetflare/contracts';
import { adminSessionPath, type AdminSessionResponse } from '@sheetflare/contracts';
import { buildAdminHeaders, type AdminAccess } from './auth';

type ApiErrorResponse = {
  error?: {
    message?: string;
  };
};

function summarizeBody(text: string) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}

function parseJsonResponse(text: string) {
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function getApiErrorMessage(parsed: ApiErrorResponse | unknown) {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) {
    return null;
  }

  const error = parsed.error;
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') {
    return null;
  }

  return error.message;
}

function formatRequestError(response: Response, parsed: ApiErrorResponse | unknown, text: string) {
  const requestId = response.headers.get('x-request-id');
  const errorMessage = getApiErrorMessage(parsed);
  const parts = [
    errorMessage ?? `Request failed: ${response.status}`,
    requestId ? `requestId=${requestId}` : null
  ];

  if (!errorMessage && text.trim().length > 0) {
    parts.push(`body=${summarizeBody(text)}`);
  }

  return parts.filter(Boolean).join(' ');
}

async function requestAdminJson<T>(
  access: AdminAccess,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = {
    ...buildAdminHeaders(access),
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
  };
  const response = await fetch(path, {
    ...init,
    headers
  });

  const text = await response.text();
  const parsed = parseJsonResponse(text);

  if (!response.ok) {
    if (response.status === 401 && getApiErrorMessage(parsed) === null) {
      throw new Error('The configured admin credential was rejected.');
    }

    throw new Error(formatRequestError(response, parsed, text));
  }

  if (parsed === null) {
    const requestId = response.headers.get('x-request-id');
    throw new Error(
      [
        'Request returned an invalid JSON response.',
        requestId ? `requestId=${requestId}` : null,
        text.trim().length > 0 ? `body=${summarizeBody(text)}` : null
      ].filter(Boolean).join(' ')
    );
  }

  return parsed as T;
}

export async function getAdminSession(): Promise<AdminSessionResponse> {
  const response = await fetch(adminSessionPath, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Local admin session lookup failed: ${response.status}`);
  }

  const parsed = parseJsonResponse(await response.text());
  if (
    !parsed
    || typeof parsed !== 'object'
    || !('serverCredential' in parsed)
    || typeof parsed.serverCredential !== 'boolean'
  ) {
    throw new Error('Local admin session lookup returned an invalid response.');
  }

  return { serverCredential: parsed.serverCredential };
}

export function listProjects(access: AdminAccess) {
  return requestAdminJson<AdminListProjectsResult>(access, '/v1/admin/projects');
}

export function getProject(access: AdminAccess, projectSlug: string) {
  return requestAdminJson<AdminGetProjectResult>(
    access,
    `/v1/admin/projects?project=${encodeURIComponent(projectSlug)}`
  );
}

export function createProject(access: AdminAccess, input: CreateProjectInput) {
  return requestAdminJson<AdminGetProjectResult>(access, '/v1/admin/projects', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function deleteProject(access: AdminAccess, projectSlug: string) {
  return requestAdminJson<DeleteProjectResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}`,
    {
      method: 'DELETE'
    }
  );
}

export function listSpreadsheetTabs(access: AdminAccess, projectSlug: string) {
  return requestAdminJson<AdminListSpreadsheetTabsResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/spreadsheet/tabs`
  );
}

export function listSpreadsheetWatches(access: AdminAccess) {
  return requestAdminJson<AdminListSpreadsheetWatchesResult>(
    access,
    '/v1/admin/system/google/drive/watches'
  );
}

export function inspectSpreadsheetTab(
  access: AdminAccess,
  projectSlug: string,
  tabName: string,
  headerRow?: number
) {
  const query = headerRow !== undefined ? `?headerRow=${encodeURIComponent(String(headerRow))}` : '';
  return requestAdminJson<AdminInspectSpreadsheetTabResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/spreadsheet/tabs/${encodeURIComponent(tabName)}${query}`
  );
}

export function createTable(access: AdminAccess, projectSlug: string, input: CreateTableInput) {
  return requestAdminJson<{ data: CreateTableInput & { projectSlug: string } }>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  );
}

export function deleteTable(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson<DeleteTableResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}`,
    {
      method: 'DELETE'
    }
  );
}

export function createApiKey(
  access: AdminAccess,
  input: {
    name: string;
    projectSlug?: string | null;
    scopes: string[];
  }
) {
  return requestAdminJson<AdminCreateApiKeyResult>(access, '/v1/admin/keys', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function listApiKeys(access: AdminAccess, projectSlug?: string | null) {
  const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : '';
  return requestAdminJson<AdminListApiKeysResult>(
    access,
    `/v1/admin/keys${query}`
  );
}

export function revokeApiKey(access: AdminAccess, apiKeyId: ApiKeyPrincipal['id']) {
  return requestAdminJson<{ ok: true }>(
    access,
    `/v1/admin/keys/${encodeURIComponent(apiKeyId)}`,
    {
      method: 'DELETE'
    }
  );
}

export function getCacheStatus(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson<GetTableCacheStatusResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/cache`
  );
}

export function refreshTableCache(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson<RefreshTableCacheResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/refresh`,
    {
      method: 'POST'
    }
  );
}

export function reindexTable(access: AdminAccess, projectSlug: string, tableSlug: string) {
  return requestAdminJson<ReindexTableResult>(
    access,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/reindex`,
    {
      method: 'POST'
    }
  );
}
