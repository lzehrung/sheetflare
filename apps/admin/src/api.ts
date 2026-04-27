import type {
  AdminListApiKeysResult,
  AdminCreateApiKeyResult,
  AdminGetProjectResult,
  AdminListProjectsResult,
  ApiKeyPrincipal,
  CreateProjectInput,
  CreateTableInput,
  GetTableCacheStatusResult,
  ReindexTableResult
} from '@sheetflare/contracts';
import { buildAdminHeaders } from './auth';

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
    return JSON.parse(text) as ApiErrorResponse | unknown;
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
  credential: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = {
    ...buildAdminHeaders(credential),
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {})
  };
  const response = await fetch(path, {
    ...init,
    headers
  });

  if (response.status === 401) {
    throw new Error('The configured admin credential was rejected.');
  }

  const text = await response.text();
  const parsed = parseJsonResponse(text);

  if (!response.ok) {
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

export function listProjects(credential: string) {
  return requestAdminJson<AdminListProjectsResult>(credential, '/v1/admin/projects');
}

export function getProject(credential: string, projectSlug: string) {
  return requestAdminJson<AdminGetProjectResult>(
    credential,
    `/v1/admin/projects?project=${encodeURIComponent(projectSlug)}`
  );
}

export function createProject(credential: string, input: CreateProjectInput) {
  return requestAdminJson<AdminGetProjectResult>(credential, '/v1/admin/projects', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function createTable(credential: string, projectSlug: string, input: CreateTableInput) {
  return requestAdminJson<{ data: CreateTableInput & { projectSlug: string } }>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables`,
    {
      method: 'POST',
      body: JSON.stringify(input)
    }
  );
}

export function createApiKey(
  credential: string,
  input: {
    name: string;
    projectSlug?: string | null;
    scopes: string[];
  }
) {
  return requestAdminJson<AdminCreateApiKeyResult>(credential, '/v1/admin/keys', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function listApiKeys(credential: string, projectSlug?: string | null) {
  const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : '';
  return requestAdminJson<AdminListApiKeysResult>(
    credential,
    `/v1/admin/keys${query}`
  );
}

export function revokeApiKey(credential: string, apiKeyId: ApiKeyPrincipal['id']) {
  return requestAdminJson<{ ok: true }>(
    credential,
    `/v1/admin/keys/${encodeURIComponent(apiKeyId)}`,
    {
      method: 'DELETE'
    }
  );
}

export function getCacheStatus(credential: string, projectSlug: string, tableSlug: string) {
  return requestAdminJson<GetTableCacheStatusResult>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/cache`
  );
}

export function reindexTable(credential: string, projectSlug: string, tableSlug: string) {
  return requestAdminJson<ReindexTableResult>(
    credential,
    `/v1/admin/projects/${encodeURIComponent(projectSlug)}/tables/${encodeURIComponent(tableSlug)}/reindex`,
    {
      method: 'POST'
    }
  );
}
